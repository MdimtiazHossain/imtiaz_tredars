import { query, num } from '../lib/db.js';
import { canSeeProfit } from '../middleware/auth.js';

/**
 * The workspace payload.
 *
 * This is the adapter that lets the existing screens keep working untouched.
 * `Repository.load()` in the browser has always returned one object with a
 * fixed set of keys; this builds exactly that object from PostgreSQL, in the
 * same field names and formats the screens already read. Nothing in the UI
 * needs to know the data now comes from a database.
 */

/** '26 Aug 2026' — the format the screens already display. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** '28 Aug, 10:12 am' — used by the approval queue. */
export function formatDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  const hours = d.getUTCHours();
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return (
    `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}, ` +
    `${hour12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${suffix}`
  );
}

function daysSince(value) {
  if (!value) return 0;
  const then = new Date(value);
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86_400_000));
}

/** Relative age for the notification list: '12m', '2h', '1d'. */
function ago(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/* ----------------------------------------------------------------- pieces */

async function loadCustomers(orgId) {
  const { rows } = await query(
    `SELECT c.id, c.code, c.name, c.name_bn, c.customer_type, c.contact_person, c.mobile,
            c.district, c.upazila, c.credit_limit, c.credit_days,
            o.invoiced_amount, o.collected_amount, o.outstanding,
            (SELECT max(txn_date) FROM dealer_sales s
              WHERE s.customer_id = c.id AND s.status = 'POSTED') AS last_sale,
            COALESCE(SUM(a.balance) FILTER (WHERE a.aging_bucket = '0-30'), 0)   AS b30,
            COALESCE(SUM(a.balance) FILTER (WHERE a.aging_bucket = '31-60'), 0)  AS b60,
            COALESCE(SUM(a.balance) FILTER (WHERE a.aging_bucket = '61-90'), 0)  AS b90,
            COALESCE(SUM(a.balance) FILTER (
              WHERE a.aging_bucket IN ('91-120', '120+')), 0)                    AS b90p
       FROM customers c
       JOIN v_customer_outstanding o ON o.customer_id = c.id
       LEFT JOIN v_receivable_aging a
              ON a.party_type = 'CUSTOMER' AND a.party_id = c.id
      WHERE c.org_id = $1 AND c.is_active
      GROUP BY c.id, c.code, c.name, c.name_bn, c.customer_type, c.contact_person,
               c.mobile, c.district, c.upazila, c.credit_limit, c.credit_days,
               o.invoiced_amount, o.collected_amount, o.outstanding
      ORDER BY c.code`,
    [orgId]
  );

  return rows.map((r) => ({
    // The numeric id the API needs on a write; screens go on using `code`.
    id: Number(r.id),
    code: r.code,
    name: r.name,
    bn: r.name_bn || '',
    type: r.customer_type,
    person: r.contact_person || '',
    mobile: r.mobile,
    district: r.district || '',
    upazila: r.upazila || '',
    limit: num(r.credit_limit),
    days: num(r.credit_days),
    sales: num(r.invoiced_amount),
    coll: num(r.collected_amount),
    out: num(r.outstanding),
    last: formatDate(r.last_sale),
    b30: num(r.b30),
    b60: num(r.b60),
    b90: num(r.b90),
    b90p: num(r.b90p),
  }));
}

async function loadSuppliers(orgId) {
  const { rows } = await query(
    `SELECT s.id, s.code, s.name, s.name_bn, s.supplier_type, s.mobile, s.district,
            s.upazila, s.bank_account, o.billed_amount, o.paid_amount, o.outstanding,
            (SELECT max(txn_date) FROM crop_purchases p
              WHERE p.supplier_id = s.id AND p.status = 'POSTED') AS last_purchase
       FROM suppliers s
       JOIN v_supplier_outstanding o ON o.supplier_id = s.id
      WHERE s.org_id = $1 AND s.is_active
      ORDER BY s.code`,
    [orgId]
  );

  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    bn: r.name_bn || '',
    type: r.supplier_type,
    mobile: r.mobile,
    district: r.district || '',
    upazila: r.upazila || '',
    bank: r.bank_account || '',
    pur: num(r.billed_amount),
    paid: num(r.paid_amount),
    out: num(r.outstanding),
    last: formatDate(r.last_purchase),
  }));
}

const COMPANY_ROLE_LABEL = {
  PRINCIPAL: 'Principal',
  SUPPLIER: 'Supplier',
  BUYER: 'Buyer',
  SUPPLIER_AND_BUYER: 'Supplier & Buyer',
};

async function loadCompanies(orgId) {
  const { rows } = await query(
    `SELECT c.id, c.code, c.name, c.role, c.contact_person, c.mobile, c.district,
            c.credit_limit, c.credit_days, c.is_active,
            COALESCE((SELECT SUM(balance) FROM payables p
                       WHERE p.party_type = 'COMPANY' AND p.party_id = c.id
                         AND NOT p.is_settled), 0) AS payable,
            COALESCE((SELECT SUM(balance) FROM receivables r
                       WHERE r.party_type = 'COMPANY' AND r.party_id = c.id
                         AND NOT r.is_settled), 0) AS receivable
       FROM companies c
      WHERE c.org_id = $1
      ORDER BY c.code`,
    [orgId]
  );

  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    type: COMPANY_ROLE_LABEL[r.role] || r.role,
    person: r.contact_person || '',
    mobile: r.mobile || '',
    district: r.district || '',
    limit: num(r.credit_limit),
    days: num(r.credit_days),
    // Positive means we owe them; negative means they owe us, matching the
    // sign convention the Companies screen already renders.
    bal: num(r.payable) - num(r.receivable),
    status: r.is_active ? 'Active' : 'On hold',
  }));
}

async function loadProducts(orgId) {
  const { rows } = await query(
    `SELECT p.id, p.code, p.name, pc.name AS category, b.name AS brand, u.code AS unit,
            p.purchase_rate, p.sale_rate, p.min_stock,
            COALESCE((SELECT SUM(s.quantity) FROM stock s
                       WHERE s.product_id = p.id AND s.item_type = 'PRODUCT'), 0) AS stock
       FROM products p
       LEFT JOIN product_categories pc ON pc.id = p.category_id
       LEFT JOIN brands b              ON b.id = p.brand_id
       JOIN units u                    ON u.id = p.unit_id
      WHERE p.org_id = $1 AND p.is_active
      ORDER BY p.code`,
    [orgId]
  );

  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    cat: r.category || '',
    brand: r.brand || '',
    unit: r.unit,
    stock: num(r.stock),
    pur: num(r.purchase_rate),
    sale: num(r.sale_rate),
    min: num(r.min_stock),
  }));
}

async function loadBatches(orgId) {
  const { rows } = await query(
    `SELECT b.id AS db_id, b.batch_no, c.name AS crop, g.name AS grade, w.name AS warehouse,
            b.quantity_received, b.quantity_remaining, b.cost_per_unit,
            b.received_on, s.name AS supplier
       FROM crop_batches b
       JOIN crops c        ON c.id = b.crop_id
       LEFT JOIN crop_grades g ON g.id = b.grade_id
       JOIN warehouses w   ON w.id = b.warehouse_id
       LEFT JOIN suppliers s   ON s.id = b.supplier_id
      WHERE b.org_id = $1 AND b.is_active AND b.quantity_remaining > 0
      ORDER BY b.received_on DESC, b.id DESC`,
    [orgId]
  );

  return rows.map((r) => ({
    // `id` remains the batch number every screen already renders; the numeric
    // key the API needs travels alongside it.
    id: r.batch_no,
    dbId: Number(r.db_id),
    crop: r.crop,
    grade: r.grade || '',
    wh: r.warehouse,
    qty: num(r.quantity_received),
    rem: num(r.quantity_remaining),
    cost: num(r.cost_per_unit),
    date: formatDate(r.received_on),
    age: daysSince(r.received_on),
    sup: r.supplier || '',
  }));
}

async function loadApprovals(orgId) {
  const { rows } = await query(
    `SELECT a.request_no, a.entity_type, a.reference_no, a.party_name, a.amount,
            a.reason, a.status, a.requested_at,
            requester.username AS requested_by_username,
            re.name AS requested_by_name, re.designation AS requested_by_role,
            a.decided_at, de.name AS decided_by_name
       FROM approvals a
       JOIN users requester        ON requester.id = a.requested_by
       LEFT JOIN employees re      ON re.id = requester.employee_id
       LEFT JOIN users decider     ON decider.id = a.decided_by
       LEFT JOIN employees de      ON de.id = decider.employee_id
      WHERE a.org_id = $1
      ORDER BY a.requested_at DESC
      LIMIT 100`,
    [orgId]
  );

  const KIND = {
    crop_purchases: 'Bulk Crop Purchase',
    crop_sales: 'Bulk Crop Sales',
    dealer_purchases: 'Dealer Purchase',
    dealer_sales: 'Sales Discount',
    stock_adjustments: 'Stock Adjustment',
    expenses: 'Expense',
  };

  return rows.map((r) => ({
    id: r.request_no,
    kind: KIND[r.entity_type] || r.entity_type,
    ref: r.reference_no || '',
    party: r.party_name || '',
    amt: num(r.amount),
    by: `${r.requested_by_name || r.requested_by_username}${
      r.requested_by_role ? ` (${r.requested_by_role})` : ''
    }`,
    when: formatDateTime(r.requested_at),
    why: r.reason,
    status: r.status.toLowerCase(),
    hist:
      r.decided_at && r.decided_by_name
        ? `${r.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${r.decided_by_name} · ` +
          `${formatDateTime(r.decided_at)}`
        : '',
  }));
}

async function loadCropLog(orgId) {
  const { rows } = await query(
    `SELECT p.txn_no, p.txn_date, s.name AS supplier, c.name AS crop,
            i.net_quantity, u.code AS unit, i.rate, i.cost_per_unit,
            p.net_amount, p.status
       FROM crop_purchases p
       JOIN suppliers s          ON s.id = p.supplier_id
       JOIN crop_purchase_items i ON i.purchase_id = p.id AND i.line_no = 1
       JOIN crops c              ON c.id = i.crop_id
       JOIN units u              ON u.id = i.unit_id
      WHERE p.org_id = $1 AND p.status <> 'CANCELLED'
      ORDER BY p.txn_date DESC, p.id DESC
      LIMIT 50`,
    [orgId]
  );

  const STATUS = { POSTED: 'Posted', DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', APPROVED: 'Approved' };

  return rows.map((r) => ({
    no: r.txn_no,
    date: formatDate(r.txn_date),
    sup: r.supplier,
    crop: r.crop,
    qty: num(r.net_quantity),
    unit: r.unit,
    rate: num(r.rate),
    cpu: num(r.cost_per_unit),
    total: num(r.net_amount),
    status: STATUS[r.status] || r.status,
  }));
}

async function loadSaleLog(orgId, showProfit) {
  const { rows } = await query(
    `SELECT s.txn_no, s.txn_date, co.name AS buyer, c.name AS crop,
            i.quantity, i.rate, s.net_amount, s.profit_amount, s.status,
            (SELECT string_agg(DISTINCT b.batch_no, ', ')
               FROM crop_batch_allocations a
               JOIN crop_batches b ON b.id = a.batch_id
              WHERE a.sale_item_id = i.id) AS batches
       FROM crop_sales s
       JOIN companies co       ON co.id = s.buyer_company_id
       JOIN crop_sale_items i  ON i.sale_id = s.id AND i.line_no = 1
       JOIN crops c            ON c.id = i.crop_id
      WHERE s.org_id = $1 AND s.status <> 'CANCELLED'
      ORDER BY s.txn_date DESC, s.id DESC
      LIMIT 50`,
    [orgId]
  );

  return rows.map((r) => ({
    no: r.txn_no,
    date: formatDate(r.txn_date),
    buyer: r.buyer,
    crop: r.crop,
    batch: r.batches || '',
    qty: num(r.quantity),
    rate: num(r.rate),
    amt: num(r.net_amount),
    profit: showProfit ? num(r.profit_amount) : 0,
    status: r.status === 'POSTED' ? 'Posted' : 'Draft',
  }));
}

/**
 * Notifications are derived rather than stored: overdue receivables, pending
 * approvals, low stock and ageing batches are all queries, so the list is
 * always true rather than a stale table.
 */
async function loadNotifications(orgId) {
  const notifications = [];

  const overdue = await query(
    `SELECT c.name, SUM(a.balance) AS balance
       FROM v_receivable_aging a
       JOIN customers c ON c.id = a.party_id AND a.party_type = 'CUSTOMER'
      WHERE a.org_id = $1 AND a.aging_bucket IN ('91-120', '120+')
      GROUP BY c.name ORDER BY balance DESC LIMIT 2`,
    [orgId]
  );
  for (const r of overdue.rows) {
    notifications.push({
      t: 'Payment overdue',
      d: `${r.name} — ৳${num(r.balance).toLocaleString('en-IN')} past 90 days`,
      ago: '12m',
      tone: 'danger',
      go: 'accounts',
    });
  }

  const pending = await query(
    `SELECT request_no, reference_no, requested_at FROM approvals
      WHERE org_id = $1 AND status = 'PENDING'
      ORDER BY requested_at DESC LIMIT 2`,
    [orgId]
  );
  for (const r of pending.rows) {
    notifications.push({
      t: 'Approval pending',
      d: `${r.reference_no || r.request_no} needs your approval`,
      ago: ago(r.requested_at),
      tone: 'accent',
      go: 'approvals',
    });
  }

  const lowStock = await query(
    `SELECT p.name, p.min_stock, u.code AS unit,
            COALESCE(SUM(s.quantity), 0) AS on_hand
       FROM products p
       JOIN units u ON u.id = p.unit_id
       LEFT JOIN stock s ON s.product_id = p.id AND s.item_type = 'PRODUCT'
      WHERE p.org_id = $1 AND p.is_active AND p.min_stock > 0
      GROUP BY p.id, p.name, p.min_stock, u.code
     HAVING COALESCE(SUM(s.quantity), 0) < p.min_stock
      ORDER BY (COALESCE(SUM(s.quantity), 0) / NULLIF(p.min_stock, 0)) ASC
      LIMIT 2`,
    [orgId]
  );
  for (const r of lowStock.rows) {
    notifications.push({
      t: 'Low stock',
      d: `${r.name} — ${num(r.on_hand)} against minimum ${num(r.min_stock)}`,
      ago: '2h',
      tone: 'warn',
      go: 'inventory',
    });
  }

  const dead = await query(
    `SELECT b.batch_no, c.name AS crop, b.received_on
       FROM crop_batches b JOIN crops c ON c.id = b.crop_id
      WHERE b.org_id = $1 AND b.is_active AND b.quantity_remaining > 0
        AND b.received_on < CURRENT_DATE - 60
      ORDER BY b.received_on ASC LIMIT 2`,
    [orgId]
  );
  for (const r of dead.rows) {
    notifications.push({
      t: 'Dead stock alert',
      d: `${r.crop} batch ${r.batch_no} is ${daysSince(r.received_on)} days old`,
      ago: '5h',
      tone: 'warn',
      go: 'inventory',
    });
  }

  return notifications;
}

/**
 * Small reference lists the forms need: where money moves, how it moves, and
 * what an expense can be booked against. They belong in the boot payload
 * rather than a separate round trip on every modal open.
 */
async function loadFinanceLookups(orgId) {
  const [accounts, methods, categories] = await Promise.all([
    query(
      `SELECT id, code, name, account_type FROM accounts
        WHERE org_id = $1 AND is_active ORDER BY id`,
      [orgId]
    ),
    query(
      `SELECT id, code, name, account_id FROM payment_methods
        WHERE org_id = $1 AND is_active ORDER BY id`,
      [orgId]
    ),
    query('SELECT id, code, name FROM expense_categories WHERE is_active ORDER BY id'),
  ]);

  return {
    accounts: accounts.rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name,
      type: r.account_type,
    })),
    paymentMethods: methods.rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name,
      accountId: r.account_id ? Number(r.account_id) : null,
    })),
    expenseCategories: categories.rows.map((r) => ({
      id: Number(r.id),
      code: r.code,
      name: r.name,
    })),
  };
}

/* ------------------------------------------------------------------ public */

// Navigation groups and screen titles stay in the frontend: they describe the
// UI's own structure, not business data, and the role filtering applied to them
// is presentation. The API supplies the records; the client supplies the shell.

/**
 * Build the whole workspace payload in one round trip.
 * Queries run concurrently because none depends on another's result.
 */
export async function loadWorkspace({ orgId, user }) {
  const showProfit = canSeeProfit(user);

  const [
    org,
    customers,
    suppliers,
    companies,
    products,
    batches,
    approvals,
    cropLog,
    saleLog,
    notifications,
    finance,
    lookups,
  ] = await Promise.all([
    query(
      `SELECT o.name, o.system_name, f.code AS fiscal_year
         FROM organizations o
         LEFT JOIN fiscal_years f ON f.org_id = o.id AND f.is_current
        WHERE o.id = $1`,
      [orgId]
    ),
    loadCustomers(orgId),
    loadSuppliers(orgId),
    loadCompanies(orgId),
    loadProducts(orgId),
    loadBatches(orgId),
    loadApprovals(orgId),
    loadCropLog(orgId),
    loadSaleLog(orgId, showProfit),
    loadNotifications(orgId),
    loadFinanceLookups(orgId),
    Promise.all([
      query('SELECT name, last_rate FROM crops WHERE org_id = $1 AND is_active ORDER BY id', [orgId]),
      query('SELECT name FROM warehouses WHERE org_id = $1 AND is_active ORDER BY id', [orgId]),
      query('SELECT code FROM units WHERE is_active ORDER BY id'),
      query('SELECT name FROM crop_grades WHERE is_active ORDER BY id'),
      query(
        `SELECT name FROM companies
          WHERE org_id = $1 AND is_active AND role IN ('BUYER','SUPPLIER_AND_BUYER')
          ORDER BY id`,
        [orgId]
      ),
    ]),
  ]);

  const [cropRows, warehouseRows, unitRows, gradeRows, buyerRows] = lookups;

  const lastRate = {};
  for (const r of cropRows.rows) lastRate[r.name] = num(r.last_rate);

  return {
    company: {
      name: org.rows[0]?.name || '',
      sys: org.rows[0]?.system_name || 'Business Suite',
      fy: org.rows[0]?.fiscal_year || '',
      user: user.name,
      init: (user.name || '?')
        .split(' ')
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase(),
    },
    customers,
    suppliers,
    companies,
    products,
    crops: cropRows.rows.map((r) => r.name),
    warehouses: warehouseRows.rows.map((r) => r.name),
    units: unitRows.rows.map((r) => r.code),
    grades: gradeRows.rows.map((r) => r.name),
    buyers: buyerRows.rows.map((r) => r.name),
    lastRate,
    batches,
    approvals,
    cropLog,
    saleLog,
    notifications,
    accounts: finance.accounts,
    paymentMethods: finance.paymentMethods,
    expenseCategories: finance.expenseCategories,
  };
}
