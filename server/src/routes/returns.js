import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction, num } from '../lib/db.js';
import {
  handler,
  ok,
  created,
  parseBody,
  parseQuery,
  parseParams,
  listQuerySchema,
  idParamSchema,
  paginate,
  pageMeta,
} from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { notFound } from '../lib/errors.js';
import {
  SOURCE_KINDS,
  returnableLines,
  createReturn,
  postReturn,
  cancelReturn,
  createStandaloneNote,
  computeReturnTotals,
} from '../services/returnService.js';

/** Goods coming back, and the credit and debit notes that settle them. */
const router = Router();

const SOURCE_TYPES = /** @type {[string, ...string[]]} */ (Object.keys(SOURCE_KINDS));

/* ---------------------------------------------------------- what can return */

/**
 * The lines of a posted document with what is left to return on each.
 *
 * The form is built from this rather than from the invoice: an invoice line
 * says what was sold, and only this says what is still returnable after
 * earlier returns.
 */
router.get(
  '/returnable/:sourceType/:id',
  requirePermission('return.create'),
  handler(async (req, res) => {
    const { sourceType, id } = parseParams(
      z.object({ sourceType: z.enum(SOURCE_TYPES), id: z.coerce.number().int().positive() }),
      req
    );
    // Reading needs no transaction, and the pool answers the same interface a
    // client does, so the service does not need a second entry point.
    const result = await returnableLines({ query }, {
      orgId: req.orgId,
      sourceType,
      sourceId: id,
    });
    ok(res, result);
  })
);

/**
 * Posted documents that still have something to come back.
 *
 * A return has to name the document it came from, and the four kinds live in
 * four tables. Rather than make the form assemble a picker out of four list
 * endpoints -- two of which it has no other reason to call -- this is the one
 * question it actually wants answered: what can I raise a return against.
 */
router.get(
  '/returnable',
  requirePermission('return.create'),
  handler(async (req, res) => {
    const q = parseQuery(
      listQuerySchema.extend({ sourceType: z.enum(SOURCE_TYPES).optional() }),
      req
    );
    const wanted = q.sourceType ? [q.sourceType] : SOURCE_TYPES;

    const branches = wanted.map((sourceType) => {
      const kind = SOURCE_KINDS[sourceType];
      const party = {
        dealer_sales: 'JOIN customers party ON party.id = d.customer_id',
        crop_sales: 'JOIN companies party ON party.id = d.buyer_company_id',
        dealer_purchases: 'JOIN companies party ON party.id = d.company_id',
        crop_purchases: 'JOIN suppliers party ON party.id = d.supplier_id',
      }[sourceType];

      return `SELECT '${sourceType}' AS source_type, d.id, d.txn_no, d.txn_date,
                     d.net_amount, party.name AS party_name,
                     '${kind.sourceLabel}' AS source_label,
                     ${kind.inbound} AS inbound
                FROM ${sourceType} d
                ${party}
               WHERE d.org_id = $1 AND d.status = 'POSTED'`;
    });

    const params = [req.orgId];
    let filter = '';
    if (q.from) {
      params.push(q.from);
      filter += ` AND txn_date >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      filter += ` AND txn_date <= $${params.length}`;
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      filter += ` AND (txn_no ILIKE $${params.length} OR party_name ILIKE $${params.length})`;
    }

    const { limit } = paginate(1, q.pageSize);
    const { rows } = await query(
      `SELECT * FROM (${branches.join(' UNION ALL ')}) AS d
        WHERE true ${filter}
        ORDER BY txn_date DESC, txn_no DESC
        LIMIT ${limit}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        sourceType: r.source_type,
        sourceId: Number(r.id),
        txnNo: r.txn_no,
        txnDate: r.txn_date,
        partyName: r.party_name,
        sourceLabel: r.source_label,
        direction: r.inbound ? 'SALE' : 'PURCHASE',
        netAmount: num(r.net_amount),
      }))
    );
  })
);

/* ------------------------------------------------------------------- list */

const returnListSchema = listQuerySchema.extend({
  sourceType: z.enum(SOURCE_TYPES).optional(),
  direction: z.enum(['SALE', 'PURCHASE']).optional(),
  status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).optional(),
});

router.get(
  '/returns',
  requirePermission('return.view'),
  handler(async (req, res) => {
    const q = parseQuery(returnListSchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'r.org_id = $1';
    if (q.from) {
      params.push(q.from);
      where += ` AND r.txn_date >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND r.txn_date <= $${params.length}`;
    }
    if (q.sourceType) {
      params.push(q.sourceType);
      where += ` AND r.source_type = $${params.length}`;
    }
    if (q.status) {
      params.push(q.status);
      where += ` AND r.status = $${params.length}`;
    }
    if (q.direction) {
      const types = SOURCE_TYPES.filter((t) =>
        q.direction === 'SALE' ? SOURCE_KINDS[t].inbound : !SOURCE_KINDS[t].inbound
      );
      params.push(types);
      where += ` AND r.source_type = ANY($${params.length})`;
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (r.txn_no ILIKE $${params.length} OR r.source_no ILIKE $${params.length})`;
    }

    const { rows } = await query(
      `SELECT r.id, r.txn_no, r.txn_date, r.business_type, r.source_type, r.source_no,
              r.party_type, r.party_id, r.reason, r.net_amount, r.cost_amount, r.status,
              w.name AS warehouse_name,
              n.note_no, n.note_type, n.amount AS note_amount,
              n.amount - n.applied_amount AS note_on_account,
              ${PARTY_NAME} AS party_name
         FROM returns r
         JOIN warehouses w ON w.id = r.warehouse_id
         LEFT JOIN credit_notes n ON n.return_id = r.id AND n.status = 'POSTED'
        WHERE ${where}
        ORDER BY r.txn_date DESC, r.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT count(*)::int AS total FROM returns r WHERE ${where}`,
      params
    );

    ok(
      res,
      rows.map(returnRow),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

/**
 * A party is a customer, a supplier or a company depending on the document, so
 * the name is resolved by type rather than by a fourth join per query.
 */
const PARTY_NAME = `CASE r.party_type
    WHEN 'CUSTOMER' THEN (SELECT name FROM customers WHERE id = r.party_id)
    WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers WHERE id = r.party_id)
    ELSE                 (SELECT name FROM companies WHERE id = r.party_id)
  END`;

const returnRow = (r) => ({
  id: Number(r.id),
  txnNo: r.txn_no,
  txnDate: r.txn_date,
  businessType: r.business_type,
  sourceType: r.source_type,
  sourceNo: r.source_no,
  sourceLabel: SOURCE_KINDS[r.source_type]?.sourceLabel,
  direction: SOURCE_KINDS[r.source_type]?.inbound ? 'SALE' : 'PURCHASE',
  partyType: r.party_type,
  partyId: Number(r.party_id),
  partyName: r.party_name,
  warehouse: r.warehouse_name,
  reason: r.reason,
  netAmount: num(r.net_amount),
  costAmount: num(r.cost_amount),
  status: r.status,
  noteNo: r.note_no,
  noteType: r.note_type,
  noteAmount: r.note_amount === null ? null : num(r.note_amount),
  noteOnAccount: r.note_on_account === null ? null : num(r.note_on_account),
});

router.get(
  '/returns/:id',
  requirePermission('return.view'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const { rows } = await query(
      `SELECT r.*, w.name AS warehouse_name,
              n.note_no, n.note_type, n.amount AS note_amount,
              n.amount - n.applied_amount AS note_on_account,
              ${PARTY_NAME} AS party_name
         FROM returns r
         JOIN warehouses w ON w.id = r.warehouse_id
         LEFT JOIN credit_notes n ON n.return_id = r.id AND n.status = 'POSTED'
        WHERE r.id = $1 AND r.org_id = $2`,
      [id, req.orgId]
    );
    if (!rows.length) throw notFound('Return');

    const { rows: items } = await query(
      `SELECT i.*, p.name AS product_name, p.code AS product_code,
              b.batch_no, c.name AS crop_name
         FROM return_items i
         LEFT JOIN products p ON p.id = i.product_id
         LEFT JOIN crop_batches b ON b.id = i.batch_id
         LEFT JOIN crops c ON c.id = b.crop_id
        WHERE i.return_id = $1 ORDER BY i.line_no`,
      [id]
    );

    ok(res, {
      ...returnRow(rows[0]),
      grossAmount: num(rows[0].gross_amount),
      discountAmount: num(rows[0].discount_amount),
      cancellationReason: rows[0].cancellation_reason,
      lines: items.map((i) => ({
        lineNo: i.line_no,
        itemType: i.item_type,
        description: i.product_id
          ? `${i.product_name} (${i.product_code})`
          : `${i.crop_name} — batch ${i.batch_no}`,
        quantity: num(i.quantity),
        rate: num(i.rate),
        discountPct: num(i.discount_pct),
        lineNet: num(i.line_net),
        unitCost: num(i.unit_cost),
        lineCost: num(i.line_cost),
      })),
    });
  })
);

/* ----------------------------------------------------------------- writing */

const returnSchema = z.object({
  txnDate: z.string().date(),
  sourceType: z.enum(SOURCE_TYPES),
  sourceId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(3, 'Say why the goods came back').max(300),
  lines: z
    .array(
      z.object({
        sourceItemId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().positive('Quantity must be greater than zero'),
      })
    )
    .min(1, 'Add at least one line to return'),
  action: z.enum(['DRAFT', 'POST']).default('DRAFT'),
});

router.post(
  '/returns/preview',
  requirePermission('return.create'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        lines: z.array(
          z.object({
            quantity: z.coerce.number().min(0),
            rate: z.coerce.number().min(0),
            discountPct: z.coerce.number().min(0).max(100).default(0),
            unitCost: z.coerce.number().min(0).default(0),
          })
        ),
      }),
      req
    );
    ok(res, computeReturnTotals(body.lines));
  })
);

router.post(
  '/returns',
  requirePermission('return.create'),
  handler(async (req, res) => {
    const input = parseBody(returnSchema, req);
    const result = await withTransaction(async (client) => {
      const draft = await createReturn(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        input,
      });
      if (input.action !== 'POST') return draft;

      // Posting in the same transaction as the draft, so a return either
      // exists and has moved stock or does not exist at all.
      const posted = await postReturn(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        returnId: draft.id,
      });
      return { ...draft, ...posted };
    });
    created(res, result);
  })
);

router.post(
  '/returns/:id/post',
  requirePermission('return.post'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const result = await withTransaction((client) =>
      postReturn(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        returnId: id,
      })
    );
    ok(res, result);
  })
);

router.post(
  '/returns/:id/cancel',
  requirePermission('return.cancel'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3).max(300) }), req);
    const result = await withTransaction((client) =>
      cancelReturn(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        returnId: id,
        reason: body.reason,
      })
    );
    ok(res, result);
  })
);

/* ------------------------------------------------------------ credit notes */

const noteListSchema = listQuerySchema.extend({
  noteType: z.enum(['CREDIT', 'DEBIT']).optional(),
  openOnly: z.coerce.boolean().optional(),
});

router.get(
  '/credit-notes',
  requirePermission('return.view'),
  handler(async (req, res) => {
    const q = parseQuery(noteListSchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'n.org_id = $1';
    if (q.from) {
      params.push(q.from);
      where += ` AND n.note_date >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND n.note_date <= $${params.length}`;
    }
    if (q.noteType) {
      params.push(q.noteType);
      where += ` AND n.note_type = $${params.length}`;
    }
    if (q.openOnly) where += ' AND n.applied_amount < n.amount AND n.status = \'POSTED\'';
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (n.note_no ILIKE $${params.length} OR n.source_no ILIKE $${params.length})`;
    }

    const { rows } = await query(
      `SELECT n.id, n.note_no, n.note_date, n.note_type, n.business_type,
              n.party_type, n.party_id, n.source_type, n.source_no, n.reason,
              n.amount, n.applied_amount, n.amount - n.applied_amount AS on_account,
              n.status, r.txn_no AS return_no,
              CASE n.party_type
                WHEN 'CUSTOMER' THEN (SELECT name FROM customers WHERE id = n.party_id)
                WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers WHERE id = n.party_id)
                ELSE                 (SELECT name FROM companies WHERE id = n.party_id)
              END AS party_name
         FROM credit_notes n
         LEFT JOIN returns r ON r.id = n.return_id
        WHERE ${where}
        ORDER BY n.note_date DESC, n.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT count(*)::int AS total FROM credit_notes n WHERE ${where}`,
      params
    );

    ok(
      res,
      rows.map((n) => ({
        id: Number(n.id),
        noteNo: n.note_no,
        noteDate: n.note_date,
        noteType: n.note_type,
        businessType: n.business_type,
        partyType: n.party_type,
        partyId: Number(n.party_id),
        partyName: n.party_name,
        sourceType: n.source_type,
        sourceNo: n.source_no,
        returnNo: n.return_no,
        reason: n.reason,
        amount: num(n.amount),
        appliedAmount: num(n.applied_amount),
        onAccount: num(n.on_account),
        status: n.status,
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

const noteSchema = z.object({
  noteDate: z.string().date(),
  noteType: z.enum(['CREDIT', 'DEBIT']),
  businessType: z.enum(['DEALER', 'BULK_CROP']),
  partyType: z.enum(['CUSTOMER', 'SUPPLIER', 'COMPANY']),
  partyId: z.coerce.number().int().positive(),
  sourceType: z.enum(SOURCE_TYPES).optional(),
  sourceId: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(3, 'Say what the note is for').max(300),
  amount: z.coerce.number().positive('The amount must be greater than zero'),
});

router.post(
  '/credit-notes',
  requirePermission('credit.note.create'),
  handler(async (req, res) => {
    const input = parseBody(noteSchema, req);
    const result = await withTransaction((client) =>
      createStandaloneNote(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        input,
      })
    );
    created(res, result);
  })
);

export default router;
