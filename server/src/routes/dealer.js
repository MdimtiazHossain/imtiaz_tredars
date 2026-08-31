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
import { notFound } from '../lib/errors.js';
import { taxDocument } from '../services/taxService.js';
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
    // Taxed the same way posting would tax it. A preview exists to say what a
    // document will come to, and one that leaves the VAT off says a number
    // nobody will ever be invoiced.
    const totals = await withTransaction((client) =>
      taxDocument(client, {
        orgId: req.orgId,
        input: body,
        priced: computePurchaseTotals(body),
        table: 'products',
        itemIdOf: (l) => l.productId,
        side: 'PURCHASE',
      })
    );
    ok(res, previewShape(totals));
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
    const priced = computeSaleTotals(body, (pid) => costMap.get(Number(pid)) || 0);
    const totals = await withTransaction((client) =>
      taxDocument(client, {
        orgId: req.orgId,
        input: body,
        priced,
        table: 'products',
        itemIdOf: (l) => l.productId,
        side: 'SALE',
      })
    );
    // Profit is on the goods; the tax was never the business's to earn.
    totals.profit = totals.net - totals.cost;
    totals.margin = totals.net ? (totals.profit / totals.net) * 100 : 0;
    totals.due = totals.total - num(body.paidAmount);

    if (!canSeeProfit(req.user)) {
      delete totals.cost;
      delete totals.profit;
      delete totals.margin;
      totals.lines = totals.lines.map(({ unitCost: _u, lineCost: _c, ...rest }) => rest);
    }
    ok(res, previewShape(totals));
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
              s.tax_amount, s.total_amount,
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
        // What the invoice is worth to the customer, tax included.
        amount: num(r.total_amount) || num(r.net_amount),
        tax: num(r.tax_amount),
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

/**
 * One invoice, whole, for looking at and for printing.
 *
 * The listing above is a row per document; this is the document. It carries the
 * seller's own details as well as the buyer's, because an invoice handed to a
 * customer has to name who issued it, and the letterhead is the organisation
 * record rather than anything typed into a template.
 *
 * Profit is on the row for the business's own eyes and is never part of an
 * invoice, so it is not returned here at all -- not even to a user who may see
 * profit elsewhere.
 */
router.get(
  '/sales/:id',
  requirePermission('dealer.sale.view'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);

    const { rows: header } = await query(
      `SELECT s.id, s.txn_no, to_char(s.txn_date, 'DD Mon YYYY') AS txn_date,
              to_char(s.txn_date, 'YYYY-MM-DD') AS txn_iso,
              s.payment_terms, s.gross_amount, s.discount_amount, s.net_amount,
              s.tax_amount, s.total_amount, s.tax_inclusive,
              s.paid_amount, s.status,
              c.code AS customer_code, c.name AS customer, c.name_bn AS customer_bn,
              c.mobile AS customer_mobile, c.bin_no AS customer_bin,
              c.district, c.upazila, c.credit_days,
              w.name AS warehouse, e.name AS salesperson,
              COALESCE(r.balance, 0) AS due,
              to_char(r.due_date, 'DD Mon YYYY') AS due_date,
              o.name AS org_name, o.trade_licence_no, o.bin_no, o.head_office,
              o.mobile AS org_mobile, o.email AS org_email, o.currency_code
         FROM dealer_sales s
         JOIN customers c      ON c.id = s.customer_id
         JOIN warehouses w     ON w.id = s.warehouse_id
         JOIN organizations o  ON o.id = s.org_id
         LEFT JOIN employees e ON e.id = s.salesperson_id
         LEFT JOIN receivables r ON r.invoice_type = 'dealer_sales' AND r.invoice_id = s.id
        WHERE s.id = $1 AND s.org_id = $2`,
      [id, req.orgId]
    );
    if (!header.length) throw notFound('Invoice');
    const h = header[0];

    const { rows: lines } = await query(
      `SELECT i.line_no, p.code, p.name, u.code AS unit, b.name AS brand,
              i.quantity, i.bonus_quantity, i.rate, i.discount_pct, i.line_net,
              i.tax_rate, i.tax_amount
         FROM dealer_sale_items i
         JOIN products p    ON p.id = i.product_id
         JOIN units u       ON u.id = p.unit_id
         LEFT JOIN brands b ON b.id = p.brand_id
        WHERE i.sale_id = $1
        ORDER BY i.line_no`,
      [id]
    );

    ok(res, {
      id: Number(h.id),
      no: h.txn_no,
      date: h.txn_date,
      dateIso: h.txn_iso,
      status: h.status,
      terms: h.payment_terms || '',
      dueDate: h.due_date || '',
      warehouse: h.warehouse,
      salesperson: h.salesperson || '',
      // Who it is issued to.
      customer: {
        code: h.customer_code,
        name: h.customer,
        bn: h.customer_bn || '',
        mobile: h.customer_mobile || '',
        address: [h.upazila, h.district].filter(Boolean).join(', '),
        creditDays: Number(h.credit_days) || 0,
        // A registered buyer's BIN belongs on the challanpatra; it is what
        // lets them claim the tax on it back.
        binNo: h.customer_bin || '',
      },
      // Who issued it. An invoice without this is not an invoice.
      org: {
        name: h.org_name,
        tradeLicenceNo: h.trade_licence_no || '',
        binNo: h.bin_no || '',
        headOffice: h.head_office || '',
        mobile: h.org_mobile || '',
        email: h.org_email || '',
        currency: h.currency_code,
      },
      lines: lines.map((l) => ({
        lineNo: Number(l.line_no),
        code: l.code,
        name: l.name,
        brand: l.brand || '',
        unit: l.unit,
        quantity: num(l.quantity),
        bonus: num(l.bonus_quantity),
        rate: num(l.rate),
        discountPct: num(l.discount_pct),
        amount: num(l.line_net),
        taxRate: num(l.tax_rate),
        tax: num(l.tax_amount),
      })),
      totals: {
        gross: num(h.gross_amount),
        discount: num(h.discount_amount),
        // `net` is the taxable value and `total` is what is owed; before VAT
        // was modelled they were the same number and every invoice still
        // prints correctly when they are.
        net: num(h.net_amount),
        tax: num(h.tax_amount),
        total: num(h.total_amount) || num(h.net_amount),
        // One rate reads as "VAT 15%" on the invoice; a mixed one cannot.
        taxLabel: taxLabelFor(lines),
        paid: num(h.paid_amount),
        due: num(h.due),
      },
    });
  })
);

/** How the tax line reads: named where one rate applies, generic where several do. */
function taxLabelFor(lines) {
  const rates = new Set(lines.map((l) => num(l.tax_rate)).filter((r) => r > 0));
  return rates.size === 1 ? `VAT ${[...rates][0]}%` : 'VAT';
}

/**
 * What a preview hands back.
 *
 * The tax context is loaded to work the figures out and has no business
 * leaving the server -- it carries every rate the organisation holds, which is
 * master data the caller can ask for directly if it wants it.
 */
function previewShape({ context: _context, ...totals }) {
  return totals;
}

export default router;
