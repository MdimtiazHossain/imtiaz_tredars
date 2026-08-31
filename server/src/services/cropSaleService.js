import { num } from '../lib/db.js';
import { nextDocumentNo } from '../lib/numbering.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { recordMovement, reverseMovements } from './inventoryService.js';
import {
  createReceivable,
  writeLedger,
  addDays,
  ledgerAccount,
  writeLedgerPair,
  LEDGER,
  reverseLedgerFor,
} from './financeService.js';
import { evaluateRules, requestApproval } from './approvalService.js';
import { lockBatchPool, planAllocation, consumeAllocation, restoreAllocation } from './fifoService.js';

/**
 * Bulk crop sale.
 *
 * Stock is issued from batches oldest-first, and each batch carries its own
 * landed cost, so cost of goods sold is the actual cost of the specific stock
 * that left the godown rather than an average. The batch pool is locked before
 * any quantity is read, which is what makes two simultaneous sales safe.
 */

async function validateReferences(client, orgId, input) {
  const buyer = await client.query(
    `SELECT id, name, credit_days FROM companies
      WHERE id = $1 AND org_id = $2 AND is_active
        AND role IN ('BUYER', 'SUPPLIER_AND_BUYER')`,
    [input.buyerCompanyId, orgId]
  );
  if (!buyer.rows.length) {
    throw badRequest('INVALID_BUYER', 'Select a valid buyer company.');
  }

  for (const line of input.lines) {
    if (!(num(line.quantity) > 0)) {
      throw unprocessable('INVALID_QUANTITY', 'Quantity must be greater than zero.');
    }
    if (num(line.rate) < 0) {
      throw unprocessable('INVALID_RATE', 'Rate cannot be negative.');
    }
  }

  return buyer.rows[0];
}

/**
 * Preview an allocation without writing anything. Used by the sales screen to
 * show the batch split and expected profit before the user posts.
 */
export async function previewAllocation(client, { orgId, cropId, warehouseId, quantity, rate, valuationMethod, transportCost, otherCost }) {
  const pool = await lockBatchPool(client, { orgId, cropId, warehouseId });
  const plan = planAllocation(pool, num(quantity), valuationMethod);

  const salesValue = plan.allocated * num(rate);
  const expenses = num(transportCost) + num(otherCost);
  const profit = salesValue - plan.cogs - expenses;

  return {
    pool: pool.map((b) => ({
      batchId: b.id,
      batchNo: b.batchNo,
      warehouseId: b.warehouseId,
      receivedOn: b.receivedOn,
      quantityRemaining: b.quantityRemaining,
      costPerUnit: b.costPerUnit,
    })),
    allocations: plan.lines,
    allocated: plan.allocated,
    shortfall: plan.shortfall,
    cogs: plan.cogs,
    averageCost: plan.averageCost,
    salesValue,
    expenses,
    profit,
    perUnitProfit: plan.allocated ? profit / plan.allocated : 0,
    marginPct: salesValue ? (profit / salesValue) * 100 : 0,
  };
}

/**
 * Refuse a sale the godown cannot fulfil, before it is accepted at all.
 *
 * `postCropSale` checks this too, but a sale routed for approval does not reach
 * it until an approver has already signed off — by which point the shortfall is
 * somebody else's problem. Quantities are summed per crop first: two lines for
 * the same crop draw on one pool, and planning them separately would each see
 * the full quantity and miss a combined shortfall.
 */
async function assertStockAvailable(client, { orgId, warehouseId, valuationMethod, lines }) {
  const wanted = new Map();
  for (const line of lines) {
    const cropId = Number(line.cropId);
    wanted.set(cropId, (wanted.get(cropId) || 0) + num(line.quantity));
  }

  for (const [cropId, quantity] of wanted) {
    const pool = await lockBatchPool(client, { orgId, cropId, warehouseId });
    const plan = planAllocation(pool, quantity, valuationMethod);
    if (plan.shortfall > 0) {
      throw unprocessable(
        'INSUFFICIENT_STOCK',
        `Only ${plan.allocated} available for this crop, but ${quantity} was requested.`
      );
    }
  }
}

/**
 * Create a bulk crop sale, optionally posting it.
 *
 * Posting performs, atomically: validate the buyer, lock and allocate batches
 * FIFO, compute cost and profit, write a stock movement per batch consumed,
 * raise the receivable, write the journal rows and record the audit entry.
 */
export async function createCropSale(client, { orgId, user, actor, input }) {
  const buyer = await validateReferences(client, orgId, input);

  const txnNo = input.txnNo || (await nextDocumentNo(client, orgId, 'crop_sale', input.txnDate));
  const valuation = input.valuationMethod === 'WEIGHTED_AVERAGE' ? 'WEIGHTED_AVERAGE' : 'FIFO';

  const grossAmount = input.lines.reduce((t, l) => t + num(l.quantity) * num(l.rate), 0);

  const { rows } = await client.query(
    `INSERT INTO crop_sales
       (org_id, txn_no, txn_date, business_type, buyer_company_id, warehouse_id,
        valuation_method, transport_cost, other_cost, gross_amount, net_amount,
        paid_amount, status, created_by)
     VALUES ($1,$2,$3,'BULK_CROP',$4,$5,$6,$7,$8,$9,$9,$10,'DRAFT',$11)
     RETURNING id`,
    [
      orgId,
      txnNo,
      input.txnDate,
      input.buyerCompanyId,
      input.warehouseId ?? null,
      valuation,
      num(input.transportCost),
      num(input.otherCost),
      grossAmount,
      num(input.paidAmount),
      user.id,
    ]
  );

  const saleId = Number(rows[0].id);

  let lineNo = 0;
  const items = [];
  for (const line of input.lines) {
    lineNo += 1;
    const lineValue = num(line.quantity) * num(line.rate);
    const { rows: item } = await client.query(
      `INSERT INTO crop_sale_items (sale_id, line_no, crop_id, unit_id, quantity, rate, line_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [saleId, lineNo, line.cropId, line.unitId, num(line.quantity), num(line.rate), lineValue]
    );
    items.push({ id: Number(item[0].id), line, lineValue });
  }

  await writeAudit(client, {
    actor,
    entityType: 'crop_sales',
    entityId: saleId,
    action: 'CREATE',
    newValue: { txnNo, buyer: buyer.name, grossAmount },
    summary: `Crop sale ${txnNo} created for ${buyer.name}`,
  });

  if (input.action !== 'POST') {
    return { id: saleId, txnNo, status: 'DRAFT' };
  }

  await assertStockAvailable(client, {
    orgId,
    warehouseId: input.warehouseId ?? undefined,
    valuationMethod: valuation,
    lines: input.lines,
  });

  const rule = await evaluateRules(client, {
    orgId,
    entityType: 'crop_sales',
    businessType: 'BULK_CROP',
    amount: grossAmount,
  });

  if (rule) {
    const approval = await requestApproval(client, {
      orgId,
      entityType: 'crop_sales',
      entityId: saleId,
      businessType: 'BULK_CROP',
      ruleId: rule.id,
      referenceNo: txnNo,
      partyName: buyer.name,
      amount: grossAmount,
      reason: rule.reason,
      date: input.txnDate,
      userId: user.id,
      actor,
    });
    return { id: saleId, txnNo, status: 'PENDING_APPROVAL', approval };
  }

  const posted = await postCropSale(client, { orgId, user, actor, saleId, buyer });
  return { id: saleId, txnNo, status: 'POSTED', ...posted };
}

/** Post an existing crop sale: allocate FIFO, move stock, raise the receivable. */
export async function postCropSale(client, { orgId, user, actor, saleId, buyer }) {
  const { rows: headerRows } = await client.query(
    'SELECT * FROM crop_sales WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [saleId, orgId]
  );
  if (!headerRows.length) throw notFound('Crop sale');
  const header = headerRows[0];

  if (header.status === 'POSTED') {
    throw unprocessable('ALREADY_POSTED', 'This sale has already been posted.');
  }
  if (header.status === 'CANCELLED') {
    throw unprocessable('ALREADY_CANCELLED', 'This sale was cancelled and cannot be posted.');
  }

  const { rows: itemRows } = await client.query(
    'SELECT id, crop_id, quantity, rate, line_value FROM crop_sale_items WHERE sale_id = $1 ORDER BY line_no',
    [saleId]
  );

  const buyerName =
    buyer?.name ||
    (await client.query('SELECT name FROM companies WHERE id = $1', [header.buyer_company_id]))
      .rows[0]?.name;

  let totalCogs = 0;
  const allocationSummary = [];

  for (const item of itemRows) {
    const quantity = num(item.quantity);

    // Lock the pool, then plan against the locked quantities.
    const pool = await lockBatchPool(client, {
      orgId,
      cropId: Number(item.crop_id),
      warehouseId: header.warehouse_id ? Number(header.warehouse_id) : undefined,
    });
    const plan = planAllocation(pool, quantity, header.valuation_method);

    if (plan.shortfall > 0) {
      throw unprocessable(
        'INSUFFICIENT_STOCK',
        `Only ${plan.allocated} available for this crop, but ${quantity} was requested.`
      );
    }

    await consumeAllocation(client, plan.lines);

    for (const alloc of plan.lines) {
      await client.query(
        `INSERT INTO crop_batch_allocations (sale_item_id, batch_id, quantity, unit_cost, cost_value)
         VALUES ($1,$2,$3,$4,$5)`,
        [item.id, alloc.batchId, alloc.quantity, alloc.unitCost, alloc.costValue]
      );

      await recordMovement(client, {
        orgId,
        movementType: 'SALE',
        businessType: 'BULK_CROP',
        warehouseId: alloc.warehouseId,
        itemType: 'CROP_BATCH',
        batchId: alloc.batchId,
        quantity: alloc.quantity,
        unitCost: alloc.unitCost,
        referenceType: 'crop_sales',
        referenceId: saleId,
        movementDate: header.txn_date,
        userId: user.id,
      });

      allocationSummary.push({ batchNo: alloc.batchNo, quantity: alloc.quantity });
    }

    await client.query('UPDATE crop_sale_items SET line_cogs = $1 WHERE id = $2', [
      plan.cogs,
      item.id,
    ]);
    totalCogs += plan.cogs;
  }

  const netAmount = num(header.net_amount);
  const expenses = num(header.transport_cost) + num(header.other_cost);
  const profit = netAmount - totalCogs - expenses;
  const paid = num(header.paid_amount);
  const due = netAmount - paid;

  if (due > 0) {
    await createReceivable(client, {
      orgId,
      partyType: 'COMPANY',
      partyId: Number(header.buyer_company_id),
      businessType: 'BULK_CROP',
      invoiceType: 'crop_sales',
      invoiceId: saleId,
      invoiceNo: header.txn_no,
      invoiceDate: header.txn_date,
      dueDate: addDays(header.txn_date, 14),
      invoiceAmount: netAmount,
      paidAmount: paid,
    });
  }

  const receivableAccount = await ledgerAccount(client, orgId, LEDGER.RECEIVABLE);
  const cropSalesAccount = await ledgerAccount(client, orgId, LEDGER.CROP_SALES);
  await writeLedger(client, {
    orgId,
    coaId: receivableAccount,
    entryDate: header.txn_date,
    businessType: 'BULK_CROP',
    partyType: 'COMPANY',
    partyId: Number(header.buyer_company_id),
    narration: `Crop sale ${header.txn_no} to ${buyerName}`,
    debit: netAmount,
    credit: 0,
    referenceType: 'crop_sales',
    referenceId: saleId,
    userId: user.id,
  });
  await writeLedger(client, {
    orgId,
    entryDate: header.txn_date,
    businessType: 'BULK_CROP',
    coaId: cropSalesAccount,
    narration: `Crop sales income ${header.txn_no}`,
    debit: 0,
    credit: netAmount,
    referenceType: 'crop_sales',
    referenceId: saleId,
    userId: user.id,
  });

  // Selling stock is two events, not one: income is earned, and goods leave.
  // Recording only the first is what left revenue on the books with no cost
  // against it, so a ledger-derived profit read as the whole sale value.
  //
  // The amount is what the FIFO allocation above actually consumed -- the real
  // cost of the real batches -- rather than an average or an estimate. It is
  // written in the same transaction as the sale: if this fails, the sale does
  // not stand either.
  if (totalCogs > 0) {
    await writeLedgerPair(client, {
      orgId,
      entryDate: header.txn_date,
      businessType: 'BULK_CROP',
      amount: totalCogs,
      narration: `Cost of crop sold on ${header.txn_no}`,
      referenceType: 'crop_sales',
      referenceId: saleId,
      userId: user.id,
      debit: { coaId: await ledgerAccount(client, orgId, LEDGER.COST_OF_SALES) },
      credit: { coaId: await ledgerAccount(client, orgId, LEDGER.INVENTORY) },
    });
  }

  // Transport and other cost on the sale are what it took to deliver, not
  // what the crop cost. They are accrued against a payable: the goods go when
  // the sale posts and the transporter is settled separately.
  if (expenses > 0) {
    await writeLedgerPair(client, {
      orgId,
      entryDate: header.txn_date,
      businessType: 'BULK_CROP',
      amount: expenses,
      narration: `Selling expense on ${header.txn_no}`,
      referenceType: 'crop_sales',
      referenceId: saleId,
      userId: user.id,
      debit: { coaId: await ledgerAccount(client, orgId, LEDGER.SELLING_EXPENSE) },
      credit: { coaId: await ledgerAccount(client, orgId, LEDGER.PAYABLE) },
    });
  }

  await client.query(
    `UPDATE crop_sales
        SET status = 'POSTED', posted_at = now(), cogs_amount = $1,
            profit_amount = $2, updated_by = $3
      WHERE id = $4`,
    [totalCogs, profit, user.id, saleId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'crop_sales',
    entityId: saleId,
    action: 'POST',
    oldValue: { status: header.status },
    newValue: { status: 'POSTED', cogs: totalCogs, profit },
    summary: `Crop sale ${header.txn_no} posted; issued from ${allocationSummary
      .map((a) => a.batchNo)
      .join(', ')}`,
  });

  return { cogs: totalCogs, profit, allocations: allocationSummary };
}

/** Cancel a posted crop sale: return stock to its batches and reverse the ledger. */
export async function cancelCropSale(client, { orgId, user, actor, saleId, reason }) {
  const { rows } = await client.query(
    'SELECT * FROM crop_sales WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [saleId, orgId]
  );
  if (!rows.length) throw notFound('Crop sale');
  const header = rows[0];

  if (header.status !== 'POSTED') {
    throw unprocessable('NOT_POSTED', 'Only a posted sale can be cancelled.');
  }

  await restoreAllocation(client, saleId);
  await reverseMovements(client, {
    orgId,
    referenceType: 'crop_sales',
    referenceId: saleId,
    userId: user.id,
    date: new Date().toISOString().slice(0, 10),
  });

  // Stock has gone back; the accounting has to as well, or a cancelled
  // document leaves its revenue, its receivable and its cost on the books.
  await reverseLedgerFor(client, {
    orgId,
    referenceType: 'crop_sales',
    referenceId: saleId,
    reason,
    userId: user.id,
    entryDate: new Date().toISOString().slice(0, 10),
  });

  await client.query(
    `DELETE FROM receivables WHERE invoice_type = 'crop_sales' AND invoice_id = $1`,
    [saleId]
  );

  await client.query(
    `UPDATE crop_sales
        SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1,
            cancellation_reason = $2, updated_by = $1
      WHERE id = $3`,
    [user.id, reason, saleId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'crop_sales',
    entityId: saleId,
    action: 'CANCEL',
    oldValue: { status: 'POSTED' },
    newValue: { status: 'CANCELLED', reason },
    summary: `Crop sale ${header.txn_no} cancelled: ${reason}`,
  });

  return { id: saleId, status: 'CANCELLED' };
}
