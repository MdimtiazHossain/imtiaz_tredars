import { query, num } from '../lib/db.js';
import { col, dateAndBusiness, entityFilters } from './reportHelpers.js';
import { profitAndLoss } from '../services/statementService.js';
import { apportionment } from '../services/taxService.js';

/** A ratio as a percentage, for a line somebody reads rather than sums. */
const percent = (n) => `${(n * 100).toFixed(n * 100 % 1 === 0 ? 0 : 2)}%`;

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
/**
 * Which entity each report can be narrowed to, and the column each filter
 * means. The definition advertises these to the catalogue and its own query
 * applies them, so the two cannot drift apart.
 */
const FILTERS = {
  'sales-person': { employeeId: 's.salesperson_id', customerId: 's.customer_id',
    warehouseId: 's.warehouse_id' },
  'pur-company': { companyId: 'p.company_id', warehouseId: 'p.warehouse_id' },
  'pur-batch': { cropId: 'b.crop_id', warehouseId: 'b.warehouse_id', supplierId: 'b.supplier_id' },
  'inv-current': { warehouseId: 's.warehouse_id', cropId: 'b.crop_id', productId: 's.product_id' },
  'inv-valuation': { warehouseId: 's.warehouse_id' },
  'profit-product': { productId: 'i.product_id', customerId: 's.customer_id' },
  'profit-customer': { customerId: 's.customer_id', warehouseId: 's.warehouse_id' },
};

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
    filters: FILTERS['sales-person'],
    order: 5,
    group: 'Sales',
    label: 'Salesperson-wise sales',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where =
        dateAndBusiness(q, params, 's') + entityFilters(q, params, FILTERS['sales-person']);
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
    filters: FILTERS['pur-company'],
    order: 7,
    group: 'Purchase',
    label: 'Company-wise purchase',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where =
        dateAndBusiness(q, params, 'p') + entityFilters(q, params, FILTERS['pur-company']);
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
    filters: FILTERS['pur-batch'],
    order: 8,
    group: 'Purchase',
    label: 'Batch-wise purchase',
    permission: 'report.view',
    async run(req, q) {
      const params = [req.orgId];
      const where = entityFilters(q, params, FILTERS['pur-batch']);
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
          WHERE b.org_id = $1 ${where}
          ORDER BY b.received_on DESC, b.id DESC`,
        params
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
    filters: FILTERS['inv-current'],
    order: 9,
    group: 'Inventory',
    label: 'Current stock',
    permission: 'report.view',
    async run(req, q) {
      // Two kinds of stock in one shape, so they read as one list -- which
      // means two sets of columns to narrow against. Asking for one crop is
      // asking not to see products at all, so the other branch is closed
      // rather than left returning everything.
      const params = [req.orgId];
      const cropWhere = q.productId
        ? ' AND false'
        : entityFilters(q, params, { warehouseId: 's.warehouse_id', cropId: 'b.crop_id' });
      const productWhere = q.cropId
        ? ' AND false'
        : entityFilters(q, params, { warehouseId: 's.warehouse_id', productId: 's.product_id' });
      const { rows } = await query(
        `SELECT 'Bulk Crop' AS kind, c.name AS item, w.name AS warehouse,
                s.quantity, u.code AS unit, b.cost_per_unit AS unit_cost,
                s.quantity * b.cost_per_unit AS value
           FROM stock s
           JOIN crop_batches b ON b.id = s.batch_id
           JOIN crops c        ON c.id = b.crop_id
           JOIN warehouses w   ON w.id = s.warehouse_id
           JOIN units u        ON u.id = b.unit_id
          WHERE s.org_id = $1 AND s.item_type = 'CROP_BATCH' AND s.quantity > 0 ${cropWhere}
          UNION ALL
         SELECT 'Dealer', p.name, w.name, s.quantity, u.code, s.avg_cost,
                s.quantity * s.avg_cost
           FROM stock s
           JOIN products p   ON p.id = s.product_id
           JOIN warehouses w ON w.id = s.warehouse_id
           JOIN units u      ON u.id = p.unit_id
          WHERE s.org_id = $1 AND s.item_type = 'PRODUCT' AND s.quantity > 0 ${productWhere}
          ORDER BY 7 DESC`,
        params
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
    filters: FILTERS['inv-valuation'],
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
    filters: FILTERS['profit-product'],
    order: 13,
    group: 'Profit',
    label: 'Product-wise profit',
    permission: 'report.profit',
    async run(req, q) {
      const params = [req.orgId];
      const where =
        dateAndBusiness(q, params, 's') + entityFilters(q, params, FILTERS['profit-product']);
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
    filters: FILTERS['profit-customer'],
    order: 14,
    group: 'Profit',
    label: 'Customer-wise profit',
    permission: 'report.profit',
    async run(req, q) {
      const params = [req.orgId];
      const where =
        dateAndBusiness(q, params, 's') + entityFilters(q, params, FILTERS['profit-customer']);
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

  /* -------------------------------------------------------------------- vat */

  'vat-return': {
    order: 19,
    group: 'Finance',
    label: 'VAT return',
    permission: 'tax.view',
    /**
     * What is owed to the NBR for a period, in the shape a Mushak 9.1 asks it.
     *
     * Output tax less input tax, each net of what came back on a return. The
     * figures are the documents' own -- what was actually charged and actually
     * paid -- rather than a rate reapplied to a total, because a return credits
     * at the rate its original invoice used and today's rate may not be it.
     */
    async run(req, q) {
      // The return claims only what may be claimed. Tax at a non-reclaimable
      // rate was paid, and belongs on the purchase register, but it went into
      // the cost of the goods rather than into a rebate.
      const read = async (view, taxColumn) => {
        const params = [req.orgId];
        const where = dateAndBusiness(q, params, 'v');
        const { rows } = await query(
          `SELECT COALESCE(SUM(v.taxable_value), 0) AS taxable,
                  COALESCE(SUM(v.${taxColumn}), 0)  AS tax
             FROM ${view} v WHERE v.org_id = $1 ${where}`,
          params
        );
        return { taxable: num(rows[0].taxable), tax: num(rows[0].tax) };
      };

      const [output, input, split] = await Promise.all([
        read('v_output_tax', 'tax_amount'),
        read('v_input_tax', 'reclaimable_tax'),
        // And how much of that input tax the period's supplies actually earned
        // the right to. A credit is earned by supplying inside the VAT chain,
        // so a month that sold exempt produce earned less than all of it.
        apportionment(null, { orgId: req.orgId, from: q.from, to: q.to }),
      ]);
      const claimed = split.claimable;
      const payable = Math.round((output.tax - claimed) * 100) / 100;

      const rows = [
        { line: 'Output tax — sales, less sale returns', taxable: output.taxable, tax: output.tax },
        {
          line: 'Input tax — purchases, less purchase returns',
          taxable: input.taxable,
          tax: -input.tax,
        },
      ];

      // Shown only where it bites. A business making one kind of supply claims
      // all of its input tax, and a line reading nothing every month is a line
      // that stops being read.
      if (split.disallowed !== 0) {
        rows.push({
          line:
            'Less: not claimable — inputs used for exempt or truncated supply ' +
            `(${percent(1 - split.ratio)} of the claim)`,
          taxable: split.totalSupplies - split.creditableSupplies,
          tax: split.disallowed,
        });
      }

      rows.push({
        line: payable >= 0 ? 'Payable to the NBR' : 'Reclaimable from the NBR',
        taxable: null,
        tax: Math.abs(payable),
      });

      return {
        columns: [
          col('line', 'Line'),
          col('taxable', 'Value', 'money'),
          col('tax', 'VAT', 'money'),
        ],
        rows,
        totals: {
          outputTax: output.tax,
          // What may actually be claimed, which is what the books have to show
          // once the period's apportionment has been journalled.
          inputTax: claimed,
          inputTaxBeforeApportionment: input.tax,
          creditRatio: split.ratio,
          disallowedInputTax: split.disallowed,
          // Signed: negative is a rebate the business is owed, which happens in
          // any month it buys more than it sells.
          netPayable: payable,
        },
      };
    },
  },

  'vat-sales-register': {
    order: 20,
    group: 'Finance',
    label: 'VAT sales register',
    permission: 'tax.view',
    /** Every taxable supply made, which is what a Mushak 6.2 lists. */
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 'v');
      const { rows } = await query(
        `SELECT v.txn_date, v.txn_no, v.document_type, v.business_type,
                v.taxable_value, v.tax_amount,
                CASE v.party_type
                  WHEN 'CUSTOMER' THEN (SELECT name FROM customers WHERE id = v.party_id)
                  WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers WHERE id = v.party_id)
                  ELSE                 (SELECT name FROM companies WHERE id = v.party_id)
                END AS party_name,
                CASE v.party_type
                  WHEN 'CUSTOMER' THEN (SELECT bin_no FROM customers WHERE id = v.party_id)
                  WHEN 'SUPPLIER' THEN (SELECT bin_no FROM suppliers WHERE id = v.party_id)
                  ELSE                 (SELECT bin_no FROM companies WHERE id = v.party_id)
                END AS bin_no
           FROM v_output_tax v
          WHERE v.org_id = $1 ${where}
          ORDER BY v.txn_date DESC, v.txn_no DESC`,
        params
      );

      return {
        columns: [
          col('date', 'Date'),
          col('no', 'Document', 'code'),
          col('party', 'Buyer'),
          col('bin', 'BIN', 'code'),
          col('taxable', 'Taxable value', 'money'),
          col('tax', 'VAT', 'money'),
        ],
        rows: rows.map((r) => ({
          date: r.txn_date,
          no: r.txn_no,
          party: r.party_name || '—',
          // A buyer with no BIN is an unregistered one, which is ordinary in
          // this trade and is what the register should show.
          bin: r.bin_no || 'Unregistered',
          taxable: num(r.taxable_value),
          tax: num(r.tax_amount),
        })),
        totals: {
          taxableValue: rows.reduce((t, r) => t + num(r.taxable_value), 0),
          tax: rows.reduce((t, r) => t + num(r.tax_amount), 0),
        },
      };
    },
  },

  'vat-purchase-register': {
    order: 21,
    group: 'Finance',
    label: 'VAT purchase register',
    permission: 'tax.view',
    /** Every taxable input taken, which is what a Mushak 6.1 lists. */
    async run(req, q) {
      const params = [req.orgId];
      const where = dateAndBusiness(q, params, 'v');
      const { rows } = await query(
        `SELECT v.txn_date, v.txn_no, v.document_type, v.business_type,
                v.taxable_value, v.tax_amount, v.reclaimable_tax,
                CASE v.party_type
                  WHEN 'CUSTOMER' THEN (SELECT name FROM customers WHERE id = v.party_id)
                  WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers WHERE id = v.party_id)
                  ELSE                 (SELECT name FROM companies WHERE id = v.party_id)
                END AS party_name,
                CASE v.party_type
                  WHEN 'CUSTOMER' THEN (SELECT bin_no FROM customers WHERE id = v.party_id)
                  WHEN 'SUPPLIER' THEN (SELECT bin_no FROM suppliers WHERE id = v.party_id)
                  ELSE                 (SELECT bin_no FROM companies WHERE id = v.party_id)
                END AS bin_no
           FROM v_input_tax v
          WHERE v.org_id = $1 ${where}
          ORDER BY v.txn_date DESC, v.txn_no DESC`,
        params
      );

      return {
        columns: [
          col('date', 'Date'),
          col('no', 'Document', 'code'),
          col('party', 'Supplier'),
          col('bin', 'BIN', 'code'),
          col('taxable', 'Taxable value', 'money'),
          col('tax', 'VAT paid', 'money'),
          col('reclaimable', 'Reclaimable', 'money'),
        ],
        rows: rows.map((r) => ({
          date: r.txn_date,
          no: r.txn_no,
          party: r.party_name || '—',
          bin: r.bin_no || 'Unregistered',
          taxable: num(r.taxable_value),
          tax: num(r.tax_amount),
          reclaimable: num(r.reclaimable_tax),
        })),
        totals: {
          taxableValue: rows.reduce((t, r) => t + num(r.taxable_value), 0),
          tax: rows.reduce((t, r) => t + num(r.tax_amount), 0),
          reclaimable: rows.reduce((t, r) => t + num(r.reclaimable_tax), 0),
        },
      };
    },
  },
};
