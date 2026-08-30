import { Router } from 'express';
import { z } from 'zod';
import { query, num } from '../lib/db.js';
import { handler, ok, parseQuery, listQuerySchema, paginate, pageMeta } from '../lib/http.js';
import { requirePermission, canSeeProfit } from '../middleware/auth.js';
import { forbidden, notFound } from '../lib/errors.js';
import { col, dateAndBusiness } from './reportHelpers.js';
import { buildWorkbook, buildPdf, exportFilename, describeFilters } from '../lib/export.js';
import { MORE_REPORTS } from './reportDefinitions.js';

/**
 * Reporting.
 *
 * Every report is aggregated in PostgreSQL and filtered server-side. The
 * browser receives a page of rows and a totals block, never a raw table, so
 * report size is independent of how many transactions exist.
 *
 * Profit columns are stripped for roles without `report.profit`, so hiding
 * them is enforced here rather than only in the UI.
 */
const router = Router();


/** Shared filter shape across every report. */
const reportQuery = listQuerySchema.extend({
  warehouseId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  companyId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  cropId: z.coerce.number().int().positive().optional(),
  employeeId: z.coerce.number().int().positive().optional(),
});


/* ---------------------------------------------------------------- dashboard */

/**
 * Dashboard aggregates.
 *
 * The business-type filter is applied in SQL, so "All" is exactly the sum of
 * "Dealer" and "Bulk Crop" — the reconciliation the brief calls for.
 */
router.get(
  '/dashboard',
  requirePermission('dashboard.view'),
  handler(async (req, res) => {
    const q = parseQuery(reportQuery, req);
    const showProfit = canSeeProfit(req.user);
    const bt = q.businessType === 'ALL' ? null : q.businessType;

    const [sales, purchases, receivable, payable, stock, cash, aging, monthly] =
      await Promise.all([
        query(
          `SELECT COALESCE(SUM(sales_amount), 0) AS amount,
                  COALESCE(SUM(cost_amount), 0)  AS cost,
                  COALESCE(SUM(profit_amount), 0) AS profit,
                  COALESCE(SUM(document_count), 0) AS documents
             FROM v_sales_by_business
            WHERE org_id = $1
              AND ($2::business_type IS NULL OR business_type = $2)
              AND ($3::date IS NULL OR txn_date >= $3)
              AND ($4::date IS NULL OR txn_date <= $4)`,
          [req.orgId, bt, q.from ?? null, q.to ?? null]
        ),
        query(
          `SELECT COALESCE(SUM(purchase_amount), 0) AS amount,
                  COALESCE(SUM(document_count), 0) AS documents
             FROM v_purchases_by_business
            WHERE org_id = $1
              AND ($2::business_type IS NULL OR business_type = $2)
              AND ($3::date IS NULL OR txn_date >= $3)
              AND ($4::date IS NULL OR txn_date <= $4)`,
          [req.orgId, bt, q.from ?? null, q.to ?? null]
        ),
        query(
          `SELECT COALESCE(SUM(balance), 0) AS amount, COUNT(*)::int AS documents
             FROM receivables
            WHERE org_id = $1 AND NOT is_settled
              AND ($2::business_type IS NULL OR business_type = $2)`,
          [req.orgId, bt]
        ),
        query(
          `SELECT COALESCE(SUM(balance), 0) AS amount, COUNT(*)::int AS documents
             FROM payables
            WHERE org_id = $1 AND NOT is_settled
              AND ($2::business_type IS NULL OR business_type = $2)`,
          [req.orgId, bt]
        ),
        query(
          `SELECT
             COALESCE(SUM(CASE WHEN s.item_type = 'CROP_BATCH'
                               THEN s.quantity * b.cost_per_unit END), 0) AS crop_value,
             COALESCE(SUM(CASE WHEN s.item_type = 'PRODUCT'
                               THEN s.quantity * s.avg_cost END), 0)      AS product_value,
             COUNT(*) FILTER (WHERE s.item_type = 'CROP_BATCH')::int      AS batches
             FROM stock s
             LEFT JOIN crop_batches b ON b.id = s.batch_id
            WHERE s.org_id = $1 AND s.quantity > 0`,
          [req.orgId]
        ),
        query(
          `SELECT COALESCE(SUM(a.opening_balance), 0)
                  + COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger_entries l
                               WHERE l.account_id IS NOT NULL), 0) AS balance,
                  COUNT(*)::int AS accounts
             FROM accounts a WHERE a.org_id = $1 AND a.is_active`,
          [req.orgId]
        ),
        query(
          `SELECT aging_bucket, COALESCE(SUM(balance), 0) AS amount
             FROM v_receivable_aging
            WHERE org_id = $1 AND ($2::business_type IS NULL OR business_type = $2)
            GROUP BY aging_bucket`,
          [req.orgId, bt]
        ),
        query(
          `SELECT to_char(txn_date, 'YYYY-MM') AS month,
                  COALESCE(SUM(sales_amount), 0) AS sales,
                  COALESCE(SUM(profit_amount), 0) AS profit
             FROM v_sales_by_business
            WHERE org_id = $1 AND ($2::business_type IS NULL OR business_type = $2)
              AND txn_date >= (CURRENT_DATE - interval '6 months')
            GROUP BY 1 ORDER BY 1`,
          [req.orgId, bt]
        ),
      ]);

    const purchaseMonthly = await query(
      `SELECT to_char(txn_date, 'YYYY-MM') AS month,
              COALESCE(SUM(purchase_amount), 0) AS purchase
         FROM v_purchases_by_business
        WHERE org_id = $1 AND ($2::business_type IS NULL OR business_type = $2)
          AND txn_date >= (CURRENT_DATE - interval '6 months')
        GROUP BY 1 ORDER BY 1`,
      [req.orgId, bt]
    );

    const purchaseByMonth = new Map(
      purchaseMonthly.rows.map((r) => [r.month, num(r.purchase)])
    );
    const salesByMonth = new Map(
      monthly.rows.map((r) => [r.month, { sales: num(r.sales), profit: num(r.profit) }])
    );

    // Take every month that saw either sales or purchases. Driving this from
    // the sales months alone would drop a month of pure procurement -- and the
    // chart's purchase total would then disagree with the headline figure.
    const trendMonths = [...new Set([...salesByMonth.keys(), ...purchaseByMonth.keys()])].sort();

    const agingBuckets = {};
    for (const r of aging.rows) agingBuckets[r.aging_bucket] = num(r.amount);

    const payload = {
      businessType: q.businessType,
      sales: {
        amount: num(sales.rows[0].amount),
        documents: Number(sales.rows[0].documents),
      },
      purchases: {
        amount: num(purchases.rows[0].amount),
        documents: Number(purchases.rows[0].documents),
      },
      receivable: {
        amount: num(receivable.rows[0].amount),
        documents: receivable.rows[0].documents,
      },
      payable: { amount: num(payable.rows[0].amount), documents: payable.rows[0].documents },
      // Stock is held per business line: dealer products against BULK_CROP
      // batches. `totalValue` therefore follows the filter, so the Dealer and
      // Bulk Crop panels do not both report the same figure.
      stock: {
        cropValue: num(stock.rows[0].crop_value),
        productValue: num(stock.rows[0].product_value),
        totalValue:
          bt === 'DEALER'
            ? num(stock.rows[0].product_value)
            : bt === 'BULK_CROP'
              ? num(stock.rows[0].crop_value)
              : num(stock.rows[0].crop_value) + num(stock.rows[0].product_value),
        batches: bt === 'DEALER' ? 0 : stock.rows[0].batches,
      },
      cash: { balance: num(cash.rows[0].balance), accounts: cash.rows[0].accounts },
      aging: agingBuckets,
      trend: trendMonths.map((month) => {
        const sale = salesByMonth.get(month);
        return {
          month,
          sales: sale ? sale.sales : 0,
          purchase: purchaseByMonth.get(month) || 0,
          profit: showProfit ? (sale ? sale.profit : 0) : null,
        };
      }),
    };

    if (showProfit) {
      payload.grossProfit = {
        amount: num(sales.rows[0].profit),
        cost: num(sales.rows[0].cost),
        marginPct: num(sales.rows[0].amount)
          ? (num(sales.rows[0].profit) / num(sales.rows[0].amount)) * 100
          : 0,
      };
    }

    ok(res, payload);
  })
);

/* ------------------------------------------------------------------ reports */

/** Report definitions: each returns { columns, rows, totals }. */
const REPORTS = {
  'sales-customer': {
    order: 3,
    group: 'Sales',
    label: 'Customer-wise sales',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 's');
      const { rows } = await query(
        `SELECT c.name AS customer, c.district, COUNT(*)::int AS invoices,
                COALESCE(SUM(s.net_amount), 0) AS sales,
                COALESCE(SUM(s.profit_amount), 0) AS profit
           FROM dealer_sales s JOIN customers c ON c.id = s.customer_id
          WHERE s.org_id = $1 AND s.status = 'POSTED' ${where}
          GROUP BY c.id, c.name, c.district
          ORDER BY sales DESC`,
        params
      );
      return {
        columns: [
          col('customer', 'Customer'),
          col('district', 'District'),
          col('invoices', 'Invoices', 'number'),
          col('sales', 'Sales', 'money'),
          col('profit', 'Profit', 'money'),
        ],
        rows: rows.map((r) => ({
          customer: r.customer,
          district: r.district,
          invoices: r.invoices,
          sales: num(r.sales),
          profit: num(r.profit),
        })),
        totals: { sales: rows.reduce((t, r) => t + num(r.sales), 0) },
      };
    },
  },

  'sales-product': {
    order: 4,
    group: 'Sales',
    label: 'Product-wise sales',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 's');
      const { rows } = await query(
        `SELECT p.name AS product, pc.name AS category,
                COALESCE(SUM(i.quantity), 0) AS qty,
                COALESCE(SUM(i.line_net), 0) AS sales,
                COALESCE(SUM(i.line_cost), 0) AS cost
           FROM dealer_sale_items i
           JOIN dealer_sales s ON s.id = i.sale_id
           JOIN products p ON p.id = i.product_id
           LEFT JOIN product_categories pc ON pc.id = p.category_id
          WHERE s.org_id = $1 AND s.status = 'POSTED' ${where}
          GROUP BY p.id, p.name, pc.name
          ORDER BY sales DESC`,
        params
      );
      return {
        columns: [
          col('product', 'Product'),
          col('category', 'Category'),
          col('qty', 'Qty sold', 'number'),
          col('sales', 'Sales', 'money'),
          col('cost', 'Cost', 'money'),
          col('profit', 'Profit', 'money'),
          col('marginPct', 'Margin', 'percent'),
        ],
        rows: rows.map((r) => {
          const sales = num(r.sales);
          const cost = num(r.cost);
          return {
            product: r.product,
            category: r.category,
            qty: num(r.qty),
            sales,
            cost,
            profit: sales - cost,
            marginPct: sales ? ((sales - cost) / sales) * 100 : 0,
          };
        }),
        totals: { sales: rows.reduce((t, r) => t + num(r.sales), 0) },
      };
    },
  },

  'pur-supplier': {
    order: 6,
    group: 'Purchase',
    label: 'Supplier-wise purchase',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 'p');
      const { rows } = await query(
        `SELECT s.name AS supplier, s.supplier_type, s.district,
                COALESCE(SUM(p.net_amount), 0) AS purchase,
                COALESCE(MAX(o.paid_amount), 0) AS paid,
                COALESCE(MAX(o.outstanding), 0) AS outstanding
           FROM crop_purchases p
           JOIN suppliers s ON s.id = p.supplier_id
           LEFT JOIN v_supplier_outstanding o ON o.supplier_id = s.id
          WHERE p.org_id = $1 AND p.status = 'POSTED' ${where}
          GROUP BY s.id, s.name, s.supplier_type, s.district
          ORDER BY purchase DESC`,
        params
      );
      return {
        columns: [
          col('supplier', 'Supplier'),
          col('type', 'Type'),
          col('district', 'District'),
          col('purchase', 'Purchase value', 'money'),
          col('paid', 'Paid', 'money'),
          col('outstanding', 'Outstanding', 'money'),
        ],
        rows: rows.map((r) => ({
          supplier: r.supplier,
          type: r.supplier_type,
          district: r.district,
          purchase: num(r.purchase),
          paid: num(r.paid),
          outstanding: num(r.outstanding),
        })),
        totals: { purchase: rows.reduce((t, r) => t + num(r.purchase), 0) },
      };
    },
  },

  'crop-batch-profit': {
    order: 12,
    group: 'Profit',
    label: 'Batch-wise crop profit',
    permission: 'report.profit',
    async run(req) {
      const { rows } = await query(
        `SELECT b.batch_no, c.name AS crop, s.name AS supplier,
                b.quantity_received, b.cost_per_unit,
                COALESCE(SUM(a.quantity), 0) AS sold_qty,
                COALESCE(SUM(a.cost_value), 0) AS cogs,
                COALESCE(SUM(a.quantity * i.rate), 0) AS revenue
           FROM crop_batches b
           JOIN crops c ON c.id = b.crop_id
           LEFT JOIN suppliers s ON s.id = b.supplier_id
           LEFT JOIN crop_batch_allocations a ON a.batch_id = b.id
           LEFT JOIN crop_sale_items i ON i.id = a.sale_item_id
          WHERE b.org_id = $1
          GROUP BY b.id, b.batch_no, c.name, s.name, b.quantity_received, b.cost_per_unit
          ORDER BY b.received_on DESC`,
        [req.orgId]
      );
      return {
        columns: [
          col('batch', 'Batch', 'code'),
          col('crop', 'Crop'),
          col('supplier', 'Supplier'),
          col('purchased', 'Purchased', 'number'),
          col('sold', 'Sold', 'number'),
          col('landedCost', 'Landed cost', 'money'),
          col('revenue', 'Revenue', 'money'),
          col('profit', 'Profit', 'money'),
        ],
        rows: rows.map((r) => {
          const revenue = num(r.revenue);
          const cogs = num(r.cogs);
          return {
            batch: r.batch_no,
            crop: r.crop,
            supplier: r.supplier,
            purchased: num(r.quantity_received),
            sold: num(r.sold_qty),
            landedCost: num(r.cost_per_unit),
            revenue,
            profit: revenue - cogs,
            profitPerUnit: num(r.sold_qty) ? (revenue - cogs) / num(r.sold_qty) : 0,
          };
        }),
        totals: {
          profit: rows.reduce((t, r) => t + (num(r.revenue) - num(r.cogs)), 0),
        },
      };
    },
  },

  'fin-aging': {
    order: 16,
    group: 'Finance',
    label: 'Customer outstanding & aging',
    permission: 'report.view',
    async run(req, q) {
      const bt = q.businessType === 'ALL' ? null : q.businessType;
      const { rows } = await query(
        `SELECT COALESCE(c.name, co.name) AS party,
                COALESCE(c.customer_type, 'Company') AS type,
                COALESCE(MAX(c.credit_limit), 0) AS credit_limit,
                COALESCE(SUM(a.balance) FILTER (WHERE a.aging_bucket = '0-30'), 0)   AS b0,
                COALESCE(SUM(a.balance) FILTER (WHERE a.aging_bucket = '31-60'), 0)  AS b31,
                COALESCE(SUM(a.balance) FILTER (WHERE a.aging_bucket = '61-90'), 0)  AS b61,
                COALESCE(SUM(a.balance) FILTER (WHERE a.aging_bucket = '91-120'), 0) AS b91,
                COALESCE(SUM(a.balance) FILTER (WHERE a.aging_bucket = '120+'), 0)   AS b120,
                COALESCE(SUM(a.balance), 0) AS total
           FROM v_receivable_aging a
           LEFT JOIN customers c ON a.party_type = 'CUSTOMER' AND c.id = a.party_id
           LEFT JOIN companies co ON a.party_type = 'COMPANY' AND co.id = a.party_id
          WHERE a.org_id = $1 AND ($2::business_type IS NULL OR a.business_type = $2)
          GROUP BY COALESCE(c.name, co.name), COALESCE(c.customer_type, 'Company')
          ORDER BY total DESC`,
        [req.orgId, bt]
      );
      return {
        columns: [
          col('party', 'Party'),
          col('type', 'Type'),
          col('creditLimit', 'Credit limit', 'money'),
          col('b0', '0–30', 'money'),
          col('b31', '31–60', 'money'),
          col('b61', '61–90', 'money'),
          col('b91', '91–120', 'money'),
          col('b120', '120+', 'money'),
          col('total', 'Total due', 'money'),
        ],
        rows: rows.map((r) => ({
          party: r.party,
          type: r.type,
          creditLimit: num(r.credit_limit),
          b0: num(r.b0),
          b31: num(r.b31),
          b61: num(r.b61),
          b91: num(r.b91),
          b120: num(r.b120),
          total: num(r.total),
        })),
        totals: { receivable: rows.reduce((t, r) => t + num(r.total), 0) },
      };
    },
  },

  'inv-dead': {
    order: 11,
    group: 'Inventory',
    label: 'Dead stock',
    permission: 'report.view',
    async run(req) {
      const { rows } = await query(
        `SELECT b.batch_no, c.name AS crop, w.name AS warehouse, b.quantity_remaining,
                b.cost_per_unit, (CURRENT_DATE - b.received_on)::int AS age_days
           FROM crop_batches b
           JOIN crops c ON c.id = b.crop_id
           JOIN warehouses w ON w.id = b.warehouse_id
          WHERE b.org_id = $1 AND b.is_active AND b.quantity_remaining > 0
            AND b.received_on < CURRENT_DATE - 60
          ORDER BY b.received_on ASC`,
        [req.orgId]
      );
      return {
        columns: [
          col('batch', 'Batch', 'code'),
          col('crop', 'Crop'),
          col('warehouse', 'Warehouse'),
          col('remaining', 'Remaining', 'number'),
          col('costPerUnit', 'Cost/unit', 'money'),
          col('ageDays', 'Age (days)', 'number'),
          col('value', 'Value', 'money'),
        ],
        rows: rows.map((r) => ({
          batch: r.batch_no,
          crop: r.crop,
          warehouse: r.warehouse,
          remaining: num(r.quantity_remaining),
          costPerUnit: num(r.cost_per_unit),
          ageDays: Number(r.age_days),
          value: num(r.quantity_remaining) * num(r.cost_per_unit),
        })),
        totals: {
          value: rows.reduce(
            (t, r) => t + num(r.quantity_remaining) * num(r.cost_per_unit),
            0
          ),
        },
      };
    },
  },

  'fin-expense': {
    order: 19,
    group: 'Finance',
    label: 'Expense register',
    permission: 'expense.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 'e');
      const { rows } = await query(
        `SELECT ec.name AS category, e.business_type, COUNT(*)::int AS vouchers,
                COALESCE(SUM(e.amount), 0) AS amount
           FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
          WHERE e.org_id = $1 AND e.status = 'POSTED' ${where}
          GROUP BY ec.name, e.business_type
          ORDER BY amount DESC`,
        params
      );
      return {
        columns: [
          col('category', 'Category'),
          col('businessType', 'Business'),
          col('vouchers', 'Vouchers', 'number'),
          col('amount', 'Amount', 'money'),
        ],
        rows: rows.map((r) => ({
          category: r.category,
          businessType: r.business_type || 'Shared',
          vouchers: r.vouchers,
          amount: num(r.amount),
        })),
        totals: { amount: rows.reduce((t, r) => t + num(r.amount), 0) },
      };
    },
  },
};

/**
 * The catalogue is derived from the definitions rather than maintained
 * alongside them: a hand-written list drifts, and advertising a report the
 * server cannot produce is worse than not listing it.
 */
/** The full registry: the definitions above plus the rest of the catalogue. */
const ALL_REPORTS = { ...REPORTS, ...MORE_REPORTS };

const GROUP_ORDER = ['Sales', 'Purchase', 'Inventory', 'Profit', 'Finance'];

function buildCatalogue(user) {
  const groups = new Map();

  for (const [id, def] of Object.entries(ALL_REPORTS)) {
    // Do not offer a report this user would be refused.
    if (def.permission && !user.permissions.includes(def.permission)) continue;
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push({ id, label: def.label, order: def.order ?? 999 });
  }

  // Present them in the order the design lays out rather than insertion order.
  return GROUP_ORDER.filter((g) => groups.has(g)).map((group) => ({
    group,
    items: groups
      .get(group)
      .sort((a, b) => a.order - b.order)
      .map(({ id, label }) => ({ id, label })),
  }));
}

router.get(
  '/catalogue',
  requirePermission('report.view'),
  handler(async (req, res) => {
    ok(res, buildCatalogue(req.user));
  })
);

/**
 * Export a report as .xlsx or .pdf.
 *
 * Deliberately unpaged: a page is a screen concern, a file is the whole
 * answer. It runs the same definition the screen does, so an export cannot
 * show different numbers from the table it came from, and it enforces the same
 * permission — a role that cannot view a report cannot download it either.
 */
router.get(
  '/:reportId/export',
  requirePermission('report.view'),
  handler(async (req, res) => {
    const definition = ALL_REPORTS[req.params.reportId];
    if (!definition) throw notFound(`Report "${req.params.reportId}"`);
    if (definition.permission && !req.user.permissions.includes(definition.permission)) {
      throw forbidden('Your role does not allow you to export this report.');
    }

    const q = parseQuery(
      reportQuery.extend({ format: z.enum(['xlsx', 'pdf']).default('xlsx') }),
      req
    );

    const result = await definition.run(req, q);
    const report = {
      title: definition.label,
      subtitle: describeFilters(q),
      columns: result.columns,
      rows: result.rows,
      totals: result.totals,
    };

    const pdf = q.format === 'pdf';
    const filename = exportFilename(definition.label, pdf ? 'pdf' : 'xlsx');
    const body = pdf ? await buildPdf(report) : await buildWorkbook(report);

    res.setHeader(
      'content-type',
      pdf
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('content-length', Buffer.byteLength(body));
    res.send(Buffer.from(body));
  })
);

router.get(
  '/:reportId',
  requirePermission('report.view'),
  handler(async (req, res) => {
    const definition = ALL_REPORTS[req.params.reportId];
    if (!definition) {
      throw notFound(`Report "${req.params.reportId}"`);
    }
    if (definition.permission && !req.user.permissions.includes(definition.permission)) {
      throw forbidden('Your role does not allow you to view this report.');
    }

    const q = parseQuery(reportQuery, req);
    const result = await definition.run(req, q);

    // Page in memory: these aggregates are already grouped and small.
    const { limit, offset } = paginate(q.page, q.pageSize);
    const page = result.rows.slice(offset, offset + limit);

    ok(
      res,
      { columns: result.columns, rows: page, totals: result.totals },
      pageMeta(q.page, q.pageSize, result.rows.length)
    );
  })
);

export default router;
