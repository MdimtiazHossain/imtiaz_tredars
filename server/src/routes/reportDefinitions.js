import { query, num } from '../lib/db.js';
import { col, dateAndBusiness } from './reportHelpers.js';
import { profitAndLoss } from '../services/statementService.js';

/**
 * The rest of the Reports Centre.
 *
 * `reports.js` holds the first set; these complete the catalogue the design
 * lays out. Splitting them keeps either file readable — the shape is identical,
 * and `reports.js` merges the two into one registry.
 *
 * Each definition declares:
 *   order       position within its group, following the design's sequence
 *   group       sidebar heading
 *   label       sidebar text
 *   permission  what the caller must hold; the catalogue hides the rest
 *   run(req, q) returns { columns, rows, totals }
 */
export const MORE_REPORTS = {
  /* ------------------------------------------------------------------ sales */

  'sales-daily': {
    order: 1,
    group: 'Sales',
    label: 'Daily sales',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 'v');
      const { rows } = await query(
        `SELECT v.txn_date,
                COALESCE(SUM(v.sales_amount) FILTER (WHERE v.business_type = 'DEALER'), 0)    AS dealer,
                COALESCE(SUM(v.sales_amount) FILTER (WHERE v.business_type = 'BULK_CROP'), 0) AS crop,
                COALESCE(SUM(v.sales_amount), 0)   AS total,
                COALESCE(SUM(v.document_count), 0) AS documents
           FROM v_sales_by_business v
          WHERE v.org_id = $1 ${where}
          GROUP BY v.txn_date
          ORDER BY v.txn_date DESC`,
        params
      );
      return {
        columns: [
          col('date', 'Date'),
          col('documents', 'Documents', 'number'),
          col('dealer', 'Dealer', 'money'),
          col('crop', 'Bulk crop', 'money'),
          col('total', 'Total sales', 'money'),
        ],
        rows: rows.map((r) => ({
          date: r.txn_date,
          documents: Number(r.documents),
          dealer: num(r.dealer),
          crop: num(r.crop),
          total: num(r.total),
        })),
        totals: { sales: rows.reduce((t, r) => t + num(r.total), 0) },
      };
    },
  },

  'sales-monthly': {
    order: 2,
    group: 'Sales',
    label: 'Monthly sales',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 'v');
      const { rows } = await query(
        `SELECT to_char(v.txn_date, 'YYYY-MM') AS month,
                COALESCE(SUM(v.sales_amount), 0)   AS sales,
                COALESCE(SUM(v.cost_amount), 0)    AS cost,
                COALESCE(SUM(v.document_count), 0) AS documents
           FROM v_sales_by_business v
          WHERE v.org_id = $1 ${where}
          GROUP BY 1
          ORDER BY 1 DESC`,
        params
      );
      return {
        columns: [
          col('month', 'Month'),
          col('documents', 'Invoices', 'number'),
          col('sales', 'Sales', 'money'),
          col('cost', 'Cost of goods', 'money'),
          col('gross', 'Gross profit', 'money'),
        ],
        rows: rows.map((r) => ({
          month: r.month,
          documents: Number(r.documents),
          sales: num(r.sales),
          cost: num(r.cost),
          gross: num(r.sales) - num(r.cost),
        })),
        totals: { sales: rows.reduce((t, r) => t + num(r.sales), 0) },
      };
    },
  },

  'sales-person': {
    order: 5,
    group: 'Sales',
    label: 'Salesperson-wise sales',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 's');
      const { rows } = await query(
        `SELECT COALESCE(e.name, 'Unassigned') AS salesperson,
                COALESCE(e.designation, '')    AS designation,
                COUNT(*)::int                  AS invoices,
                COALESCE(SUM(s.net_amount), 0) AS sales
           FROM dealer_sales s
           LEFT JOIN employees e ON e.id = s.salesperson_id
          WHERE s.org_id = $1 AND s.status = 'POSTED' ${where}
          GROUP BY e.name, e.designation
          ORDER BY sales DESC`,
        params
      );
      return {
        columns: [
          col('salesperson', 'Salesperson'),
          col('designation', 'Designation'),
          col('invoices', 'Invoices', 'number'),
          col('sales', 'Sales', 'money'),
        ],
        rows: rows.map((r) => ({
          salesperson: r.salesperson,
          designation: r.designation,
          invoices: r.invoices,
          sales: num(r.sales),
        })),
        totals: { sales: rows.reduce((t, r) => t + num(r.sales), 0) },
      };
    },
  },

  /* --------------------------------------------------------------- purchase */

  'pur-company': {
    order: 7,
    group: 'Purchase',
    label: 'Company-wise purchase',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 'p');
      const { rows } = await query(
        `SELECT c.name AS company, c.district, COUNT(*)::int AS bills,
                COALESCE(SUM(p.net_amount), 0) AS purchase,
                COALESCE((SELECT SUM(pa.balance) FROM payables pa
                           WHERE pa.party_type = 'COMPANY' AND pa.party_id = c.id
                             AND NOT pa.is_settled), 0) AS outstanding
           FROM dealer_purchases p
           JOIN companies c ON c.id = p.company_id
          WHERE p.org_id = $1 AND p.status = 'POSTED' ${where}
          GROUP BY c.id, c.name, c.district
          ORDER BY purchase DESC`,
        params
      );
      return {
        columns: [
          col('company', 'Company'),
          col('district', 'District'),
          col('bills', 'Bills', 'number'),
          col('purchase', 'Purchase value', 'money'),
          col('outstanding', 'Outstanding', 'money'),
        ],
        rows: rows.map((r) => ({
          company: r.company,
          district: r.district,
          bills: r.bills,
          purchase: num(r.purchase),
          outstanding: num(r.outstanding),
        })),
        totals: { purchase: rows.reduce((t, r) => t + num(r.purchase), 0) },
      };
    },
  },

  'pur-batch': {
    order: 8,
    group: 'Purchase',
    label: 'Batch-wise purchase',
    permission: 'report.view',
    async run(req) {
      const { rows } = await query(
        `SELECT b.batch_no, c.name AS crop, COALESCE(s.name, '') AS supplier,
                w.name AS warehouse, b.received_on, b.quantity_received,
                COALESCE(i.rate, 0) AS rate, COALESCE(i.landed_cost, 0) AS landed_cost,
                b.cost_per_unit
           FROM crop_batches b
           JOIN crops c ON c.id = b.crop_id
           JOIN warehouses w ON w.id = b.warehouse_id
           LEFT JOIN suppliers s ON s.id = b.supplier_id
           LEFT JOIN crop_purchase_items i ON i.id = b.purchase_item_id
          WHERE b.org_id = $1
          ORDER BY b.received_on DESC, b.id DESC`,
        [req.orgId]
      );
      return {
        columns: [
          col('batch', 'Batch', 'code'),
          col('crop', 'Crop'),
          col('supplier', 'Supplier'),
          col('warehouse', 'Warehouse'),
          col('quantity', 'Quantity', 'number'),
          col('rate', 'Rate', 'money'),
          col('costPerUnit', 'Cost / unit', 'money'),
          col('landedCost', 'Landed cost', 'money'),
        ],
        rows: rows.map((r) => ({
          batch: r.batch_no,
          crop: r.crop,
          supplier: r.supplier,
          warehouse: r.warehouse,
          quantity: num(r.quantity_received),
          rate: num(r.rate),
          costPerUnit: num(r.cost_per_unit),
          landedCost: num(r.landed_cost),
        })),
        totals: { landedCost: rows.reduce((t, r) => t + num(r.landed_cost), 0) },
      };
    },
  },

  /* -------------------------------------------------------------- inventory */

  'inv-current': {
    order: 9,
    group: 'Inventory',
    label: 'Current stock',
    permission: 'report.view',
    async run(req) {
      // Both stock kinds in one shape, so they can be read as one list.
      const { rows } = await query(
        `SELECT 'Bulk Crop' AS kind, c.name AS item, w.name AS warehouse,
                s.quantity, u.code AS unit, b.cost_per_unit AS unit_cost,
                s.quantity * b.cost_per_unit AS value
           FROM stock s
           JOIN crop_batches b ON b.id = s.batch_id
           JOIN crops c        ON c.id = b.crop_id
           JOIN warehouses w   ON w.id = s.warehouse_id
           JOIN units u        ON u.id = b.unit_id
          WHERE s.org_id = $1 AND s.item_type = 'CROP_BATCH' AND s.quantity > 0
          UNION ALL
         SELECT 'Dealer', p.name, w.name, s.quantity, u.code, s.avg_cost,
                s.quantity * s.avg_cost
           FROM stock s
           JOIN products p   ON p.id = s.product_id
           JOIN warehouses w ON w.id = s.warehouse_id
           JOIN units u      ON u.id = p.unit_id
          WHERE s.org_id = $1 AND s.item_type = 'PRODUCT' AND s.quantity > 0
          ORDER BY 7 DESC`,
        [req.orgId]
      );
      return {
        columns: [
          col('item', 'Item'),
          col('kind', 'Business'),
          col('warehouse', 'Warehouse'),
          col('quantity', 'Quantity', 'number'),
          col('unit', 'Unit'),
          col('unitCost', 'Avg cost', 'money'),
          col('value', 'Stock value', 'money'),
        ],
        rows: rows.map((r) => ({
          item: r.item,
          kind: r.kind,
          warehouse: r.warehouse,
          quantity: num(r.quantity),
          unit: r.unit,
          unitCost: num(r.unit_cost),
          value: num(r.value),
        })),
        totals: { value: rows.reduce((t, r) => t + num(r.value), 0) },
      };
    },
  },

  'inv-valuation': {
    order: 10,
    group: 'Inventory',
    label: 'Stock valuation',
    permission: 'report.view',
    async run(req) {
      const { rows } = await query(
        `SELECT w.name AS warehouse,
                COALESCE(SUM(CASE WHEN s.item_type = 'CROP_BATCH'
                                  THEN s.quantity * b.cost_per_unit END), 0) AS crop_value,
                COALESCE(SUM(CASE WHEN s.item_type = 'PRODUCT'
                                  THEN s.quantity * s.avg_cost END), 0)      AS product_value,
                COUNT(*) FILTER (WHERE s.item_type = 'CROP_BATCH')::int      AS batches,
                COUNT(*) FILTER (WHERE s.item_type = 'PRODUCT')::int         AS products
           FROM stock s
           JOIN warehouses w ON w.id = s.warehouse_id
           LEFT JOIN crop_batches b ON b.id = s.batch_id
          WHERE s.org_id = $1 AND s.quantity > 0
          GROUP BY w.name
          ORDER BY w.name`,
        [req.orgId]
      );
      return {
        columns: [
          col('warehouse', 'Warehouse'),
          col('batches', 'Batches', 'number'),
          col('products', 'Products', 'number'),
          col('cropValue', 'Bulk crop value', 'money'),
          col('productValue', 'Dealer value', 'money'),
          col('total', 'Total value', 'money'),
        ],
        rows: rows.map((r) => ({
          warehouse: r.warehouse,
          batches: r.batches,
          products: r.products,
          cropValue: num(r.crop_value),
          productValue: num(r.product_value),
          total: num(r.crop_value) + num(r.product_value),
        })),
        totals: {
          value: rows.reduce((t, r) => t + num(r.crop_value) + num(r.product_value), 0),
        },
      };
    },
  },

  /* ----------------------------------------------------------------- profit */

  'profit-product': {
    order: 13,
    group: 'Profit',
    label: 'Product-wise profit',
    permission: 'report.profit',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 's');
      const { rows } = await query(
        `SELECT p.name AS product,
                COALESCE(SUM(i.quantity), 0)  AS qty,
                COALESCE(SUM(i.line_net), 0)  AS sales,
                COALESCE(SUM(i.line_cost), 0) AS cost
           FROM dealer_sale_items i
           JOIN dealer_sales s ON s.id = i.sale_id
           JOIN products p     ON p.id = i.product_id
          WHERE s.org_id = $1 AND s.status = 'POSTED' ${where}
          GROUP BY p.id, p.name
          ORDER BY (COALESCE(SUM(i.line_net), 0) - COALESCE(SUM(i.line_cost), 0)) DESC`,
        params
      );
      return {
        columns: [
          col('product', 'Product'),
          col('qty', 'Qty sold', 'number'),
          col('sales', 'Sales', 'money'),
          col('cost', 'Cost', 'money'),
          col('marginPct', 'Margin', 'percent'),
          col('profit', 'Profit', 'money'),
        ],
        rows: rows.map((r) => {
          const sales = num(r.sales);
          const cost = num(r.cost);
          return {
            product: r.product,
            qty: num(r.qty),
            sales,
            cost,
            marginPct: sales ? ((sales - cost) / sales) * 100 : 0,
            profit: sales - cost,
          };
        }),
        totals: { profit: rows.reduce((t, r) => t + num(r.sales) - num(r.cost), 0) },
      };
    },
  },

  'profit-customer': {
    order: 14,
    group: 'Profit',
    label: 'Customer-wise profit',
    permission: 'report.profit',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 's');
      const { rows } = await query(
        `SELECT c.name AS customer, c.customer_type, COUNT(*)::int AS invoices,
                COALESCE(SUM(s.net_amount), 0)    AS sales,
                COALESCE(SUM(s.cost_amount), 0)   AS cost,
                COALESCE(SUM(s.profit_amount), 0) AS profit
           FROM dealer_sales s
           JOIN customers c ON c.id = s.customer_id
          WHERE s.org_id = $1 AND s.status = 'POSTED' ${where}
          GROUP BY c.id, c.name, c.customer_type
          ORDER BY profit DESC`,
        params
      );
      return {
        columns: [
          col('customer', 'Customer'),
          col('type', 'Type'),
          col('invoices', 'Invoices', 'number'),
          col('sales', 'Sales', 'money'),
          col('cost', 'Cost', 'money'),
          col('marginPct', 'Margin', 'percent'),
          col('profit', 'Profit', 'money'),
        ],
        rows: rows.map((r) => {
          const sales = num(r.sales);
          return {
            customer: r.customer,
            type: r.customer_type,
            invoices: r.invoices,
            sales,
            cost: num(r.cost),
            marginPct: sales ? (num(r.profit) / sales) * 100 : 0,
            profit: num(r.profit),
          };
        }),
        totals: { profit: rows.reduce((t, r) => t + num(r.profit), 0) },
      };
    },
  },

  'profit-monthly': {
    order: 15,
    group: 'Profit',
    label: 'Monthly profit',
    permission: 'report.profit',
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 'v');
      const { rows } = await query(
        `SELECT to_char(v.txn_date, 'YYYY-MM') AS month,
                COALESCE(SUM(v.sales_amount), 0)  AS sales,
                COALESCE(SUM(v.cost_amount), 0)   AS cost,
                COALESCE(SUM(v.profit_amount), 0) AS profit
           FROM v_sales_by_business v
          WHERE v.org_id = $1 ${where}
          GROUP BY 1
          ORDER BY 1 DESC`,
        params
      );
      return {
        columns: [
          col('month', 'Month'),
          col('sales', 'Sales', 'money'),
          col('cost', 'Cost of goods', 'money'),
          col('marginPct', 'Margin', 'percent'),
          col('profit', 'Profit', 'money'),
        ],
        rows: rows.map((r) => {
          const sales = num(r.sales);
          return {
            month: r.month,
            sales,
            cost: num(r.cost),
            marginPct: sales ? (num(r.profit) / sales) * 100 : 0,
            profit: num(r.profit),
          };
        }),
        totals: { profit: rows.reduce((t, r) => t + num(r.profit), 0) },
      };
    },
  },

  /* ---------------------------------------------------------------- finance */

  'fin-cashbook': {
    order: 17,
    group: 'Finance',
    label: 'Cash book',
    permission: 'payment.view',
    async run(req, q) {
      // `ledger_entries` dates its rows `entry_date`, not `txn_date`, so the
      // shared date helper does not apply here.
      const params = [req.orgId];
      let where = '';
      if (q.from) {
        params.push(q.from);
        where += ` AND l.entry_date >= $${params.length}`;
      }
      if (q.to) {
        params.push(q.to);
        where += ` AND l.entry_date <= $${params.length}`;
      }
      if (q.businessType !== 'ALL') {
        params.push(q.businessType);
        where += ` AND l.business_type = $${params.length}`;
      }

      const { rows } = await query(
        `SELECT l.entry_date, a.name AS account, a.account_type, l.narration,
                l.debit, l.credit
           FROM ledger_entries l
           JOIN accounts a ON a.id = l.account_id
          WHERE l.org_id = $1 AND l.account_id IS NOT NULL ${where}
          ORDER BY l.entry_date DESC, l.id DESC`,
        params
      );

      const received = rows.reduce((t, r) => t + num(r.debit), 0);
      const paid = rows.reduce((t, r) => t + num(r.credit), 0);

      return {
        columns: [
          col('date', 'Date'),
          col('account', 'Account'),
          col('narration', 'Particulars'),
          col('received', 'Received', 'money'),
          col('paid', 'Paid', 'money'),
        ],
        rows: rows.map((r) => ({
          date: r.entry_date,
          account: r.account,
          narration: r.narration,
          received: num(r.debit),
          paid: num(r.credit),
        })),
        totals: { net: received - paid },
      };
    },
  },

  'fin-pl': {
    order: 18,
    group: 'Finance',
    label: 'Profit & loss',
    permission: 'report.profit',
    /**
     * Read from the journal, not recomputed from the documents.
     *
     * This used to total the transaction tables itself, which made it a second
     * opinion on the same question: it and the ledger could disagree, and
     * nothing would say which was wrong. Both now come from
     * `v_profit_and_loss`, so the report and the Accounts screen cannot tell
     * different stories about the same month.
     */
    async run(req, q) {
      const statement = await profitAndLoss(req.orgId, q);
      return {
        columns: [col('line', 'Line'), col('amount', 'Amount', 'money')],
        rows: statement.lines.map((l) => ({ line: l.label, amount: l.amount })),
        totals: { netProfit: statement.totals.netProfit },
      };
    },
  },
};
