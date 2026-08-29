import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction, num } from '../lib/db.js';
import {
  handler,
  ok,
  created,
  parseBody,
  parseQuery,
  listQuerySchema,
  paginate,
  pageMeta,
  orderBy,
} from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { recordMovement } from '../services/inventoryService.js';
import { nextDocumentNo } from '../lib/numbering.js';
import { writeAudit } from '../lib/audit.js';
import { evaluateRules, requestApproval } from '../services/approvalService.js';

/**
 * Inventory: unified stock across dealer products and bulk crop batches, plus
 * the movement ledger, adjustments and transfers.
 */
const router = Router();

const STOCK_SORTS = {
  name: 'name',
  qty: 'quantity',
  value: 'stock_value',
  age: 'age_days',
};

/** Unified stock list, sorted and paginated in the database. */
router.get(
  '/',
  requirePermission('inventory.view'),
  handler(async (req, res) => {
    const q = parseQuery(
      listQuerySchema.extend({ kind: z.enum(['all', 'crop', 'dealer']).default('all') }),
      req
    );
    const { limit, offset } = paginate(q.page, q.pageSize);

    // One shape for both stock kinds so the DataTable can render them together,
    // exactly as the Inventory screen already does.
    const unified = `
      SELECT 'crop' AS kind,
             c.name AS name,
             'Batch ' || b.batch_no || ' · ' || COALESCE(g.name, '') AS sub,
             w.name AS warehouse,
             s.quantity AS quantity,
             u.code AS unit,
             b.cost_per_unit AS unit_cost,
             s.quantity * b.cost_per_unit AS stock_value,
             (CURRENT_DATE - b.received_on)::int AS age_days,
             b.received_on AS as_of,
             ((CURRENT_DATE - b.received_on) > 60) AS flagged
        FROM stock s
        JOIN crop_batches b ON b.id = s.batch_id
        JOIN crops c ON c.id = b.crop_id
        LEFT JOIN crop_grades g ON g.id = b.grade_id
        JOIN warehouses w ON w.id = s.warehouse_id
        JOIN units u ON u.id = b.unit_id
       WHERE s.org_id = $1 AND s.item_type = 'CROP_BATCH' AND s.quantity > 0
      UNION ALL
      SELECT 'dealer' AS kind,
             p.name,
             COALESCE(br.name, '') || ' · ' || COALESCE(pc.name, ''),
             w.name,
             s.quantity,
             u.code,
             s.avg_cost,
             s.quantity * s.avg_cost,
             NULL::int,
             NULL::date,
             (s.quantity < p.min_stock)
        FROM stock s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN brands br ON br.id = p.brand_id
        LEFT JOIN product_categories pc ON pc.id = p.category_id
        JOIN warehouses w ON w.id = s.warehouse_id
        JOIN units u ON u.id = p.unit_id
       WHERE s.org_id = $1 AND s.item_type = 'PRODUCT' AND s.quantity > 0`;

    const kindFilter =
      q.kind === 'all' ? '' : `WHERE kind = '${q.kind === 'crop' ? 'crop' : 'dealer'}'`;

    const { rows: totals } = await query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(stock_value), 0) AS value
         FROM (${unified}) t ${kindFilter}`,
      [req.orgId]
    );

    const { rows } = await query(
      `SELECT * FROM (${unified}) t ${kindFilter}
        ORDER BY ${orderBy(q.sort, q.dir, STOCK_SORTS, 'stock_value')} ${q.sort ? '' : 'DESC'}
        LIMIT ${limit} OFFSET ${offset}`,
      [req.orgId]
    );

    ok(
      res,
      rows.map((r) => ({
        kind: r.kind,
        name: r.name,
        sub: r.sub,
        warehouse: r.warehouse,
        qty: num(r.quantity),
        unit: r.unit,
        cost: num(r.unit_cost),
        value: num(r.stock_value),
        age: r.age_days === null ? null : Number(r.age_days),
        date: r.as_of,
        flagged: r.flagged,
      })),
      { ...pageMeta(q.page, q.pageSize, totals[0].total), totalValue: num(totals[0].value) }
    );
  })
);

/** The movement ledger — the audit trail for stock. */
router.get(
  '/movements',
  requirePermission('inventory.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'm.org_id = $1';
    if (q.from) {
      params.push(q.from);
      where += ` AND m.movement_date >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND m.movement_date <= $${params.length}`;
    }
    if (q.businessType !== 'ALL') {
      params.push(q.businessType);
      where += ` AND m.business_type = $${params.length}`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM stock_movements m WHERE ${where}`,
      params
    );
    const { rows } = await query(
      `SELECT m.movement_no, m.movement_date, m.movement_type, m.business_type,
              w.name AS warehouse, m.quantity_in, m.quantity_out, m.unit_cost,
              m.reference_type, m.reference_id,
              COALESCE(p.name, c.name || ' (' || b.batch_no || ')') AS item
         FROM stock_movements m
         JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN products p ON p.id = m.product_id
         LEFT JOIN crop_batches b ON b.id = m.batch_id
         LEFT JOIN crops c ON c.id = b.crop_id
        WHERE ${where}
        ORDER BY m.movement_date DESC, m.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        no: r.movement_no,
        date: r.movement_date,
        type: r.movement_type,
        businessType: r.business_type,
        warehouse: r.warehouse,
        item: r.item,
        in: num(r.quantity_in),
        out: num(r.quantity_out),
        unitCost: num(r.unit_cost),
        reference: `${r.reference_type}#${r.reference_id}`,
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

/**
 * Stock adjustment. Always routed through the approval engine when a rule says
 * so — an unexplained stock change is the one thing that must never be silent.
 */
const adjustmentSchema = z.object({
  txnDate: z.string().date(),
  warehouseId: z.coerce.number().int().positive(),
  businessType: z.enum(['DEALER', 'BULK_CROP']),
  reason: z.string().trim().min(3, 'Give a reason for the adjustment').max(300),
  lines: z
    .array(
      z.object({
        itemType: z.enum(['PRODUCT', 'CROP_BATCH']),
        productId: z.coerce.number().int().positive().optional(),
        batchId: z.coerce.number().int().positive().optional(),
        quantityDelta: z.coerce.number().refine((v) => v !== 0, 'Change cannot be zero'),
        unitCost: z.coerce.number().min(0).default(0),
      })
    )
    .min(1, 'Add at least one line'),
});

router.post(
  '/adjustments',
  requirePermission('inventory.adjust'),
  handler(async (req, res) => {
    const input = parseBody(adjustmentSchema, req);

    const result = await withTransaction(async (client) => {
      const txnNo = await nextDocumentNo(client, req.orgId, 'adjustment', input.txnDate);
      const value = input.lines.reduce(
        (t, l) => t + Math.abs(num(l.quantityDelta)) * num(l.unitCost),
        0
      );

      const { rows } = await client.query(
        `INSERT INTO stock_adjustments
           (org_id, txn_no, txn_date, business_type, warehouse_id, reason, net_amount,
            status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8) RETURNING id`,
        [
          req.orgId,
          txnNo,
          input.txnDate,
          input.businessType,
          input.warehouseId,
          input.reason,
          value,
          req.user.id,
        ]
      );
      const adjustmentId = Number(rows[0].id);

      let lineNo = 0;
      for (const line of input.lines) {
        lineNo += 1;
        await client.query(
          `INSERT INTO stock_adjustment_items
             (adjustment_id, line_no, item_type, product_id, batch_id, quantity_delta,
              unit_cost, value_delta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            adjustmentId,
            lineNo,
            line.itemType,
            line.productId ?? null,
            line.batchId ?? null,
            num(line.quantityDelta),
            num(line.unitCost),
            num(line.quantityDelta) * num(line.unitCost),
          ]
        );
      }

      const rule = await evaluateRules(client, {
        orgId: req.orgId,
        entityType: 'stock_adjustments',
        businessType: input.businessType,
        amount: value,
      });

      if (rule) {
        const approval = await requestApproval(client, {
          orgId: req.orgId,
          entityType: 'stock_adjustments',
          entityId: adjustmentId,
          businessType: input.businessType,
          ruleId: rule.id,
          referenceNo: txnNo,
          partyName: input.reason,
          amount: value,
          reason: rule.reason,
          date: input.txnDate,
          userId: req.user.id,
          actor: req.actor,
        });
        return { id: adjustmentId, txnNo, status: 'PENDING_APPROVAL', approval };
      }

      for (const line of input.lines) {
        const delta = num(line.quantityDelta);
        await recordMovement(client, {
          orgId: req.orgId,
          movementType: delta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
          businessType: input.businessType,
          warehouseId: input.warehouseId,
          itemType: line.itemType,
          productId: line.productId,
          batchId: line.batchId,
          quantity: Math.abs(delta),
          unitCost: num(line.unitCost),
          referenceType: 'stock_adjustments',
          referenceId: adjustmentId,
          movementDate: input.txnDate,
          userId: req.user.id,
          note: input.reason,
        });
      }

      await client.query(
        `UPDATE stock_adjustments SET status = 'POSTED', posted_at = now() WHERE id = $1`,
        [adjustmentId]
      );

      await writeAudit(client, {
        actor: req.actor,
        entityType: 'stock_adjustments',
        entityId: adjustmentId,
        action: 'POST',
        newValue: { txnNo, reason: input.reason, lines: input.lines.length },
        summary: `Stock adjustment ${txnNo} posted: ${input.reason}`,
      });

      return { id: adjustmentId, txnNo, status: 'POSTED' };
    });

    created(res, result);
  })
);

/**
 * Ledger reconciliation: any row here means the running balance and the
 * movement history disagree, which should never happen.
 */
router.get(
  '/reconciliation',
  requirePermission('inventory.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM v_stock_reconciliation WHERE difference <> 0 LIMIT 200'
    );
    ok(res, {
      balanced: rows.length === 0,
      discrepancies: rows.map((r) => ({
        warehouseId: Number(r.warehouse_id),
        itemType: r.item_type,
        productId: r.product_id ? Number(r.product_id) : null,
        batchId: r.batch_id ? Number(r.batch_id) : null,
        stockQuantity: num(r.stock_quantity),
        ledgerQuantity: num(r.ledger_quantity),
        difference: num(r.difference),
      })),
    });
  })
);

export default router;
