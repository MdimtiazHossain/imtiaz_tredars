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
import { requirePermission, canSeeProfit } from '../middleware/auth.js';
import {
  createDealerPurchase,
  postDealerPurchase,
  cancelDealerPurchase,
  createDealerSale,
  postDealerSale,
  cancelDealerSale,
  computePurchaseTotals,
  computeSaleTotals,
} from '../services/dealerService.js';

/** Dealer business: stock from principal companies, sold on to the trade. */
const router = Router();

/* -------------------------------------------------------------- purchases */

const purchaseSchema = z.object({
  txnDate: z.string().date(),
  companyId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive(),
  supplierInvoiceNo: z.string().trim().max(60).optional(),
  paymentTerms: z.string().max(80).optional(),
  transportCost: z.coerce.number().min(0).default(0),
  otherCost: z.coerce.number().min(0).default(0),
  lines: z
    .array(
      z.object({
        productId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().positive('Quantity must be greater than zero'),
        freeQuantity: z.coerce.number().min(0).default(0),
        rate: z.coerce.number().min(0),
        discountPct: z.coerce.number().min(0).max(100).default(0),
      })
    )
    .min(1, 'Add at least one item'),
  action: z.enum(['DRAFT', 'POST']).default('DRAFT'),
});

router.post(
  '/purchases/preview',
  requirePermission('dealer.purchase.view'),
  handler(async (req, res) => {
    const body = parseBody(purchaseSchema.partial({ companyId: true, warehouseId: true }), req);
    ok(res, computePurchaseTotals(body));
  })
);

router.get(
  '/purchases',
  requirePermission('dealer.purchase.view'),
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

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM dealer_purchases p WHERE ${where}`,
      params
    );
    const { rows } = await query(
      `SELECT p.id, p.txn_no, p.txn_date, c.name AS company, p.supplier_invoice_no,
              w.name AS warehouse, p.net_amount, p.status
         FROM dealer_purchases p
         JOIN companies c ON c.id = p.company_id
         JOIN warehouses w ON w.id = p.warehouse_id
        WHERE ${where}
        ORDER BY p.txn_date DESC, p.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        no: r.txn_no,
        date: r.txn_date,
        company: r.company,
        invoiceNo: r.supplier_invoice_no || '',
        warehouse: r.warehouse,
        amount: num(r.net_amount),
        status: r.status,
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

router.post(
  '/purchases',
  requirePermission('dealer.purchase.create'),
  handler(async (req, res) => {
    const input = parseBody(purchaseSchema, req);
    const result = await withTransaction((client) =>
      createDealerPurchase(client, { orgId: req.orgId, user: req.user, actor: req.actor, input })
    );
    created(res, result);
  })
);

router.post(
  '/purchases/:id/post',
  requirePermission('dealer.purchase.post'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const result = await withTransaction((client) =>
      postDealerPurchase(client, {
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
  requirePermission('dealer.purchase.cancel'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3).max(300) }), req);
    const result = await withTransaction((client) =>
      cancelDealerPurchase(client, {
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

/* ------------------------------------------------------------------ sales */

const saleSchema = z.object({
  txnDate: z.string().date(),
  customerId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive(),
  salespersonId: z.coerce.number().int().positive().optional(),
  paymentTerms: z.string().max(80).optional(),
  paidAmount: z.coerce.number().min(0).default(0),
  lines: z
    .array(
      z.object({
        productId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().positive('Quantity must be greater than zero'),
        bonusQuantity: z.coerce.number().min(0).default(0),
        rate: z.coerce.number().min(0),
        discountPct: z.coerce.number().min(0).max(100).default(0),
      })
    )
    .min(1, 'Add at least one item'),
  action: z.enum(['DRAFT', 'POST']).default('DRAFT'),
});

/**
 * Invoice preview. Costs come from the live weighted average on the stock row,
 * so the margin shown on screen is the margin that will be posted.
 */
router.post(
  '/sales/preview',
  requirePermission('dealer.sale.view'),
  handler(async (req, res) => {
    const body = parseBody(saleSchema.partial({ customerId: true }), req);

    const { rows } = await query(
      `SELECT product_id, avg_cost FROM stock
        WHERE warehouse_id = $1 AND item_type = 'PRODUCT' AND product_id = ANY($2::bigint[])`,
      [body.warehouseId, body.lines.map((l) => l.productId)]
    );
    const costMap = new Map(rows.map((r) => [Number(r.product_id), num(r.avg_cost)]));
    const totals = computeSaleTotals(body, (pid) => costMap.get(Number(pid)) || 0);

    if (!canSeeProfit(req.user)) {
      delete totals.cost;
      delete totals.profit;
      delete totals.margin;
      totals.lines = totals.lines.map(({ unitCost: _u, lineCost: _c, ...rest }) => rest);
    }
    ok(res, totals);
  })
);

router.get(
  '/sales',
  requirePermission('dealer.sale.view'),
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
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (s.txn_no ILIKE $${params.length} OR c.name ILIKE $${params.length})`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM dealer_sales s
         JOIN customers c ON c.id = s.customer_id WHERE ${where}`,
      params
    );
    const { rows } = await query(
      `SELECT s.id, s.txn_no, s.txn_date, c.name AS customer, s.net_amount,
              s.paid_amount, s.profit_amount, s.status,
              COALESCE(r.balance, 0) AS due,
              (SELECT COUNT(*)::int FROM dealer_sale_items i WHERE i.sale_id = s.id) AS item_count
         FROM dealer_sales s
         JOIN customers c ON c.id = s.customer_id
         LEFT JOIN receivables r ON r.invoice_type = 'dealer_sales' AND r.invoice_id = s.id
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
        customer: r.customer,
        items: Number(r.item_count),
        amount: num(r.net_amount),
        paid: num(r.paid_amount),
        due: num(r.due),
        profit: showProfit ? num(r.profit_amount) : null,
        status: r.status,
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

router.post(
  '/sales',
  requirePermission('dealer.sale.create'),
  handler(async (req, res) => {
    const input = parseBody(saleSchema, req);
    const result = await withTransaction((client) =>
      createDealerSale(client, { orgId: req.orgId, user: req.user, actor: req.actor, input })
    );
    created(res, result);
  })
);

router.post(
  '/sales/:id/post',
  requirePermission('dealer.sale.post'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const result = await withTransaction((client) =>
      postDealerSale(client, { orgId: req.orgId, user: req.user, actor: req.actor, saleId: id })
    );
    ok(res, result);
  })
);

router.post(
  '/sales/:id/cancel',
  requirePermission('dealer.sale.cancel'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3).max(300) }), req);
    const result = await withTransaction((client) =>
      cancelDealerSale(client, {
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

export default router;
