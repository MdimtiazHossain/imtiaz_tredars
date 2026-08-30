import { num } from '../lib/db.js';
import { nextDocumentNo } from '../lib/numbering.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { recordMovement, reverseMovements } from './inventoryService.js';
import { createPayable, writeLedger, addDays } from './financeService.js';
import { evaluateRules, requestApproval } from './approvalService.js';

/**
 * Bulk crop purchase.
 *
 * The number that matters is landed cost per unit: quantity is reduced by a
 * moisture deduction, then transport, loading, unloading and other expense are
 * absorbed into the cost of what actually arrived. This mirrors
 * `landedCost()` in the frontend's `domain/calculations.js` exactly, so the
 * figure previewed on the form is the figure posted.
 */

/**
 * Compute landed cost for a whole purchase.
 *
 * Header-level incidental cost is pushed down to each line in proportion to
 * that line's value, so a two-crop truckload apportions the freight fairly.
 */
export function computeLandedCost({ lines, transportCost, loadingCost, unloadingCost, otherCost }) {
  const additional =
    num(transportCost) + num(loadingCost) + num(unloadingCost) + num(otherCost);

  const computed = lines.map((line) => {
    const gross = num(line.grossQuantity);
    const deduction = (gross * num(line.moisturePct)) / 100;
    const net = gross - deduction;
    const lineValue = net * num(line.rate);
    return { ...line, grossQuantity: gross, deductionQty: deduction, netQuantity: net, lineValue };
  });

  const totalValue = computed.reduce((t, l) => t + l.lineValue, 0);

  const withCost = computed.map((line) => {
    const share = totalValue > 0 ? line.lineValue / totalValue : 1 / computed.length;
    const allocatedCost = additional * share;
    const landedCost = line.lineValue + allocatedCost;
    return {
      ...line,
      allocatedCost,
      landedCost,
      costPerUnit: line.netQuantity > 0 ? landedCost / line.netQuantity : 0,
    };
  });

  return {
    lines: withCost,
    purchaseValue: totalValue,
    additionalCost: additional,
    netAmount: totalValue + additional,
  };
}

async function validateReferences(client, orgId, input) {
  const supplier = await client.query(
    'SELECT id, name FROM suppliers WHERE id = $1 AND org_id = $2 AND is_active',
    [input.supplierId, orgId]
  );
  if (!supplier.rows.length) throw badRequest('INVALID_SUPPLIER', 'Select a valid supplier.');

  const warehouse = await client.query(
    'SELECT id, name FROM warehouses WHERE id = $1 AND org_id = $2 AND is_active',
    [input.warehouseId, orgId]
  );
  if (!warehouse.rows.length) throw badRequest('INVALID_WAREHOUSE', 'Select a valid warehouse.');

  for (const line of input.lines) {
    const crop = await client.query(
      'SELECT id FROM crops WHERE id = $1 AND org_id = $2 AND is_active',
      [line.cropId, orgId]
    );
    if (!crop.rows.length) throw badRequest('INVALID_CROP', 'Select a valid crop.');
    if (!(num(line.grossQuantity) > 0)) {
      throw unprocessable('INVALID_QUANTITY', 'Quantity must be greater than zero.');
    }
    if (num(line.rate) < 0) {
      throw unprocessable('INVALID_RATE', 'Rate cannot be negative.');
    }
  }

  return { supplier: supplier.rows[0], warehouse: warehouse.rows[0] };
}

/**
 * Create a bulk crop purchase, optionally posting it in the same transaction.
 *
 * Posting performs, atomically: create the document, create a batch per line,
 * write a stock movement per batch, update stock, raise the payable for the
 * unpaid balance, write the journal rows and record the audit entry. Any
 * failure rolls the whole thing back.
 */
export async function createCropPurchase(client, { orgId, user, actor, input }) {
  const { supplier, warehouse } = await validateReferences(client, orgId, input);
  const totals = computeLandedCost(input);

  const txnNo = input.txnNo || (await nextDocumentNo(client, orgId, 'crop_purchase', input.txnDate));

  const { rows } = await client.query(
    `INSERT INTO crop_purchases
       (org_id, txn_no, txn_date, business_type, supplier_id, warehouse_id,
        transport_cost, loading_cost, unloading_cost, other_cost,
        purchase_value, net_amount, advance_paid, note, status, created_by)
     VALUES ($1,$2,$3,'BULK_CROP',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'DRAFT',$14)
     RETURNING id`,
    [
      orgId,
      txnNo,
      input.txnDate,
      input.supplierId,
      input.warehouseId,
      num(input.transportCost),
      num(input.loadingCost),
      num(input.unloadingCost),
      num(input.otherCost),
      totals.purchaseValue,
      totals.netAmount,
      num(input.advancePaid),
      input.note ?? null,
      user.id,
    ]
  );

  const purchaseId = Number(rows[0].id);

  let lineNo = 0;
  const itemIds = [];
  for (const line of totals.lines) {
    lineNo += 1;
    const { rows: item } = await client.query(
      `INSERT INTO crop_purchase_items
         (purchase_id, line_no, crop_id, grade_id, unit_id, gross_quantity, moisture_pct,
          deduction_qty, net_quantity, rate, line_value, allocated_cost, landed_cost, cost_per_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        purchaseId,
        lineNo,
        line.cropId,
        line.gradeId ?? null,
        line.unitId,
        line.grossQuantity,
        num(line.moisturePct),
        line.deductionQty,
        line.netQuantity,
        num(line.rate),
        line.lineValue,
        line.allocatedCost,
        line.landedCost,
        line.costPerUnit,
      ]
    );
    itemIds.push({ id: Number(item[0].id), line });
  }

  await writeAudit(client, {
    actor,
    entityType: 'crop_purchases',
    entityId: purchaseId,
    action: 'CREATE',
    newValue: { txnNo, supplier: supplier.name, netAmount: totals.netAmount },
    summary: `Crop purchase ${txnNo} created for ${supplier.name}`,
  });

  if (input.action !== 'POST') {
    return { id: purchaseId, txnNo, status: 'DRAFT', totals };
  }

  // A purchase over the configured limit is routed for approval instead of
  // hitting stock and the ledger.
  const rule = await evaluateRules(client, {
    orgId,
    entityType: 'crop_purchases',
    businessType: 'BULK_CROP',
    amount: totals.netAmount,
  });

  if (rule) {
    const approval = await requestApproval(client, {
      orgId,
      entityType: 'crop_purchases',
      entityId: purchaseId,
      businessType: 'BULK_CROP',
      ruleId: rule.id,
      referenceNo: txnNo,
      partyName: supplier.name,
      amount: totals.netAmount,
      reason: rule.reason,
      date: input.txnDate,
      userId: user.id,
      actor,
    });
    return {
      id: purchaseId,
      txnNo,
      status: 'PENDING_APPROVAL',
      approval,
      totals,
    };
  }

  const posted = await postCropPurchase(client, { orgId, user, actor, purchaseId, itemIds, warehouse, supplier });
  return { id: purchaseId, txnNo, status: 'POSTED', totals, ...posted };
}

/**
 * Post an existing crop purchase: batches, stock, payable, journal, audit.
 * Safe to call for a draft or an approved document.
 */
export async function postCropPurchase(client, { orgId, user, actor, purchaseId, itemIds, warehouse, supplier }) {
  const { rows: headerRows } = await client.query(
    'SELECT * FROM crop_purchases WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [purchaseId, orgId]
  );
  if (!headerRows.length) throw notFound('Crop purchase');
  const header = headerRows[0];

  if (header.status === 'POSTED') {
    throw unprocessable('ALREADY_POSTED', 'This purchase has already been posted.');
  }
  if (header.status === 'CANCELLED') {
    throw unprocessable('ALREADY_CANCELLED', 'This purchase was cancelled and cannot be posted.');
  }

  const items =
    itemIds ||
    (
      await client.query(
        'SELECT id, crop_id, grade_id, unit_id, net_quantity, cost_per_unit FROM crop_purchase_items WHERE purchase_id = $1 ORDER BY line_no',
        [purchaseId]
      )
    ).rows.map((r) => ({
      id: Number(r.id),
      line: {
        cropId: Number(r.crop_id),
        gradeId: r.grade_id ? Number(r.grade_id) : null,
        unitId: Number(r.unit_id),
        netQuantity: num(r.net_quantity),
        costPerUnit: num(r.cost_per_unit),
      },
    }));

  const supplierName =
    supplier?.name ||
    (await client.query('SELECT name FROM suppliers WHERE id = $1', [header.supplier_id])).rows[0]
      ?.name;

  const batches = [];

  for (const { id: itemId, line } of items) {
    const batchNo = await nextDocumentNo(client, orgId, 'crop_batch', header.txn_date);

    const { rows: batchRows } = await client.query(
      `INSERT INTO crop_batches
         (org_id, batch_no, purchase_item_id, crop_id, grade_id, warehouse_id, supplier_id,
          unit_id, received_on, quantity_received, quantity_remaining, cost_per_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)
       RETURNING id, batch_no`,
      [
        orgId,
        batchNo,
        itemId,
        line.cropId,
        line.gradeId ?? null,
        header.warehouse_id,
        header.supplier_id,
        line.unitId,
        header.txn_date,
        line.netQuantity,
        line.costPerUnit,
      ]
    );

    const batchId = Number(batchRows[0].id);
    batches.push({ id: batchId, batchNo: batchRows[0].batch_no });

    await recordMovement(client, {
      orgId,
      movementType: 'PURCHASE',
      businessType: 'BULK_CROP',
      warehouseId: Number(header.warehouse_id),
      itemType: 'CROP_BATCH',
      batchId,
      quantity: line.netQuantity,
      unitCost: line.costPerUnit,
      referenceType: 'crop_purchases',
      referenceId: purchaseId,
      movementDate: header.txn_date,
      userId: user.id,
    });
  }

  // Anything not paid as an advance becomes payable to the supplier.
  const netAmount = num(header.net_amount);
  const advance = num(header.advance_paid);
  const balance = netAmount - advance;

  if (balance > 0) {
    await createPayable(client, {
      orgId,
      partyType: 'SUPPLIER',
      partyId: Number(header.supplier_id),
      businessType: 'BULK_CROP',
      invoiceType: 'crop_purchases',
      invoiceId: purchaseId,
      invoiceNo: header.txn_no,
      invoiceDate: header.txn_date,
      dueDate: addDays(header.txn_date, 30),
      invoiceAmount: netAmount,
      paidAmount: advance,
    });
  }

  // Journal: stock in (debit), supplier liability (credit).
  await writeLedger(client, {
    orgId,
    entryDate: header.txn_date,
    businessType: 'BULK_CROP',
    narration: `Crop purchase ${header.txn_no} from ${supplierName}`,
    debit: netAmount,
    credit: 0,
    referenceType: 'crop_purchases',
    referenceId: purchaseId,
    userId: user.id,
  });
  await writeLedger(client, {
    orgId,
    entryDate: header.txn_date,
    businessType: 'BULK_CROP',
    partyType: 'SUPPLIER',
    partyId: Number(header.supplier_id),
    narration: `Payable to ${supplierName} for ${header.txn_no}`,
    debit: 0,
    credit: netAmount,
    referenceType: 'crop_purchases',
    referenceId: purchaseId,
    userId: user.id,
  });

  await client.query(
    `UPDATE crop_purchases
        SET status = 'POSTED', posted_at = now(), updated_by = $1
      WHERE id = $2`,
    [user.id, purchaseId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'crop_purchases',
    entityId: purchaseId,
    action: 'POST',
    oldValue: { status: header.status },
    newValue: { status: 'POSTED', batches: batches.map((b) => b.batchNo) },
    summary: `Crop purchase ${header.txn_no} posted; batch ${batches.map((b) => b.batchNo).join(', ')} added to stock`,
  });

  return { batches, warehouseName: warehouse?.name };
}

/** Cancel a posted purchase: reverse stock, drop the payable, keep the record. */
export async function cancelCropPurchase(client, { orgId, user, actor, purchaseId, reason }) {
  const { rows } = await client.query(
    'SELECT * FROM crop_purchases WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [purchaseId, orgId]
  );
  if (!rows.length) throw notFound('Crop purchase');
  const header = rows[0];

  if (header.status !== 'POSTED') {
    throw unprocessable('NOT_POSTED', 'Only a posted purchase can be cancelled.');
  }

  // Refuse if any batch from this purchase has already been sold.
  const { rows: consumed } = await client.query(
    `SELECT b.batch_no
       FROM crop_batches b
       JOIN crop_purchase_items i ON i.id = b.purchase_item_id
      WHERE i.purchase_id = $1 AND b.quantity_remaining < b.quantity_received`,
    [purchaseId]
  );
  if (consumed.length) {
    throw unprocessable(
      'BATCH_ALREADY_SOLD',
      `Batch ${consumed[0].batch_no} has already been partly sold, so this purchase cannot be cancelled.`
    );
  }

  await reverseMovements(client, {
    orgId,
    referenceType: 'crop_purchases',
    referenceId: purchaseId,
    userId: user.id,
    date: new Date().toISOString().slice(0, 10),
  });

  await client.query(
    `UPDATE crop_batches SET is_active = false
      WHERE purchase_item_id IN (SELECT id FROM crop_purchase_items WHERE purchase_id = $1)`,
    [purchaseId]
  );

  await client.query(
    `DELETE FROM payables WHERE invoice_type = 'crop_purchases' AND invoice_id = $1`,
    [purchaseId]
  );

  await client.query(
    `UPDATE crop_purchases
        SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1,
            cancellation_reason = $2, updated_by = $1
      WHERE id = $3`,
    [user.id, reason, purchaseId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'crop_purchases',
    entityId: purchaseId,
    action: 'CANCEL',
    oldValue: { status: 'POSTED' },
    newValue: { status: 'CANCELLED', reason },
    summary: `Crop purchase ${header.txn_no} cancelled: ${reason}`,
  });

  return { id: purchaseId, status: 'CANCELLED' };
}
