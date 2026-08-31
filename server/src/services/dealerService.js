import { num } from '../lib/db.js';
import { nextDocumentNo } from '../lib/numbering.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { recordMovement, reverseMovements, availableProductStock } from './inventoryService.js';
import {
  createReceivable,
  createPayable,
  writeLedger,
  addDays,
  customerOutstanding,
  ledgerAccount,
  writeLedgerPair,
  LEDGER,
  reverseLedgerFor,
} from './financeService.js';
import { evaluateRules, requestApproval } from './approvalService.js';

/**
 * Dealer business: stock bought from principal companies and sold on credit to
 * dealers, retailers and corporates.
 *
 * Unlike bulk crop, dealer products are fungible, so cost is the weighted
 * average the stock ledger maintains rather than a per-batch landed cost.
 */

/* ------------------------------------------------------------- purchases */

export function computePurchaseTotals({ lines, transportCost, otherCost }) {
  let gross = 0;
  let discount = 0;
  let freeQuantity = 0;

  const computed = lines.map((l) => {
    const amount = num(l.quantity) * num(l.rate);
    const lineDiscount = (amount * num(l.discountPct)) / 100;
    gross += amount;
    discount += lineDiscount;
    freeQuantity += num(l.freeQuantity);
    return { ...l, lineNet: amount - lineDiscount };
  });

  const additional = num(transportCost) + num(otherCost);
  return {
    lines: computed,
    gross,
    discount,
    additional,
    freeQuantity,
    net: gross - discount + additional,
  };
}

export async function createDealerPurchase(client, { orgId, user, actor, input }) {
  const company = await client.query(
    `SELECT id, name, credit_days FROM companies
      WHERE id = $1 AND org_id = $2 AND is_active
        AND role IN ('PRINCIPAL', 'SUPPLIER', 'SUPPLIER_AND_BUYER')`,
    [input.companyId, orgId]
  );
  if (!company.rows.length) throw badRequest('INVALID_COMPANY', 'Select a valid company.');

  const warehouse = await client.query(
    'SELECT id, name FROM warehouses WHERE id = $1 AND org_id = $2 AND is_active',
    [input.warehouseId, orgId]
  );
  if (!warehouse.rows.length) throw badRequest('INVALID_WAREHOUSE', 'Select a valid warehouse.');

  for (const line of input.lines) {
    if (!(num(line.quantity) > 0)) {
      throw unprocessable('INVALID_QUANTITY', 'Quantity must be greater than zero.');
    }
  }

  const totals = computePurchaseTotals(input);
  const txnNo =
    input.txnNo || (await nextDocumentNo(client, orgId, 'dealer_purchase', input.txnDate));

  const { rows } = await client.query(
    `INSERT INTO dealer_purchases
       (org_id, txn_no, txn_date, business_type, company_id, supplier_invoice_no,
        warehouse_id, payment_terms, transport_cost, other_cost,
        gross_amount, discount_amount, net_amount, status, created_by)
     VALUES ($1,$2,$3,'DEALER',$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT',$13)
     RETURNING id`,
    [
      orgId,
      txnNo,
      input.txnDate,
      input.companyId,
      input.supplierInvoiceNo ?? null,
      input.warehouseId,
      input.paymentTerms ?? null,
      num(input.transportCost),
      num(input.otherCost),
      totals.gross,
      totals.discount,
      totals.net,
      user.id,
    ]
  );

  const purchaseId = Number(rows[0].id);

  let lineNo = 0;
  for (const line of totals.lines) {
    lineNo += 1;
    await client.query(
      `INSERT INTO dealer_purchase_items
         (purchase_id, line_no, product_id, quantity, free_quantity, rate, discount_pct, line_net)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        purchaseId,
        lineNo,
        line.productId,
        num(line.quantity),
        num(line.freeQuantity),
        num(line.rate),
        num(line.discountPct),
        line.lineNet,
      ]
    );
  }

  await writeAudit(client, {
    actor,
    entityType: 'dealer_purchases',
    entityId: purchaseId,
    action: 'CREATE',
    newValue: { txnNo, company: company.rows[0].name, netAmount: totals.net },
    summary: `Dealer purchase ${txnNo} created for ${company.rows[0].name}`,
  });

  if (input.action !== 'POST') return { id: purchaseId, txnNo, status: 'DRAFT', totals };

  const rule = await evaluateRules(client, {
    orgId,
    entityType: 'dealer_purchases',
    businessType: 'DEALER',
    amount: totals.net,
  });

  if (rule) {
    const approval = await requestApproval(client, {
      orgId,
      entityType: 'dealer_purchases',
      entityId: purchaseId,
      businessType: 'DEALER',
      ruleId: rule.id,
      referenceNo: txnNo,
      partyName: company.rows[0].name,
      amount: totals.net,
      reason: rule.reason,
      date: input.txnDate,
      userId: user.id,
      actor,
    });
    return { id: purchaseId, txnNo, status: 'PENDING_APPROVAL', approval, totals };
  }

  await postDealerPurchase(client, { orgId, user, actor, purchaseId });
  return { id: purchaseId, txnNo, status: 'POSTED', totals };
}

export async function postDealerPurchase(client, { orgId, user, actor, purchaseId }) {
  const { rows: headerRows } = await client.query(
    'SELECT * FROM dealer_purchases WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [purchaseId, orgId]
  );
  if (!headerRows.length) throw notFound('Dealer purchase');
  const header = headerRows[0];

  if (header.status === 'POSTED') {
    throw unprocessable('ALREADY_POSTED', 'This purchase has already been posted.');
  }
  if (header.status === 'CANCELLED') {
    throw unprocessable('ALREADY_CANCELLED', 'This purchase was cancelled and cannot be posted.');
  }

  const { rows: items } = await client.query(
    'SELECT * FROM dealer_purchase_items WHERE purchase_id = $1 ORDER BY line_no',
    [purchaseId]
  );

  const gross = num(header.gross_amount) - num(header.discount_amount);
  const additional = num(header.transport_cost) + num(header.other_cost);

  for (const item of items) {
    // Free issue arrives as stock too, so the effective unit cost spreads the
    // paid amount across everything actually received.
    const received = num(item.quantity) + num(item.free_quantity);
    const lineShare = gross > 0 ? num(item.line_net) / gross : 0;
    const landed = num(item.line_net) + additional * lineShare;
    const unitCost = received > 0 ? landed / received : 0;

    await recordMovement(client, {
      orgId,
      movementType: 'PURCHASE',
      businessType: 'DEALER',
      warehouseId: Number(header.warehouse_id),
      itemType: 'PRODUCT',
      productId: Number(item.product_id),
      quantity: received,
      unitCost,
      referenceType: 'dealer_purchases',
      referenceId: purchaseId,
      movementDate: header.txn_date,
      userId: user.id,
    });
  }

  const netAmount = num(header.net_amount);
  const { rows: companyRows } = await client.query(
    'SELECT name, credit_days FROM companies WHERE id = $1',
    [header.company_id]
  );

  await createPayable(client, {
    orgId,
    partyType: 'COMPANY',
    partyId: Number(header.company_id),
    businessType: 'DEALER',
    invoiceType: 'dealer_purchases',
    invoiceId: purchaseId,
    invoiceNo: header.txn_no,
    invoiceDate: header.txn_date,
    dueDate: addDays(header.txn_date, num(companyRows[0]?.credit_days) || 30),
    invoiceAmount: netAmount,
    paidAmount: 0,
  });

  const inventoryAccount = await ledgerAccount(client, orgId, LEDGER.INVENTORY);
  const purchasePayable = await ledgerAccount(client, orgId, LEDGER.PAYABLE);
  await writeLedger(client, {
    orgId,
    coaId: inventoryAccount,
    entryDate: header.txn_date,
    businessType: 'DEALER',
    narration: `Dealer purchase ${header.txn_no}`,
    debit: netAmount,
    credit: 0,
    referenceType: 'dealer_purchases',
    referenceId: purchaseId,
    userId: user.id,
  });
  await writeLedger(client, {
    orgId,
    entryDate: header.txn_date,
    businessType: 'DEALER',
    coaId: purchasePayable,
    partyType: 'COMPANY',
    partyId: Number(header.company_id),
    narration: `Payable to ${companyRows[0]?.name} for ${header.txn_no}`,
    debit: 0,
    credit: netAmount,
    referenceType: 'dealer_purchases',
    referenceId: purchaseId,
    userId: user.id,
  });

  await client.query(
    `UPDATE dealer_purchases SET status = 'POSTED', posted_at = now(), updated_by = $1 WHERE id = $2`,
    [user.id, purchaseId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'dealer_purchases',
    entityId: purchaseId,
    action: 'POST',
    oldValue: { status: header.status },
    newValue: { status: 'POSTED', netAmount },
    summary: `Dealer purchase ${header.txn_no} posted; stock and company payable updated`,
  });

  return { id: purchaseId, status: 'POSTED' };
}

/* ------------------------------------------------------------------ sales */

export function computeSaleTotals({ lines, paidAmount }, costOf) {
  let gross = 0;
  let discount = 0;
  let cost = 0;

  const computed = lines.map((l) => {
    const amount = num(l.quantity) * num(l.rate);
    const lineDiscount = (amount * num(l.discountPct)) / 100;
    const unitCost = costOf ? costOf(l.productId) : 0;
    const lineCost = (num(l.quantity) + num(l.bonusQuantity)) * unitCost;

    gross += amount;
    discount += lineDiscount;
    cost += lineCost;

    return { ...l, lineNet: amount - lineDiscount, unitCost, lineCost };
  });

  const net = gross - discount;
  const profit = net - cost;

  return {
    lines: computed,
    gross,
    discount,
    net,
    cost,
    profit,
    margin: net ? (profit / net) * 100 : 0,
    due: net - num(paidAmount),
  };
}

export async function createDealerSale(client, { orgId, user, actor, input }) {
  const customer = await client.query(
    'SELECT id, name, credit_limit, credit_days FROM customers WHERE id = $1 AND org_id = $2 AND is_active',
    [input.customerId, orgId]
  );
  if (!customer.rows.length) throw badRequest('INVALID_CUSTOMER', 'Select a valid customer.');

  const warehouse = await client.query(
    'SELECT id, name FROM warehouses WHERE id = $1 AND org_id = $2 AND is_active',
    [input.warehouseId, orgId]
  );
  if (!warehouse.rows.length) throw badRequest('INVALID_WAREHOUSE', 'Select a valid warehouse.');

  // Stock availability is checked before anything is written, so the user gets
  // a clear message rather than a rollback.
  for (const line of input.lines) {
    if (!(num(line.quantity) > 0)) {
      throw unprocessable('INVALID_QUANTITY', 'Quantity must be greater than zero.');
    }
    const needed = num(line.quantity) + num(line.bonusQuantity);
    const available = await availableProductStock(client, {
      warehouseId: input.warehouseId,
      productId: line.productId,
    });
    if (needed > available) {
      const { rows: p } = await client.query('SELECT name FROM products WHERE id = $1', [
        line.productId,
      ]);
      throw unprocessable(
        'INSUFFICIENT_STOCK',
        `Only ${available} of ${p[0]?.name || 'this product'} is available in ${warehouse.rows[0].name}.`
      );
    }
  }

  // Cost comes from the running weighted average held on the stock row.
  const { rows: costRows } = await client.query(
    `SELECT product_id, avg_cost FROM stock
      WHERE warehouse_id = $1 AND item_type = 'PRODUCT' AND product_id = ANY($2::bigint[])`,
    [input.warehouseId, input.lines.map((l) => l.productId)]
  );
  const costMap = new Map(costRows.map((r) => [Number(r.product_id), num(r.avg_cost)]));
  const totals = computeSaleTotals(input, (pid) => costMap.get(Number(pid)) || 0);

  const txnNo = input.txnNo || (await nextDocumentNo(client, orgId, 'dealer_sale', input.txnDate));

  const { rows } = await client.query(
    `INSERT INTO dealer_sales
       (org_id, txn_no, txn_date, business_type, customer_id, warehouse_id, salesperson_id,
        payment_terms, gross_amount, discount_amount, net_amount, cost_amount,
        profit_amount, paid_amount, status, created_by)
     VALUES ($1,$2,$3,'DEALER',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'DRAFT',$14)
     RETURNING id`,
    [
      orgId,
      txnNo,
      input.txnDate,
      input.customerId,
      input.warehouseId,
      input.salespersonId ?? null,
      input.paymentTerms ?? null,
      totals.gross,
      totals.discount,
      totals.net,
      totals.cost,
      totals.profit,
      num(input.paidAmount),
      user.id,
    ]
  );

  const saleId = Number(rows[0].id);

  let lineNo = 0;
  for (const line of totals.lines) {
    lineNo += 1;
    await client.query(
      `INSERT INTO dealer_sale_items
         (sale_id, line_no, product_id, quantity, bonus_quantity, rate, discount_pct,
          line_net, unit_cost, line_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        saleId,
        lineNo,
        line.productId,
        num(line.quantity),
        num(line.bonusQuantity),
        num(line.rate),
        num(line.discountPct),
        line.lineNet,
        line.unitCost,
        line.lineCost,
      ]
    );
  }

  await writeAudit(client, {
    actor,
    entityType: 'dealer_sales',
    entityId: saleId,
    action: 'CREATE',
    newValue: { txnNo, customer: customer.rows[0].name, netAmount: totals.net },
    summary: `Dealer sale ${txnNo} created for ${customer.rows[0].name}`,
  });

  if (input.action !== 'POST') return { id: saleId, txnNo, status: 'DRAFT', totals };

  // Two things can send a dealer sale for approval: an excessive line discount,
  // or exposure beyond the customer's credit limit.
  const maxDiscount = Math.max(0, ...input.lines.map((l) => num(l.discountPct)));
  const { outstanding, creditLimit } = await customerOutstanding(client, input.customerId);
  const overLimit = creditLimit > 0 && outstanding + totals.due > creditLimit;

  const rule = await evaluateRules(client, {
    orgId,
    entityType: 'dealer_sales',
    businessType: 'DEALER',
    amount: totals.net,
    discountPct: maxDiscount,
  });

  if (rule || overLimit) {
    const approval = await requestApproval(client, {
      orgId,
      entityType: 'dealer_sales',
      entityId: saleId,
      businessType: 'DEALER',
      ruleId: rule?.id ?? null,
      referenceNo: txnNo,
      partyName: customer.rows[0].name,
      amount: totals.net,
      reason:
        rule?.reason ||
        `Credit exposure ${(outstanding + totals.due).toLocaleString('en-IN')} exceeds the ` +
          `${creditLimit.toLocaleString('en-IN')} limit`,
      date: input.txnDate,
      userId: user.id,
      actor,
    });
    return { id: saleId, txnNo, status: 'PENDING_APPROVAL', approval, totals };
  }

  await postDealerSale(client, { orgId, user, actor, saleId });
  return { id: saleId, txnNo, status: 'POSTED', totals };
}

export async function postDealerSale(client, { orgId, user, actor, saleId }) {
  const { rows: headerRows } = await client.query(
    'SELECT * FROM dealer_sales WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [saleId, orgId]
  );
  if (!headerRows.length) throw notFound('Dealer sale');
  const header = headerRows[0];

  if (header.status === 'POSTED') {
    throw unprocessable('ALREADY_POSTED', 'This invoice has already been posted.');
  }
  if (header.status === 'CANCELLED') {
    throw unprocessable('ALREADY_CANCELLED', 'This invoice was cancelled and cannot be posted.');
  }

  const { rows: items } = await client.query(
    'SELECT * FROM dealer_sale_items WHERE sale_id = $1 ORDER BY line_no',
    [saleId]
  );

  for (const item of items) {
    await recordMovement(client, {
      orgId,
      movementType: 'SALE',
      businessType: 'DEALER',
      warehouseId: Number(header.warehouse_id),
      itemType: 'PRODUCT',
      productId: Number(item.product_id),
      quantity: num(item.quantity) + num(item.bonus_quantity),
      unitCost: num(item.unit_cost),
      referenceType: 'dealer_sales',
      referenceId: saleId,
      movementDate: header.txn_date,
      userId: user.id,
    });
  }

  const netAmount = num(header.net_amount);
  const paid = num(header.paid_amount);
  const due = netAmount - paid;

  const { rows: customerRows } = await client.query(
    'SELECT name, credit_days FROM customers WHERE id = $1',
    [header.customer_id]
  );

  if (due > 0) {
    await createReceivable(client, {
      orgId,
      partyType: 'CUSTOMER',
      partyId: Number(header.customer_id),
      businessType: 'DEALER',
      invoiceType: 'dealer_sales',
      invoiceId: saleId,
      invoiceNo: header.txn_no,
      invoiceDate: header.txn_date,
      dueDate: addDays(header.txn_date, num(customerRows[0]?.credit_days) || 15),
      invoiceAmount: netAmount,
      paidAmount: paid,
    });
  }

  const saleReceivable = await ledgerAccount(client, orgId, LEDGER.RECEIVABLE);
  const dealerSalesAccount = await ledgerAccount(client, orgId, LEDGER.DEALER_SALES);
  await writeLedger(client, {
    orgId,
    coaId: saleReceivable,
    entryDate: header.txn_date,
    businessType: 'DEALER',
    partyType: 'CUSTOMER',
    partyId: Number(header.customer_id),
    narration: `Dealer sale ${header.txn_no} to ${customerRows[0]?.name}`,
    debit: netAmount,
    credit: 0,
    referenceType: 'dealer_sales',
    referenceId: saleId,
    userId: user.id,
  });
  await writeLedger(client, {
    orgId,
    entryDate: header.txn_date,
    businessType: 'DEALER',
    coaId: dealerSalesAccount,
    narration: `Dealer sales income ${header.txn_no}`,
    debit: 0,
    credit: netAmount,
    referenceType: 'dealer_sales',
    referenceId: saleId,
    userId: user.id,
  });

  // Goods leaving the shelf are a cost, and were not being recorded as one.
  // The amount is the stock cost the sale actually consumed -- the cost stored
  // per line when the invoice was raised, under whichever valuation method the
  // business has configured -- written in this same transaction as the sale.
  const costAmount = num(header.cost_amount);
  if (costAmount > 0) {
    await writeLedgerPair(client, {
      orgId,
      entryDate: header.txn_date,
      businessType: 'DEALER',
      amount: costAmount,
      narration: `Cost of goods sold on ${header.txn_no}`,
      referenceType: 'dealer_sales',
      referenceId: saleId,
      userId: user.id,
      debit: { coaId: await ledgerAccount(client, orgId, LEDGER.COST_OF_SALES) },
      credit: { coaId: await ledgerAccount(client, orgId, LEDGER.INVENTORY) },
    });
  }

  await client.query(
    `UPDATE dealer_sales SET status = 'POSTED', posted_at = now(), updated_by = $1 WHERE id = $2`,
    [user.id, saleId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'dealer_sales',
    entityId: saleId,
    action: 'POST',
    oldValue: { status: header.status },
    newValue: { status: 'POSTED', netAmount, due },
    summary: `Dealer sale ${header.txn_no} posted; stock reduced and receivable raised`,
  });

  return { id: saleId, status: 'POSTED', due };
}

/* ------------------------------------------------------------ cancellation */

async function cancelDocument(client, { table, label, orgId, user, actor, id, reason, invoiceTable }) {
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [id, orgId]
  );
  if (!rows.length) throw notFound(label);
  const header = rows[0];

  if (header.status !== 'POSTED') {
    throw unprocessable('NOT_POSTED', `Only a posted ${label.toLowerCase()} can be cancelled.`);
  }

  const { rows: settled } = await client.query(
    `SELECT paid_amount FROM ${invoiceTable} WHERE invoice_type = $1 AND invoice_id = $2`,
    [table, id]
  );
  if (settled.length && num(settled[0].paid_amount) > 0) {
    throw unprocessable(
      'PAYMENT_ALREADY_RECEIVED',
      'A payment has already been recorded against this document. Reverse the payment first.'
    );
  }

  await reverseMovements(client, {
    orgId,
    referenceType: table,
    referenceId: id,
    userId: user.id,
    date: new Date().toISOString().slice(0, 10),
  });

  // Stock has gone back; the accounting has to as well, or a cancelled
  // document leaves its revenue, its receivable and its cost on the books.
  await reverseLedgerFor(client, {
    orgId,
    referenceType: table,
    referenceId: id,
    reason,
    userId: user.id,
    entryDate: new Date().toISOString().slice(0, 10),
  });

  await client.query(`DELETE FROM ${invoiceTable} WHERE invoice_type = $1 AND invoice_id = $2`, [
    table,
    id,
  ]);

  await client.query(
    `UPDATE ${table}
        SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1,
            cancellation_reason = $2, updated_by = $1
      WHERE id = $3`,
    [user.id, reason, id]
  );

  await writeAudit(client, {
    actor,
    entityType: table,
    entityId: id,
    action: 'CANCEL',
    oldValue: { status: 'POSTED' },
    newValue: { status: 'CANCELLED', reason },
    summary: `${label} ${header.txn_no} cancelled: ${reason}`,
  });

  return { id, status: 'CANCELLED' };
}

export const cancelDealerSale = (client, args) =>
  cancelDocument(client, {
    ...args,
    table: 'dealer_sales',
    label: 'Dealer sale',
    invoiceTable: 'receivables',
    id: args.saleId,
  });

export const cancelDealerPurchase = (client, args) =>
  cancelDocument(client, {
    ...args,
    table: 'dealer_purchases',
    label: 'Dealer purchase',
    invoiceTable: 'payables',
    id: args.purchaseId,
  });
