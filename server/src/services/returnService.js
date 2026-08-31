import { num } from '../lib/db.js';
import { nextDocumentNo } from '../lib/numbering.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { recordMovement, reverseMovements } from './inventoryService.js';
import {
  writeLedger,
  writeLedgerPair,
  reverseLedgerFor,
  ledgerAccount,
  LEDGER,
} from './financeService.js';

/**
 * Returns, and the notes that settle them.
 *
 * A return is not a small cancellation. Cancelling unwinds a document whole;
 * a return takes back part of one and leaves the rest standing, which means it
 * has to know three things the cancel path never needed: how much of each line
 * has already come back, what the goods cost when they left, and what the
 * party's balance should become.
 *
 * All four flows are the same document pointed in different directions, so
 * they are one table and one service with a strategy per source type. What
 * differs between them is only where the goods live -- a dealer product sits
 * in `stock` under a product id, a crop sits in a batch -- and which side of
 * the party's account moves.
 *
 *   dealer_sales      goods back in    credit note   customer owes us less
 *   crop_sales        goods back in    credit note   buyer company owes less
 *   dealer_purchases  goods back out   debit note    we owe the principal less
 *   crop_purchases    goods back out   debit note    we owe the farmer less
 *
 * Costing follows the goods rather than the market. A sale return puts stock
 * back at the cost it left at -- taken from the sale line, not from today's
 * average -- because valuing a return at anything else would silently rewrite
 * the profit on every other unit in the warehouse.
 */

/* ------------------------------------------------------------- source kinds */

/**
 * What each kind of return does, stated once.
 *
 * `inbound` is whether the goods come back to us. `noteType` is the paper it
 * raises. `invoiceTable` is which side of the party's account the note lands
 * on. `sourceLabel` is what a person calls the document being returned.
 */
export const SOURCE_KINDS = {
  dealer_sales: {
    inbound: true,
    noteType: 'CREDIT',
    businessType: 'DEALER',
    partyType: 'CUSTOMER',
    invoiceTable: 'receivables',
    docType: 'sale_return',
    sourceLabel: 'Dealer sale',
    label: 'Sale return',
    itemType: 'PRODUCT',
  },
  crop_sales: {
    inbound: true,
    noteType: 'CREDIT',
    businessType: 'BULK_CROP',
    partyType: 'COMPANY',
    invoiceTable: 'receivables',
    docType: 'sale_return',
    sourceLabel: 'Crop sale',
    label: 'Sale return',
    itemType: 'CROP_BATCH',
  },
  dealer_purchases: {
    inbound: false,
    noteType: 'DEBIT',
    businessType: 'DEALER',
    partyType: 'COMPANY',
    invoiceTable: 'payables',
    docType: 'purchase_return',
    sourceLabel: 'Dealer purchase',
    label: 'Purchase return',
    itemType: 'PRODUCT',
  },
  crop_purchases: {
    inbound: false,
    noteType: 'DEBIT',
    businessType: 'BULK_CROP',
    partyType: 'SUPPLIER',
    invoiceTable: 'payables',
    docType: 'purchase_return',
    sourceLabel: 'Crop purchase',
    label: 'Purchase return',
    itemType: 'CROP_BATCH',
  },
};

const kindOf = (sourceType) => {
  const kind = SOURCE_KINDS[sourceType];
  if (!kind) throw badRequest('INVALID_SOURCE', 'That kind of document cannot be returned.');
  return kind;
};

/* ------------------------------------------------------- what is returnable */

/** The party a document was traded with, and the column that names them. */
const PARTY_COLUMN = {
  dealer_sales: 'customer_id',
  crop_sales: 'buyer_company_id',
  dealer_purchases: 'company_id',
  crop_purchases: 'supplier_id',
};

/**
 * The lines of a posted document, with how much of each has already come back.
 *
 * This is what both the form and the posting path read: the form offers what
 * is left, and the post refuses anything more. Neither gets to decide for
 * itself what "already returned" means.
 */
export async function returnableLines(client, { orgId, sourceType, sourceId }) {
  const kind = kindOf(sourceType);

  const { rows: headerRows } = await client.query(
    `SELECT * FROM ${sourceType} WHERE id = $1 AND org_id = $2`,
    [sourceId, orgId]
  );
  if (!headerRows.length) throw notFound(kind.sourceLabel);
  const header = headerRows[0];

  if (header.status !== 'POSTED') {
    throw unprocessable(
      'NOT_POSTED',
      `Only a posted ${kind.sourceLabel.toLowerCase()} can be returned.`
    );
  }

  const lines = await sourceLines(client, { sourceType, sourceId });

  const { rows: returned } = await client.query(
    `SELECT source_item_id, quantity_returned FROM v_returned_quantities
      WHERE source_type = $1 AND source_id = $2`,
    [sourceType, sourceId]
  );
  const alreadyReturned = new Map(
    returned.map((r) => [Number(r.source_item_id), num(r.quantity_returned)])
  );

  return {
    header: {
      id: Number(header.id),
      txnNo: header.txn_no,
      txnDate: header.txn_date,
      status: header.status,
      partyType: kind.partyType,
      partyId: Number(header[PARTY_COLUMN[sourceType]]),
      warehouseId: header.warehouse_id ? Number(header.warehouse_id) : null,
      netAmount: num(header.net_amount),
      sourceType,
      sourceLabel: kind.sourceLabel,
      noteType: kind.noteType,
      businessType: kind.businessType,
    },
    lines: lines.map((l) => {
      const done = alreadyReturned.get(l.sourceItemId) || 0;
      const unreturned = l.quantity - done;
      // Goods going back to a supplier have to still be here. What was sold
      // on cannot be returned, however little of the purchase has come back,
      // so the form offers the smaller of the two rather than letting the
      // posting path be the first thing that says no.
      const returnable =
        l.available === null ? unreturned : Math.max(0, Math.min(unreturned, l.available));
      return { ...l, quantityReturned: done, quantityReturnable: returnable };
    }),
  };
}

/**
 * The lines of a source document, normalised.
 *
 * A crop sale is the awkward one: its lines name a crop, but the goods sit in
 * batches, and which batches they came from was decided by FIFO at posting
 * time. The allocation rows are therefore the returnable unit -- each is a
 * quantity of one batch at one cost, which is exactly what has to go back.
 */
async function sourceLines(client, { sourceType, sourceId }) {
  if (sourceType === 'dealer_sales') {
    const { rows } = await client.query(
      `SELECT i.id, i.line_no, i.product_id, p.name AS product_name, p.code AS product_code,
              i.quantity, i.rate, i.discount_pct, i.line_net, i.unit_cost, i.tax_rate
         FROM dealer_sale_items i
         JOIN products p ON p.id = i.product_id
        WHERE i.sale_id = $1 ORDER BY i.line_no`,
      [sourceId]
    );
    return rows.map((r) => ({
      sourceItemId: Number(r.id),
      lineNo: r.line_no,
      itemType: 'PRODUCT',
      productId: Number(r.product_id),
      batchId: null,
      description: `${r.product_name} (${r.product_code})`,
      // A product returns to the warehouse the document names; only a crop
      // carries its own, because a batch lives somewhere specific.
      warehouseId: null,
      available: null,
      quantity: num(r.quantity),
      rate: num(r.rate),
      discountPct: num(r.discount_pct),
      taxRate: num(r.tax_rate),
      unitCost: num(r.unit_cost),
    }));
  }

  if (sourceType === 'dealer_purchases') {
    const { rows } = await client.query(
      `SELECT i.id, i.line_no, i.product_id, p.name AS product_name, p.code AS product_code,
              i.quantity, i.rate, i.discount_pct, i.line_net, i.tax_rate,
              COALESCE(s.quantity, 0) AS on_hand
         FROM dealer_purchase_items i
         JOIN products p ON p.id = i.product_id
         JOIN dealer_purchases h ON h.id = i.purchase_id
         LEFT JOIN stock s ON s.warehouse_id = h.warehouse_id
                          AND s.item_type = 'PRODUCT'
                          AND s.product_id = i.product_id
        WHERE i.purchase_id = $1 ORDER BY i.line_no`,
      [sourceId]
    );
    return rows.map((r) => ({
      sourceItemId: Number(r.id),
      lineNo: r.line_no,
      itemType: 'PRODUCT',
      productId: Number(r.product_id),
      batchId: null,
      description: `${r.product_name} (${r.product_code})`,
      warehouseId: null,
      // Goods can only go back to a principal while we still have them.
      available: num(r.on_hand),
      quantity: num(r.quantity),
      rate: num(r.rate),
      discountPct: num(r.discount_pct),
      taxRate: num(r.tax_rate),
      // Goods go back at what we paid, which is this line's own net rate.
      unitCost: num(r.quantity) ? num(r.line_net) / num(r.quantity) : 0,
    }));
  }

  if (sourceType === 'crop_sales') {
    const { rows } = await client.query(
      `SELECT a.id, i.line_no, a.batch_id, b.batch_no, b.warehouse_id, c.name AS crop_name,
              a.quantity, i.rate, a.unit_cost, i.tax_rate
         FROM crop_batch_allocations a
         JOIN crop_sale_items i ON i.id = a.sale_item_id
         JOIN crop_batches b ON b.id = a.batch_id
         JOIN crops c ON c.id = i.crop_id
        WHERE i.sale_id = $1 ORDER BY i.line_no, a.id`,
      [sourceId]
    );
    return rows.map((r) => ({
      sourceItemId: Number(r.id),
      lineNo: r.line_no,
      itemType: 'CROP_BATCH',
      productId: null,
      batchId: Number(r.batch_id),
      description: `${r.crop_name} — batch ${r.batch_no}`,
      // A crop sale need not name a warehouse; the batch always does, and the
      // goods go back where they came from.
      warehouseId: Number(r.warehouse_id),
      available: null,
      quantity: num(r.quantity),
      rate: num(r.rate),
      discountPct: 0,
      taxRate: num(r.tax_rate),
      unitCost: num(r.unit_cost),
    }));
  }

  // crop_purchases: a line becomes one batch per godown it was split across,
  // so the batch is the returnable unit rather than the line. Keying on the
  // line instead would let two batches of the same line share one identity,
  // and a return against either would be recorded against both.
  const { rows } = await client.query(
    `SELECT i.line_no, b.id AS batch_id, b.batch_no, b.warehouse_id,
            b.quantity_received, b.quantity_remaining, c.name AS crop_name,
            i.rate, b.cost_per_unit, i.tax_rate
       FROM crop_purchase_items i
       JOIN crops c ON c.id = i.crop_id
       JOIN crop_batches b ON b.purchase_item_id = i.id
      WHERE i.purchase_id = $1 ORDER BY i.line_no, b.id`,
    [sourceId]
  );
  return rows.map((r) => ({
    sourceItemId: Number(r.batch_id),
    lineNo: r.line_no,
    itemType: 'CROP_BATCH',
    productId: null,
    batchId: Number(r.batch_id),
    description: `${r.crop_name} — batch ${r.batch_no}`,
    warehouseId: Number(r.warehouse_id),
    // Crop already sold on cannot go back to the farmer it came from.
    available: num(r.quantity_remaining),
    quantity: num(r.quantity_received),
    rate: num(r.rate),
    discountPct: 0,
    taxRate: num(r.tax_rate),
    unitCost: num(r.cost_per_unit),
  }));
}

/* ------------------------------------------------------------------ totals */

/** What a set of return lines comes to, before anything is written down. */
export function computeReturnTotals(lines) {
  const paisa = (n) => Math.round(n * 100) / 100;
  let gross = 0;
  let discount = 0;
  let cost = 0;
  let tax = 0;

  const computed = lines.map((l) => {
    const amount = num(l.quantity) * num(l.rate);
    const lineDiscount = (amount * num(l.discountPct)) / 100;
    const lineCost = num(l.quantity) * num(l.unitCost);
    const lineNet = amount - lineDiscount;
    // The rate the original document charged, not today's. A budget that moves
    // the standard rate must not change what a returning customer is credited.
    const lineTax = paisa((lineNet * num(l.taxRate)) / 100);

    gross += amount;
    discount += lineDiscount;
    cost += lineCost;
    tax += lineTax;
    return { ...l, lineNet, lineCost, taxAmount: lineTax };
  });

  const net = paisa(gross - discount);
  return {
    lines: computed,
    gross: paisa(gross),
    discount: paisa(discount),
    net,
    cost: paisa(cost),
    tax: paisa(tax),
    total: paisa(net + tax),
  };
}

/* ------------------------------------------------------------------ create */

export async function createReturn(client, { orgId, user, actor, input }) {
  const kind = kindOf(input.sourceType);
  const source = await returnableLines(client, {
    orgId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  });

  const byId = new Map(source.lines.map((l) => [l.sourceItemId, l]));
  const lines = [];

  for (const requested of input.lines) {
    const original = byId.get(Number(requested.sourceItemId));
    if (!original) {
      throw badRequest('INVALID_LINE', 'A line was returned that is not on this document.');
    }

    const quantity = num(requested.quantity);
    if (!(quantity > 0)) {
      throw unprocessable('INVALID_QUANTITY', 'Quantity must be greater than zero.');
    }
    if (quantity > original.quantityReturnable + 1e-9) {
      throw unprocessable(
        'RETURN_EXCEEDS_SOLD',
        `Only ${original.quantityReturnable} of ${original.description} is left to return; ` +
          `${original.quantityReturned} has already come back.`
      );
    }

    lines.push({
      sourceItemId: original.sourceItemId,
      itemType: original.itemType,
      productId: original.productId,
      batchId: original.batchId,
      warehouseId: original.warehouseId,
      quantity,
      // The rate is the document's, not the operator's: a return credits what
      // was charged. Only the quantity is a decision.
      rate: original.rate,
      discountPct: original.discountPct,
      taxRate: original.taxRate,
      unitCost: original.unitCost,
    });
  }

  if (!lines.length) throw unprocessable('NO_LINES', 'Add at least one line to return.');

  const totals = computeReturnTotals(lines);
  const txnNo = input.txnNo || (await nextDocumentNo(client, orgId, kind.docType, input.txnDate));
  // A crop sale names no warehouse -- the goods came out of batches, each of
  // which lives somewhere -- so the header takes the first batch's and each
  // line still moves through its own.
  const warehouseId =
    input.warehouseId ?? source.header.warehouseId ?? lines.find((l) => l.warehouseId)?.warehouseId;
  if (!warehouseId) {
    throw badRequest('INVALID_WAREHOUSE', 'Say which warehouse the goods move through.');
  }

  const { rows } = await client.query(
    `INSERT INTO returns
       (org_id, txn_no, txn_date, business_type, source_type, source_id, source_no,
        party_type, party_id, warehouse_id, reason,
        gross_amount, discount_amount, net_amount, tax_amount, total_amount,
        cost_amount, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'DRAFT',$18)
     RETURNING id`,
    [
      orgId,
      txnNo,
      input.txnDate,
      kind.businessType,
      input.sourceType,
      input.sourceId,
      source.header.txnNo,
      kind.partyType,
      source.header.partyId,
      warehouseId,
      input.reason,
      totals.gross,
      totals.discount,
      totals.net,
      totals.tax,
      totals.total,
      totals.cost,
      user.id,
    ]
  );

  const returnId = Number(rows[0].id);

  let lineNo = 0;
  for (const line of totals.lines) {
    lineNo += 1;
    await client.query(
      `INSERT INTO return_items
         (return_id, line_no, source_item_id, item_type, product_id, batch_id,
          quantity, rate, discount_pct, line_net, unit_cost, line_cost,
          tax_rate, tax_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        returnId,
        lineNo,
        line.sourceItemId,
        line.itemType,
        line.productId,
        line.batchId,
        line.quantity,
        line.rate,
        line.discountPct,
        line.lineNet,
        line.unitCost,
        line.lineCost,
        num(line.taxRate),
        num(line.taxAmount),
      ]
    );
  }

  await writeAudit(client, {
    actor,
    entityType: 'returns',
    entityId: returnId,
    action: 'CREATE',
    newValue: { txnNo, source: source.header.txnNo, net: totals.net, reason: input.reason },
    summary: `${kind.label} ${txnNo} raised against ${source.header.txnNo}`,
  });

  return { id: returnId, txnNo, status: 'DRAFT', ...totals };
}

/* -------------------------------------------------------------------- post */

export async function postReturn(client, { orgId, user, actor, returnId }) {
  const { rows: headerRows } = await client.query(
    'SELECT * FROM returns WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [returnId, orgId]
  );
  if (!headerRows.length) throw notFound('Return');
  const header = headerRows[0];
  const kind = kindOf(header.source_type);

  if (header.status === 'POSTED') {
    throw unprocessable('ALREADY_POSTED', 'This return has already been posted.');
  }
  if (header.status === 'CANCELLED') {
    throw unprocessable('ALREADY_CANCELLED', 'This return was cancelled and cannot be posted.');
  }

  const { rows: items } = await client.query(
    'SELECT * FROM return_items WHERE return_id = $1 ORDER BY line_no',
    [returnId]
  );

  // Re-check against what has come back since the draft was raised. Two drafts
  // for the same invoice could each be valid alone and too much together, and
  // only the second one to post can see that.
  await assertStillReturnable(client, { orgId, header, items, returnId });

  const movementType = kind.inbound ? 'RETURN_IN' : 'RETURN_OUT';
  for (const item of items) {
    await recordMovement(client, {
      orgId,
      movementType,
      businessType: header.business_type,
      // A batch goes back to where the batch is; a product to the warehouse
      // the return names. One sale can have drawn from several godowns.
      warehouseId: await warehouseFor(client, { item, header }),
      itemType: item.item_type,
      productId: item.product_id ? Number(item.product_id) : undefined,
      batchId: item.batch_id ? Number(item.batch_id) : undefined,
      quantity: num(item.quantity),
      // The cost the goods carried when they moved the other way, so putting
      // them back leaves the running average exactly as it was.
      unitCost: num(item.unit_cost),
      referenceType: 'returns',
      referenceId: returnId,
      movementDate: header.txn_date,
      userId: user.id,
      note: `Against ${header.source_no}`,
    });

    // A crop batch is more than a stock row: the remaining quantity is what
    // FIFO allocates from, so it has to move with the goods.
    if (item.item_type === 'CROP_BATCH') {
      await moveBatchQuantity(client, {
        batchId: Number(item.batch_id),
        delta: kind.inbound ? num(item.quantity) : -num(item.quantity),
      });
    }
  }

  // The party is credited what they were charged, tax included: a customer who
  // paid VAT on goods they sent back gets the VAT back with them.
  const note = await raiseNote(client, {
    orgId,
    user,
    kind,
    header,
    amount: num(header.total_amount) || num(header.net_amount),
    reason: header.reason,
    returnId,
  });

  await writeReturnJournal(client, { orgId, user, kind, header, returnId });

  await client.query(
    `UPDATE returns SET status = 'POSTED', posted_at = now(), updated_by = $1 WHERE id = $2`,
    [user.id, returnId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'returns',
    entityId: returnId,
    action: 'POST',
    oldValue: { status: header.status },
    newValue: { status: 'POSTED', net: num(header.net_amount), note: note.noteNo },
    summary:
      `${kind.label} ${header.txn_no} posted against ${header.source_no}; ` +
      `${kind.noteType === 'CREDIT' ? 'credit' : 'debit'} note ${note.noteNo} raised`,
  });

  return { id: returnId, status: 'POSTED', note };
}

/**
 * Refuse a return that, added to what has already come back, exceeds the sale.
 *
 * The draft was checked when it was raised, but drafts sit around. This runs
 * under the same transaction as the posting, so two of them racing serialise
 * on the source rows rather than both passing.
 */
async function assertStillReturnable(client, { orgId, header, items, returnId }) {
  const kind = kindOf(header.source_type);

  // A batch that has been sold on cannot be sent back to the farmer. Checked
  // first because it explains itself better than the quantity check would:
  // the shortfall is not another return, it is that the crop has gone.
  for (const item of items) {
    if (item.item_type !== 'CROP_BATCH' || kind.inbound) continue;
    const { rows } = await client.query(
      'SELECT batch_no, quantity_remaining FROM crop_batches WHERE id = $1 FOR UPDATE',
      [item.batch_id]
    );
    if (!rows.length) throw notFound('Crop batch');
    if (num(rows[0].quantity_remaining) < num(item.quantity) - 1e-9) {
      throw unprocessable(
        'BATCH_ALREADY_SOLD',
        `Batch ${rows[0].batch_no} has only ${num(rows[0].quantity_remaining)} left; ` +
          'the rest has been sold and cannot go back to the supplier.'
      );
    }
  }

  const source = await returnableLines(client, {
    orgId,
    sourceType: header.source_type,
    sourceId: Number(header.source_id),
  });
  const byId = new Map(source.lines.map((l) => [l.sourceItemId, l]));

  for (const item of items) {
    const original = byId.get(Number(item.source_item_id));
    if (!original) {
      throw unprocessable(
        'SOURCE_CHANGED',
        'A line on this return is no longer on the document it came from.'
      );
    }
    if (num(item.quantity) > original.quantityReturnable + 1e-9) {
      throw unprocessable(
        'RETURN_EXCEEDS_SOLD',
        `Only ${original.quantityReturnable} of ${original.description} is left to return. ` +
          'Another return was posted against this document in the meantime.'
      );
    }
  }

  return returnId;
}

/** Where one returned line's goods belong. */
async function warehouseFor(client, { item, header }) {
  if (item.item_type !== 'CROP_BATCH') return Number(header.warehouse_id);
  const { rows } = await client.query('SELECT warehouse_id FROM crop_batches WHERE id = $1', [
    item.batch_id,
  ]);
  return rows.length ? Number(rows[0].warehouse_id) : Number(header.warehouse_id);
}

/** Move a batch's remaining quantity, refusing to take it below zero. */
async function moveBatchQuantity(client, { batchId, delta }) {
  const { rowCount } = await client.query(
    `UPDATE crop_batches
        SET quantity_remaining = quantity_remaining + $1, updated_at = now()
      WHERE id = $2 AND quantity_remaining + $1 >= 0`,
    [delta, batchId]
  );
  if (rowCount !== 1) {
    throw unprocessable(
      'BATCH_ALREADY_SOLD',
      'That batch no longer holds the quantity being returned. Refresh and try again.'
    );
  }
}

/* ------------------------------------------------------------ credit notes */

/**
 * Raise the note a return produces, and set it against the invoice.
 *
 * The note is applied to the document it came from, up to whatever is still
 * outstanding on it. Anything beyond that stays on the note as an on-account
 * balance -- a customer who has already paid in full and then returns goods is
 * owed money, and the note is what says so until it is refunded or set against
 * their next invoice.
 */
async function raiseNote(client, { orgId, user, kind, header, amount, reason, returnId }) {
  const docType = kind.noteType === 'CREDIT' ? 'credit_note' : 'debit_note';
  const noteNo = await nextDocumentNo(client, orgId, docType, header.txn_date);

  const { rows } = await client.query(
    `INSERT INTO credit_notes
       (org_id, note_no, note_date, note_type, business_type, party_type, party_id,
        return_id, source_type, source_id, source_no, reason, amount, status,
        posted_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'POSTED',now(),$14)
     RETURNING id`,
    [
      orgId,
      noteNo,
      header.txn_date,
      kind.noteType,
      header.business_type,
      header.party_type,
      header.party_id,
      returnId,
      header.source_type,
      header.source_id,
      header.source_no,
      reason,
      amount,
      user.id,
    ]
  );

  const noteId = Number(rows[0].id);
  const applied = await applyNote(client, {
    noteId,
    invoiceTable: kind.invoiceTable,
    invoiceType: header.source_type,
    invoiceId: Number(header.source_id),
    amount,
  });

  return { id: noteId, noteNo, noteType: kind.noteType, amount, ...applied };
}

/**
 * Set a note against one invoice, as far as that invoice can take it.
 *
 * A credit note is not a payment: no money changed hands, so it reduces what
 * the invoice is worth rather than what has been paid on it. It can never
 * reduce the invoice below what has already been settled in cash -- that
 * remainder is a refund owed, and it stays on the note.
 */
export async function applyNote(client, { noteId, invoiceTable, invoiceType, invoiceId, amount }) {
  const { rows } = await client.query(
    `SELECT id, invoice_no, invoice_amount, paid_amount, balance
       FROM ${invoiceTable}
      WHERE invoice_type = $1 AND invoice_id = $2
      FOR UPDATE`,
    [invoiceType, invoiceId]
  );

  // A fully-settled invoice has no row left to adjust, and one that was paid in
  // full at the counter never had one. Either way the whole note sits on
  // account.
  if (!rows.length) {
    await client.query('UPDATE credit_notes SET applied_amount = 0 WHERE id = $1', [noteId]);
    return { applied: 0, onAccount: num(amount) };
  }

  const target = rows[0];
  const applied = Math.min(num(amount), num(target.balance));

  if (applied > 0) {
    const invoiceAmount = num(target.invoice_amount) - applied;
    const paid = num(target.paid_amount);
    await client.query(
      `UPDATE ${invoiceTable}
          SET invoice_amount = $1, balance = $2, is_settled = $3, updated_at = now()
        WHERE id = $4`,
      [invoiceAmount, invoiceAmount - paid, invoiceAmount - paid <= 0, target.id]
    );
    await client.query(
      `INSERT INTO credit_note_allocations (note_id, invoice_type, invoice_id, amount)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (note_id, invoice_type, invoice_id)
       DO UPDATE SET amount = credit_note_allocations.amount + EXCLUDED.amount`,
      [noteId, invoiceType, invoiceId, applied]
    );
  }

  const { rows: total } = await client.query(
    'SELECT COALESCE(SUM(amount), 0) AS applied FROM credit_note_allocations WHERE note_id = $1',
    [noteId]
  );
  await client.query('UPDATE credit_notes SET applied_amount = $1 WHERE id = $2', [
    num(total[0].applied),
    noteId,
  ]);

  return { applied, onAccount: num(amount) - num(total[0].applied) };
}

/* ---------------------------------------------------------------- journal */

/**
 * The accounting a posted return makes.
 *
 * A sale return is two pairs, because a sale was two events. The revenue side
 * goes to its own account rather than back against sales: a month with heavy
 * returns should read as a month with heavy returns, not as a quiet one.
 *
 *   sale return       Dr sales returns   Cr receivable      what we credit them
 *                     Dr inventory       Cr cost of sales   goods back on the shelf
 *
 *   purchase return   Dr payable         Cr inventory       goods off the shelf,
 *                                                           and we owe that much less
 */
async function writeReturnJournal(client, { orgId, user, kind, header, returnId }) {
  const net = num(header.net_amount);
  const tax = num(header.tax_amount);
  const total = num(header.total_amount) || net;
  const cost = num(header.cost_amount);
  const shared = {
    orgId,
    entryDate: header.txn_date,
    businessType: header.business_type,
    referenceType: 'returns',
    referenceId: returnId,
    userId: user.id,
  };

  if (kind.inbound) {
    if (total > 0) {
      // Three-sided, because a sale was: the revenue comes off, the VAT the
      // business no longer owes the NBR comes off, and the customer is
      // credited the two together.
      await writeLedger(client, {
        ...shared,
        coaId: await ledgerAccount(client, orgId, LEDGER.SALES_RETURNS),
        narration: `Return ${header.txn_no} against ${header.source_no}`,
        debit: net,
        credit: 0,
      });
      if (tax > 0) {
        await writeLedger(client, {
          ...shared,
          coaId: await ledgerAccount(client, orgId, LEDGER.OUTPUT_VAT),
          narration: `Output VAT credited back on ${header.txn_no}`,
          debit: tax,
          credit: 0,
        });
      }
      await writeLedger(client, {
        ...shared,
        coaId: await ledgerAccount(client, orgId, LEDGER.RECEIVABLE),
        partyType: header.party_type,
        partyId: Number(header.party_id),
        narration: `Credited to ${header.source_no}`,
        debit: 0,
        credit: total,
      });
    }
    if (cost > 0) {
      await writeLedgerPair(client, {
        ...shared,
        amount: cost,
        narration: `Cost of goods returned on ${header.txn_no}`,
        debit: { coaId: await ledgerAccount(client, orgId, LEDGER.INVENTORY) },
        credit: { coaId: await ledgerAccount(client, orgId, LEDGER.COST_OF_SALES) },
      });
    }
    return;
  }

  if (total > 0) {
    // Goods went back and so does the rebate: input VAT already claimed on
    // them is no longer claimable, so it is credited out rather than left
    // sitting as a receivable from the NBR.
    await writeLedger(client, {
      ...shared,
      coaId: await ledgerAccount(client, orgId, LEDGER.PAYABLE),
      partyType: header.party_type,
      partyId: Number(header.party_id),
      narration: `Return ${header.txn_no} against ${header.source_no}`,
      debit: total,
      credit: 0,
    });
    await writeLedger(client, {
      ...shared,
      coaId: await ledgerAccount(client, orgId, LEDGER.INVENTORY),
      narration: `Stock sent back on ${header.txn_no}`,
      debit: 0,
      credit: net,
    });
    if (tax > 0) {
      await writeLedger(client, {
        ...shared,
        coaId: await ledgerAccount(client, orgId, LEDGER.INPUT_VAT),
        narration: `Input VAT reversed on ${header.txn_no}`,
        debit: 0,
        credit: tax,
      });
    }
  }
}

/* ------------------------------------------------------------------ cancel */

export async function cancelReturn(client, { orgId, user, actor, returnId, reason }) {
  const { rows } = await client.query(
    'SELECT * FROM returns WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [returnId, orgId]
  );
  if (!rows.length) throw notFound('Return');
  const header = rows[0];
  const kind = kindOf(header.source_type);

  if (header.status !== 'POSTED') {
    throw unprocessable('NOT_POSTED', 'Only a posted return can be cancelled.');
  }

  // The note it raised may already have been set against an invoice or paid
  // out. Unwinding a return whose credit has been spent would leave the party
  // with money they no longer have a document for.
  const { rows: notes } = await client.query(
    'SELECT id, note_no, amount, applied_amount FROM credit_notes WHERE return_id = $1 FOR UPDATE',
    [returnId]
  );

  const { rows: items } = await client.query(
    'SELECT * FROM return_items WHERE return_id = $1 ORDER BY line_no',
    [returnId]
  );

  const today = new Date().toISOString().slice(0, 10);

  await reverseMovements(client, {
    orgId,
    referenceType: 'returns',
    referenceId: returnId,
    userId: user.id,
    date: today,
  });

  for (const item of items) {
    if (item.item_type !== 'CROP_BATCH') continue;
    await moveBatchQuantity(client, {
      batchId: Number(item.batch_id),
      delta: kind.inbound ? -num(item.quantity) : num(item.quantity),
    });
  }

  for (const note of notes) {
    await unapplyNote(client, {
      noteId: Number(note.id),
      invoiceTable: kind.invoiceTable,
    });
    await client.query(
      `UPDATE credit_notes
          SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1,
              cancellation_reason = $2, updated_by = $1
        WHERE id = $3`,
      [user.id, reason, note.id]
    );
  }

  await reverseLedgerFor(client, {
    orgId,
    referenceType: 'returns',
    referenceId: returnId,
    reason,
    userId: user.id,
    entryDate: today,
  });

  await client.query(
    `UPDATE returns
        SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1,
            cancellation_reason = $2, updated_by = $1
      WHERE id = $3`,
    [user.id, reason, returnId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'returns',
    entityId: returnId,
    action: 'CANCEL',
    oldValue: { status: 'POSTED' },
    newValue: { status: 'CANCELLED', reason },
    summary: `${kind.label} ${header.txn_no} cancelled: ${reason}`,
  });

  return { id: returnId, status: 'CANCELLED' };
}

/** Put back everything a note took off its invoices, and forget the links. */
async function unapplyNote(client, { noteId, invoiceTable }) {
  const { rows } = await client.query(
    'SELECT invoice_type, invoice_id, amount FROM credit_note_allocations WHERE note_id = $1',
    [noteId]
  );

  for (const allocation of rows) {
    const { rows: target } = await client.query(
      `SELECT id, invoice_amount, paid_amount FROM ${invoiceTable}
        WHERE invoice_type = $1 AND invoice_id = $2 FOR UPDATE`,
      [allocation.invoice_type, allocation.invoice_id]
    );
    if (!target.length) continue;

    const invoiceAmount = num(target[0].invoice_amount) + num(allocation.amount);
    const paid = num(target[0].paid_amount);
    await client.query(
      `UPDATE ${invoiceTable}
          SET invoice_amount = $1, balance = $2, is_settled = $3, updated_at = now()
        WHERE id = $4`,
      [invoiceAmount, invoiceAmount - paid, invoiceAmount - paid <= 0, target[0].id]
    );
  }

  await client.query('DELETE FROM credit_note_allocations WHERE note_id = $1', [noteId]);
  await client.query('UPDATE credit_notes SET applied_amount = 0 WHERE id = $1', [noteId]);
}

/* ------------------------------------------------- standalone credit notes */

/**
 * A note with no goods behind it.
 *
 * A price agreed after the invoice went out, or an allowance for damage the
 * customer keeps rather than sends back. There is nothing to move in the
 * warehouse and nothing to cost, so it is one journal pair and an adjustment
 * to the party's balance.
 */
export async function createStandaloneNote(client, { orgId, user, actor, input }) {
  const noteType = input.noteType;
  const isCredit = noteType === 'CREDIT';
  const invoiceTable = isCredit ? 'receivables' : 'payables';
  const docType = isCredit ? 'credit_note' : 'debit_note';

  let sourceNo = null;
  if (input.sourceType && input.sourceId) {
    const kind = kindOf(input.sourceType);
    if (kind.noteType !== noteType) {
      throw badRequest(
        'INVALID_SOURCE',
        `A ${isCredit ? 'credit' : 'debit'} note cannot be raised against a ` +
          `${kind.sourceLabel.toLowerCase()}.`
      );
    }
    const { rows } = await client.query(
      `SELECT txn_no, status FROM ${input.sourceType} WHERE id = $1 AND org_id = $2`,
      [input.sourceId, orgId]
    );
    if (!rows.length) throw notFound(kind.sourceLabel);
    if (rows[0].status !== 'POSTED') {
      throw unprocessable('NOT_POSTED', 'A note can only adjust a posted document.');
    }
    sourceNo = rows[0].txn_no;
  }

  const noteNo = await nextDocumentNo(client, orgId, docType, input.noteDate);
  const amount = num(input.amount);

  const { rows } = await client.query(
    `INSERT INTO credit_notes
       (org_id, note_no, note_date, note_type, business_type, party_type, party_id,
        source_type, source_id, source_no, reason, amount, status, posted_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'POSTED',now(),$13)
     RETURNING id`,
    [
      orgId,
      noteNo,
      input.noteDate,
      noteType,
      input.businessType,
      input.partyType,
      input.partyId,
      input.sourceType ?? null,
      input.sourceId ?? null,
      sourceNo,
      input.reason,
      amount,
      user.id,
    ]
  );
  const noteId = Number(rows[0].id);

  let applied = { applied: 0, onAccount: amount };
  if (input.sourceType && input.sourceId) {
    applied = await applyNote(client, {
      noteId,
      invoiceTable,
      invoiceType: input.sourceType,
      invoiceId: Number(input.sourceId),
      amount,
    });
  }

  // No goods moved, so only the money side is journalled. An allowance to a
  // supplier reduces what the stock cost us rather than earning us anything.
  await writeLedgerPair(client, {
    orgId,
    entryDate: input.noteDate,
    businessType: input.businessType,
    amount,
    narration: `${isCredit ? 'Credit' : 'Debit'} note ${noteNo}: ${input.reason}`,
    referenceType: 'credit_notes',
    referenceId: noteId,
    userId: user.id,
    debit: isCredit
      ? { coaId: await ledgerAccount(client, orgId, LEDGER.SALES_RETURNS) }
      : {
          coaId: await ledgerAccount(client, orgId, LEDGER.PAYABLE),
          partyType: input.partyType,
          partyId: input.partyId,
        },
    credit: isCredit
      ? {
          coaId: await ledgerAccount(client, orgId, LEDGER.RECEIVABLE),
          partyType: input.partyType,
          partyId: input.partyId,
        }
      : { coaId: await ledgerAccount(client, orgId, LEDGER.COST_OF_SALES) },
  });

  await writeAudit(client, {
    actor,
    entityType: 'credit_notes',
    entityId: noteId,
    action: 'CREATE',
    newValue: { noteNo, noteType, amount, reason: input.reason },
    summary:
      `${isCredit ? 'Credit' : 'Debit'} note ${noteNo} for ${amount}` +
      (sourceNo ? ` against ${sourceNo}` : ' on account'),
  });

  return { id: noteId, noteNo, noteType, amount, ...applied };
}
