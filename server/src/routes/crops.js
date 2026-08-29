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
  orderBy,
} from '../lib/http.js';
import { requirePermission, canSeeProfit } from '../middleware/auth.js';
import {
  createCropPurchase,
  postCropPurchase,
  cancelCropPurchase,
  computeLandedCost,
} from '../services/cropPurchaseService.js';
import {
  createCropSale,
  postCropSale,
  cancelCropSale,
  previewAllocation,
} from '../services/cropSaleService.js';

/** Bulk crop trading: farmer procurement and batch-wise sale to buyer companies. */
const router = Router();

const purchaseLineSchema = z.object({
  cropId: z.coerce.number().int().positive(),
  gradeId: z.coerce.number().int().positive().optional(),
  unitId: z.coerce.number().int().positive(),
  grossQuantity: z.coerce.number().positive('Quantity must be greater than zero'),
  moisturePct: z.coerce.number().min(0).max(99).default(0),
  rate: z.coerce.number().min(0),
});

const purchaseSchema = z.object({
  txnDate: z.string().date(),
  supplierId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive(),
  transportCost: z.coerce.number().min(0).default(0),
  loadingCost: z.coerce.number().min(0).default(0),
  unloadingCost: z.coerce.number().min(0).default(0),
  otherCost: z.coerce.number().min(0).default(0),
  advancePaid: z.coerce.number().min(0).default(0),
  note: z.string().max(500).optional(),
  lines: z.array(purchaseLineSchema).min(1, 'Add at least one crop line'),
  action: z.enum(['DRAFT', 'POST']).default('DRAFT'),
});

/** Landed-cost preview: same arithmetic as posting, but writes nothing. */
router.post(
  '/purchases/preview',
  requirePermission('crop.purchase.view'),
  handler(async (req, res) => {
    const body = parseBody(purchaseSchema.partial({ supplierId: true, warehouseId: true }), req);
    ok(res, computeLandedCost(body));
  })
);

router.get(
  '/purchases',
  requirePermission('crop.purchase.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'p.org_id = $1';
    if (q.from) {
      params.push(q.from);
      where += ` AND p.txn_date >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND p.txn_date <= $${params.length}`;
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (p.txn_no ILIKE $${params.length} OR s.name ILIKE $${params.length})`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM crop_purchases p
         JOIN suppliers s ON s.id = p.supplier_id WHERE ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT p.id, p.txn_no, p.txn_date, s.name AS supplier, p.net_amount, p.status,
              c.name AS crop, i.net_quantity, u.code AS unit, i.rate, i.cost_per_unit
         FROM crop_purchases p
         JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN crop_purchase_items i ON i.purchase_id = p.id AND i.line_no = 1
         LEFT JOIN crops c ON c.id = i.crop_id
         LEFT JOIN units u ON u.id = i.unit_id
        WHERE ${where}
        ORDER BY ${orderBy(q.sort, q.dir, { date: 'p.txn_date', no: 'p.txn_no', amount: 'p.net_amount' }, 'p.txn_date')} , p.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        no: r.txn_no,
        date: r.txn_date,
        sup: r.supplier,
        crop: r.crop,
        qty: num(r.net_quantity),
        unit: r.unit,
        rate: num(r.rate),
        cpu: num(r.cost_per_unit),
        total: num(r.net_amount),
        status: r.status,
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

router.post(
  '/purchases',
  requirePermission('crop.purchase.create'),
  handler(async (req, res) => {
    const input = parseBody(purchaseSchema, req);
    const result = await withTransaction((client) =>
      createCropPurchase(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        input,
      })
    );
    created(res, result);
  })
);

router.post(
  '/purchases/:id/post',
  requirePermission('crop.purchase.post'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const result = await withTransaction((client) =>
      postCropPurchase(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        purchaseId: id,
      })
    );
    ok(res, result);
  })
);

router.post(
  '/purchases/:id/cancel',
  requirePermission('crop.purchase.cancel'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(
      z.object({ reason: z.string().trim().min(3, 'Give a reason for cancelling').max(300) }),
      req
    );
    const result = await withTransaction((client) =>
      cancelCropPurchase(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        purchaseId: id,
        reason: body.reason,
      })
    );
    ok(res, result);
  })
);

/* -------------------------------------------------------------------- sales */

const saleSchema = z.object({
  txnDate: z.string().date(),
  buyerCompanyId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive().optional(),
  valuationMethod: z.enum(['FIFO', 'WEIGHTED_AVERAGE']).default('FIFO'),
  transportCost: z.coerce.number().min(0).default(0),
  otherCost: z.coerce.number().min(0).default(0),
  paidAmount: z.coerce.number().min(0).default(0),
  lines: z
    .array(
      z.object({
        cropId: z.coerce.number().int().positive(),
        unitId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().positive('Quantity must be greater than zero'),
        rate: z.coerce.number().min(0),
      })
    )
    .min(1, 'Allocate at least one crop line'),
  action: z.enum(['DRAFT', 'POST']).default('DRAFT'),
});

/**
 * FIFO preview for the sales screen: which batches would be consumed, at what
 * cost, and the resulting profit -- without touching stock.
 */
router.post(
  '/sales/preview',
  requirePermission('crop.sale.view'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        cropId: z.coerce.number().int().positive(),
        warehouseId: z.coerce.number().int().positive().optional(),
        quantity: z.coerce.number().min(0),
        rate: z.coerce.number().min(0).default(0),
        valuationMethod: z.enum(['FIFO', 'WEIGHTED_AVERAGE']).default('FIFO'),
        transportCost: z.coerce.number().min(0).default(0),
        otherCost: z.coerce.number().min(0).default(0),
      }),
      req
    );

    const result = await withTransaction((client) =>
      previewAllocation(client, { orgId: req.orgId, ...body })
    );

    if (!canSeeProfit(req.user)) {
      delete result.profit;
      delete result.perUnitProfit;
      delete result.marginPct;
      delete result.cogs;
    }
    ok(res, result);
  })
);

router.get(
  '/sales',
  requirePermission('crop.sale.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);
    const showProfit = canSeeProfit(req.user);

    const params = [req.orgId];
    let where = 's.org_id = $1';
    if (q.from) {
      params.push(q.from);
      where += ` AND s.txn_date >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND s.txn_date <= $${params.length}`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM crop_sales s WHERE ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT s.id, s.txn_no, s.txn_date, co.name AS buyer, c.name AS crop,
              i.quantity, i.rate, s.net_amount, s.profit_amount, s.status,
              (SELECT string_agg(DISTINCT b.batch_no, ', ')
                 FROM crop_batch_allocations a JOIN crop_batches b ON b.id = a.batch_id
                WHERE a.sale_item_id = i.id) AS batches
         FROM crop_sales s
         JOIN companies co ON co.id = s.buyer_company_id
         LEFT JOIN crop_sale_items i ON i.sale_id = s.id AND i.line_no = 1
         LEFT JOIN crops c ON c.id = i.crop_id
        WHERE ${where}
        ORDER BY s.txn_date DESC, s.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        no: r.txn_no,
        date: r.txn_date,
        buyer: r.buyer,
        crop: r.crop,
        batch: r.batches || '',
        qty: num(r.quantity),
        rate: num(r.rate),
        amt: num(r.net_amount),
        profit: showProfit ? num(r.profit_amount) : null,
        status: r.status,
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

router.post(
  '/sales',
  requirePermission('crop.sale.create'),
  handler(async (req, res) => {
    const input = parseBody(saleSchema, req);
    const result = await withTransaction((client) =>
      createCropSale(client, { orgId: req.orgId, user: req.user, actor: req.actor, input })
    );
    created(res, result);
  })
);

router.post(
  '/sales/:id/post',
  requirePermission('crop.sale.post'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const result = await withTransaction((client) =>
      postCropSale(client, { orgId: req.orgId, user: req.user, actor: req.actor, saleId: id })
    );
    ok(res, result);
  })
);

router.post(
  '/sales/:id/cancel',
  requirePermission('crop.sale.cancel'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(
      z.object({ reason: z.string().trim().min(3).max(300) }),
      req
    );
    const result = await withTransaction((client) =>
      cancelCropSale(client, {
        orgId: req.orgId,
        user: req.user,
        actor: req.actor,
        saleId: id,
        reason: body.reason,
      })
    );
    ok(res, result);
  })
);

/* ------------------------------------------------------------------ batches */

router.get(
  '/batches',
  requirePermission('inventory.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT b.id, b.batch_no, c.name AS crop, g.name AS grade, w.name AS warehouse,
              b.quantity_received, b.quantity_remaining, b.cost_per_unit, b.received_on,
              s.name AS supplier, (CURRENT_DATE - b.received_on)::int AS age_days
         FROM crop_batches b
         JOIN crops c ON c.id = b.crop_id
         LEFT JOIN crop_grades g ON g.id = b.grade_id
         JOIN warehouses w ON w.id = b.warehouse_id
         LEFT JOIN suppliers s ON s.id = b.supplier_id
        WHERE b.org_id = $1 AND b.is_active AND b.quantity_remaining > 0
        ORDER BY b.received_on DESC`,
      [req.orgId]
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        batchNo: r.batch_no,
        crop: r.crop,
        grade: r.grade || '',
        warehouse: r.warehouse,
        received: num(r.quantity_received),
        remaining: num(r.quantity_remaining),
        costPerUnit: num(r.cost_per_unit),
        receivedOn: r.received_on,
        ageDays: Number(r.age_days),
        supplier: r.supplier || '',
      }))
    );
  })
);

export default router;
