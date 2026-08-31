import { Router } from 'express';
import { z } from 'zod';
import { query, num } from '../lib/db.js';
import {
  handler,
  ok,
  parseQuery,
  listQuerySchema,
  orderBy,
  paginate,
  pageMeta,
} from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { notFound } from '../lib/errors.js';
import { registerMasterCrud } from './masterCrud.js';

/**
 * Master data: customers, suppliers, companies, products, warehouses and
 * employees. All listing is server-side -- filtered, sorted and paginated in
 * PostgreSQL -- so a browser never receives a whole table.
 */
const router = Router();

/* --------------------------------------------------------------- customers */

const CUSTOMER_SORTS = {
  code: 'c.code',
  name: 'c.name',
  district: 'c.district',
  outstanding: 'o.outstanding',
  limit: 'c.credit_limit',
};

router.get(
  '/customers',
  requirePermission('customer.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'c.org_id = $1 AND c.is_active';

    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.code ILIKE $${params.length}
                      OR c.mobile ILIKE $${params.length} OR c.district ILIKE $${params.length})`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM customers c WHERE ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT c.id, c.code, c.name, c.name_bn, c.customer_type, c.contact_person,
              c.mobile, c.district, c.upazila, c.credit_limit, c.credit_days,
              o.outstanding, o.invoiced_amount, o.collected_amount
         FROM customers c
         JOIN v_customer_outstanding o ON o.customer_id = c.id
        WHERE ${where}
        ORDER BY ${orderBy(q.sort, q.dir, CUSTOMER_SORTS, 'c.code')}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        bn: r.name_bn || '',
    bin: r.bin_no || '',
    vatRegistered: r.is_vat_registered,
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
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

const customerSchema = z.object({
  bin: z.string().trim().max(24).optional(),
  vatRegistered: z.coerce.boolean().optional(),
  name: z.string().trim().min(1, 'Customer name is required').max(200),
  bn: z.string().trim().max(200).optional().default(''),
  type: z.string().trim().max(40).default('Dealer'),
  person: z.string().trim().max(120).optional().default(''),
  mobile: z.string().trim().min(1, 'Mobile number is required').max(30),
  district: z.string().trim().max(80).optional().default(''),
  upazila: z.string().trim().max(80).optional().default(''),
  limit: z.coerce.number().min(0).default(0),
  days: z.coerce.number().int().min(0).max(365).default(0),
  opening: z.coerce.number().min(0).default(0),
});

/* ------------------------------------------------------------------- crops */

/*
 * The crop master shares `/crops` with crop trading, which is mounted after
 * this router. That works because the trading routes all sit under
 * `/crops/purchases`, `/crops/sales` and `/crops/batches` while these are
 * `/crops` and `/crops/:id`. Adding a `GET /crops/:id` here would shadow
 * `/crops/batches`, so don't.
 */

router.get(
  '/crops',
  requirePermission('crop.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'c.org_id = $1';
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.code ILIKE $${params.length})`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM crops c WHERE ${where}`,
      params
    );

    // Stock and the last purchase come from the batches, so the screen shows
    // what a crop is actually worth holding rather than just its name.
    const { rows } = await query(
      `SELECT c.id, c.code, c.name, c.last_rate, c.is_active, u.code AS unit,
              COALESCE(b.quantity, 0)  AS quantity,
              COALESCE(b.value, 0)     AS value,
              b.received_on
         FROM crops c
         JOIN units u ON u.id = c.default_unit_id
         LEFT JOIN (
           SELECT crop_id,
                  SUM(quantity_remaining)                     AS quantity,
                  ROUND(SUM(quantity_remaining * cost_per_unit), 2) AS value,
                  -- Formatted in SQL: a bare date arrives as a JS Date, and
                  -- stringifying that gives "Wed Aug 12", not a date.
                  to_char(MAX(received_on), 'YYYY-MM-DD')     AS received_on
             FROM crop_batches
            WHERE is_active AND quantity_remaining > 0
            GROUP BY crop_id
         ) b ON b.crop_id = c.id
        WHERE ${where}
        ORDER BY ${orderBy(q.sort, q.dir, { code: 'c.code', name: 'c.name', quantity: 'b.quantity' }, 'c.code')}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        unit: r.unit,
        rate: num(r.last_rate),
        quantity: num(r.quantity),
        value: num(r.value),
        last: r.received_on || '',
        status: r.is_active ? 'Active' : 'Retired',
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

/* --------------------------------------------------------------- suppliers */

router.get(
  '/suppliers',
  requirePermission('supplier.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 's.org_id = $1 AND s.is_active';
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (s.name ILIKE $${params.length} OR s.code ILIKE $${params.length}
                      OR s.mobile ILIKE $${params.length})`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM suppliers s WHERE ${where}`,
      params
    );
    const { rows } = await query(
      `SELECT s.id, s.code, s.name, s.name_bn, s.supplier_type, s.mobile, s.district,
              s.upazila, s.bank_account, o.billed_amount, o.paid_amount, o.outstanding
         FROM suppliers s
         JOIN v_supplier_outstanding o ON o.supplier_id = s.id
        WHERE ${where}
        ORDER BY ${orderBy(q.sort, q.dir, { code: 's.code', name: 's.name', outstanding: 'o.outstanding' }, 's.code')}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        bn: r.name_bn || '',
    bin: r.bin_no || '',
    vatRegistered: r.is_vat_registered,
        type: r.supplier_type,
        mobile: r.mobile,
        district: r.district || '',
        upazila: r.upazila || '',
        bank: r.bank_account || '',
        pur: num(r.billed_amount),
        paid: num(r.paid_amount),
        out: num(r.outstanding),
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

/* --------------------------------------------------------------- companies */

router.get(
  '/companies',
  requirePermission('company.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'c.org_id = $1';
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.code ILIKE $${params.length})`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM companies c WHERE ${where}`,
      params
    );
    const { rows } = await query(
      `SELECT c.id, c.code, c.name, c.role, c.contact_person, c.mobile, c.district,
              c.credit_limit, c.credit_days, c.is_active
         FROM companies c WHERE ${where}
        ORDER BY ${orderBy(q.sort, q.dir, { code: 'c.code', name: 'c.name' }, 'c.code')}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        role: r.role,
        person: r.contact_person || '',
        mobile: r.mobile || '',
        district: r.district || '',
        limit: num(r.credit_limit),
        days: num(r.credit_days),
        status: r.is_active ? 'Active' : 'On hold',
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

/* ---------------------------------------------------------------- products */

router.get(
  '/products',
  requirePermission('product.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'p.org_id = $1 AND p.is_active';
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`,
      params
    );
    const { rows } = await query(
      `SELECT p.id, p.code, p.name, pc.name AS category, b.name AS brand, u.code AS unit,
              p.purchase_rate, p.sale_rate, p.min_stock, p.tax_rate_id,
              t.code AS tax_code, t.rate AS tax_rate,
              COALESCE((SELECT SUM(s.quantity) FROM stock s
                         WHERE s.product_id = p.id AND s.item_type = 'PRODUCT'), 0) AS stock,
              -- What the stock is actually carried at. The catalogue purchase
              -- rate is what the next one should cost, not what these cost, so
              -- valuing at it disagrees with every other stock figure.
              COALESCE((SELECT ROUND(SUM(s.quantity * s.avg_cost), 2) FROM stock s
                         WHERE s.product_id = p.id AND s.item_type = 'PRODUCT'), 0) AS value
         FROM products p
         LEFT JOIN product_categories pc ON pc.id = p.category_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN tax_rates t ON t.id = p.tax_rate_id
         JOIN units u ON u.id = p.unit_id
        WHERE ${where}
        ORDER BY ${orderBy(q.sort, q.dir, { code: 'p.code', name: 'p.name' }, 'p.code')}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        cat: r.category || '',
        brand: r.brand || '',
        unit: r.unit,
        stock: num(r.stock),
        value: num(r.value),
        pur: num(r.purchase_rate),
        sale: num(r.sale_rate),
        min: num(r.min_stock),
        // Null means the organisation's default rate rather than none at all,
        // which the form has to be able to tell apart.
        taxRateId: r.tax_rate_id ? Number(r.tax_rate_id) : null,
        taxCode: r.tax_code || '',
        taxRate: r.tax_rate === null || r.tax_rate === undefined ? null : num(r.tax_rate),
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

/* ------------------------------------------------- warehouses and employees */

router.get(
  '/warehouses',
  requirePermission('inventory.view'),
  handler(async (req, res) => {
    // Carries what each godown is holding as well as its name, so the
    // warehouse screen and the dropdowns can share one route.
    const { rows } = await query(
      `SELECT w.id, w.code, w.name, w.district, w.is_active,
              COALESCE(st.lines, 0)    AS lines,
              COALESCE(st.quantity, 0) AS quantity,
              COALESCE(st.value, 0)    AS value
         FROM warehouses w
         LEFT JOIN (
           SELECT warehouse_id,
                  COUNT(*)                                  AS lines,
                  SUM(quantity)                             AS quantity,
                  ROUND(SUM(quantity * avg_cost), 2)        AS value
             FROM stock
            WHERE quantity > 0
            GROUP BY warehouse_id
         ) st ON st.warehouse_id = w.id
        WHERE w.org_id = $1 AND w.is_active
        ORDER BY w.id`,
      [req.orgId]
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        district: r.district || '',
        lines: Number(r.lines),
        quantity: num(r.quantity),
        value: num(r.value),
        status: r.is_active ? 'Active' : 'Closed',
      }))
    );
  })
);

router.get(
  '/employees',
  requirePermission('employee.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT e.id, e.code, e.name, e.designation, d.name AS department, e.mobile,
              to_char(e.joined_on, 'YYYY-MM-DD') AS joined_on, e.is_active,
              COALESCE((SELECT r.code FROM user_roles ur
                          JOIN roles r ON r.id = ur.role_id
                          JOIN users u ON u.id = ur.user_id
                         WHERE u.employee_id = e.id LIMIT 1), '—') AS role
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.org_id = $1
        ORDER BY e.code`,
      [req.orgId]
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        designation: r.designation || '',
        department: r.department || '',
        mobile: r.mobile || '',
        role: r.role,
        joined: r.joined_on || '',
        status: r.is_active ? 'Active' : 'Retired',
      }))
    );
  })
);

/* --------------------------------------------------------------- reference */

/**
 * Name-to-id maps for the lookups the screens work in by name (crops,
 * warehouses, units, grades). The UI has always dealt in names; this lets the
 * repository translate to ids on write without changing any screen.
 */
router.get(
  '/reference/context',
  handler(async (req, res) => {
    const [crops, warehouses, units, grades] = await Promise.all([
      query('SELECT id, name FROM crops WHERE org_id = $1 AND is_active', [req.orgId]),
      query('SELECT id, name FROM warehouses WHERE org_id = $1 AND is_active', [req.orgId]),
      query('SELECT id, code FROM units WHERE is_active'),
      query('SELECT id, name FROM crop_grades WHERE is_active'),
    ]);

    const toMap = (rows, key) =>
      Object.fromEntries(rows.map((r) => [r[key], Number(r.id)]));

    ok(res, {
      cropIds: toMap(crops.rows, 'name'),
      warehouseIds: toMap(warehouses.rows, 'name'),
      unitIds: toMap(units.rows, 'code'),
      gradeIds: toMap(grades.rows, 'name'),
    });
  })
);

/* ------------------------------------------------------------------ search */

/**
 * What the header search box looks across, and what each of them needs.
 *
 * The box searched every master with no check at all, which made it the one
 * way round the permission model: a warehouse clerk who cannot open the
 * Customers screen could type a name into the header and read the customer
 * list back, matched on mobile number. Each source is now gated by the same
 * permission as the screen behind it.
 */
const SEARCH_SOURCES = [
  {
    key: 'customers',
    permission: 'customer.view',
    sql: `SELECT code, name, district FROM customers
           WHERE org_id = $1 AND is_active
             AND (name ILIKE $2 OR code ILIKE $2 OR mobile ILIKE $2)
           LIMIT 5`,
  },
  {
    key: 'suppliers',
    permission: 'supplier.view',
    sql: `SELECT code, name, district FROM suppliers
           WHERE org_id = $1 AND is_active
             AND (name ILIKE $2 OR code ILIKE $2 OR mobile ILIKE $2)
           LIMIT 5`,
  },
  {
    key: 'companies',
    permission: 'company.view',
    sql: `SELECT code, name, role FROM companies
           WHERE org_id = $1 AND (name ILIKE $2 OR code ILIKE $2) LIMIT 5`,
  },
  {
    key: 'products',
    permission: 'product.view',
    sql: `SELECT code, name FROM products
           WHERE org_id = $1 AND is_active AND (name ILIKE $2 OR code ILIKE $2) LIMIT 5`,
  },
  {
    key: 'batches',
    permission: 'inventory.view',
    sql: `SELECT b.batch_no, c.name AS crop, b.quantity_remaining
            FROM crop_batches b JOIN crops c ON c.id = b.crop_id
           WHERE b.org_id = $1 AND b.quantity_remaining > 0
             AND (b.batch_no ILIKE $2 OR c.name ILIKE $2) LIMIT 5`,
    shape: (rows) =>
      rows.map((b) => ({
        batchNo: b.batch_no,
        crop: b.crop,
        remaining: num(b.quantity_remaining),
      })),
  },
];

/** Backs the header search box; one round trip across every master. */
router.get(
  '/search',
  handler(async (req, res) => {
    const q = parseQuery(z.object({ q: z.string().trim().min(1).max(80) }), req);
    const term = `%${q.q}%`;

    // A source this session may not see is never queried, rather than fetched
    // and filtered afterwards: what was not read cannot leak.
    const allowed = SEARCH_SOURCES.filter((source) =>
      req.user.permissions.includes(source.permission)
    );
    const results = await Promise.all(allowed.map((source) => query(source.sql, [req.orgId, term])));

    // Every key is present whatever the permissions, so a client reading one
    // finds an empty list rather than undefined -- and a group somebody may
    // not see reads exactly like a group with no matches, which is the point.
    const payload = Object.fromEntries(SEARCH_SOURCES.map((source) => [source.key, []]));
    allowed.forEach((source, i) => {
      payload[source.key] = source.shape ? source.shape(results[i].rows) : results[i].rows;
    });

    ok(res, payload);
  })
);

/* ----------------------------------------------------- master maintenance */

/**
 * Create, edit and retire, generated from one description per entity.
 *
 * Nothing here deletes. Master rows are referenced by posted documents, so a
 * retired party keeps naming itself on last season's reports and simply stops
 * being offered on new ones.
 */

const money = (n) => `Tk ${Math.round(n).toLocaleString('en-IN')}`;

const supplierSchema = z.object({
  bin: z.string().trim().max(24).optional(),
  vatRegistered: z.coerce.boolean().optional(),
  name: z.string().trim().min(1, 'Supplier name is required').max(200),
  bn: z.string().trim().max(200).optional().default(''),
  type: z.string().trim().max(40).default('Farmer'),
  mobile: z.string().trim().min(1, 'Mobile number is required').max(30),
  district: z.string().trim().max(80).optional().default(''),
  upazila: z.string().trim().max(80).optional().default(''),
  bank: z.string().trim().max(60).optional().default(''),
  opening: z.coerce.number().min(0).default(0),
});

const companySchema = z.object({
  bin: z.string().trim().max(24).optional(),
  vatRegistered: z.coerce.boolean().optional(),
  name: z.string().trim().min(1, 'Company name is required').max(200),
  role: z
    .enum(['PRINCIPAL', 'SUPPLIER', 'BUYER', 'SUPPLIER_AND_BUYER'])
    .default('SUPPLIER'),
  person: z.string().trim().max(120).optional().default(''),
  mobile: z.string().trim().max(30).optional().default(''),
  district: z.string().trim().max(80).optional().default(''),
  limit: z.coerce.number().min(0).default(0),
  days: z.coerce.number().int().min(0).max(365).default(0),
});

const cropSchema = z.object({
  taxRateId: z.coerce.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1, 'Crop name is required').max(120),
  unit: z.string().trim().min(1, 'Choose a unit').max(20).default('MT'),
  rate: z.coerce.number().min(0).default(0),
});

const warehouseSchema = z.object({
  name: z.string().trim().min(1, 'Warehouse name is required').max(160),
  district: z.string().trim().max(80).optional().default(''),
});

const employeeSchema = z.object({
  name: z.string().trim().min(1, 'Employee name is required').max(160),
  designation: z.string().trim().max(120).optional().default(''),
  department: z.string().trim().max(80).optional().default(''),
  mobile: z.string().trim().max(30).optional().default(''),
  joined: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-08-30')
    .optional(),
});

const productSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(200),
  taxRateId: z.coerce.number().int().positive().nullable().optional(),
  cat: z.string().trim().max(80).optional().default(''),
  brand: z.string().trim().max(80).optional().default(''),
  unit: z.string().trim().min(1, 'Choose a unit').max(20).default('Pcs'),
  pur: z.coerce.number().min(0).default(0),
  sale: z.coerce.number().min(0).default(0),
  min: z.coerce.number().min(0).default(0),
});

registerMasterCrud(router, {
  path: 'customers',
  table: 'customers',
  label: 'Customer',
  permissions: { create: 'customer.create', edit: 'customer.edit', remove: 'customer.delete' },
  code: { prefix: 'CUS', width: 3 },
  schema: customerSchema,
  tracksUser: true,
  columns: (b) => ({
    name: b.name,
    name_bn: b.bn || null,
    customer_type: b.type,
    contact_person: b.person || null,
    mobile: b.mobile,
    district: b.district || null,
    upazila: b.upazila || null,
    credit_limit: b.limit,
    credit_days: b.days,
    opening_balance: b.opening,
    bin_no: b.bin,
    is_vat_registered: b.vatRegistered,
  }),
  blockers: [
    {
      sql: `SELECT outstanding AS value FROM v_customer_outstanding
             WHERE customer_id = $1 AND org_id = $2`,
      code: 'HAS_OUTSTANDING',
      message: (n) =>
        `This customer still owes ${money(n)}. Collect or write off the balance before retiring them.`,
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    bn: r.name_bn || '',
    bin: r.bin_no || '',
    vatRegistered: r.is_vat_registered,
    type: r.customer_type,
    person: r.contact_person || '',
    mobile: r.mobile,
    district: r.district || '',
    upazila: r.upazila || '',
    limit: num(r.credit_limit),
    days: num(r.credit_days),
    status: r.is_active ? 'Active' : 'Retired',
    sales: 0,
    coll: 0,
    out: num(r.opening_balance),
    last: '—',
    b30: num(r.opening_balance),
    b60: 0,
    b90: 0,
    b90p: 0,
  }),
});

registerMasterCrud(router, {
  path: 'suppliers',
  table: 'suppliers',
  label: 'Supplier',
  permissions: { create: 'supplier.create', edit: 'supplier.edit', remove: 'supplier.delete' },
  code: { prefix: 'SUP', width: 3 },
  schema: supplierSchema,
  tracksUser: true,
  columns: (b) => ({
    name: b.name,
    name_bn: b.bn || null,
    supplier_type: b.type,
    mobile: b.mobile,
    district: b.district || null,
    upazila: b.upazila || null,
    bank_account: b.bank || null,
    opening_balance: b.opening,
    bin_no: b.bin,
    is_vat_registered: b.vatRegistered,
  }),
  blockers: [
    {
      sql: `SELECT outstanding AS value FROM v_supplier_outstanding
             WHERE supplier_id = $1 AND org_id = $2`,
      code: 'HAS_OUTSTANDING',
      message: (n) =>
        `${money(n)} is still payable to this supplier. Settle it before retiring them.`,
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    bn: r.name_bn || '',
    bin: r.bin_no || '',
    vatRegistered: r.is_vat_registered,
    type: r.supplier_type,
    mobile: r.mobile,
    district: r.district || '',
    upazila: r.upazila || '',
    bank: r.bank_account || '',
    status: r.is_active ? 'Active' : 'Retired',
    pur: 0,
    paid: 0,
    out: num(r.opening_balance),
  }),
});

registerMasterCrud(router, {
  path: 'companies',
  table: 'companies',
  label: 'Company',
  permissions: { create: 'company.create', edit: 'company.edit', remove: 'company.delete' },
  code: { prefix: 'CMP', width: 2 },
  schema: companySchema,
  columns: (b) => ({
    name: b.name,
    role: b.role,
    contact_person: b.person || null,
    mobile: b.mobile || null,
    district: b.district || null,
    credit_limit: b.limit,
    credit_days: b.days,
    bin_no: b.bin,
    is_vat_registered: b.vatRegistered,
  }),
  blockers: [
    {
      // A company can sit on both sides of the ledger, so both are checked.
      sql: `SELECT COALESCE((SELECT SUM(balance) FROM payables
                              WHERE party_type = 'COMPANY' AND party_id = $1 AND org_id = $2), 0)
                 + COALESCE((SELECT SUM(balance) FROM receivables
                              WHERE party_type = 'COMPANY' AND party_id = $1 AND org_id = $2), 0)
                 AS value`,
      code: 'HAS_OUTSTANDING',
      message: (n) =>
        `${money(n)} is still open with this company. Settle it before retiring them.`,
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    role: r.role,
    person: r.contact_person || '',
    mobile: r.mobile || '',
    district: r.district || '',
    limit: num(r.credit_limit),
    days: num(r.credit_days),
    status: r.is_active ? 'Active' : 'Retired',
  }),
});

registerMasterCrud(router, {
  path: 'crops',
  table: 'crops',
  label: 'Crop',
  permissions: { create: 'crop.create', edit: 'crop.edit', remove: 'crop.delete' },
  code: { prefix: 'CROP', width: 2 },
  schema: cropSchema,
  columns: (b) => ({ name: b.name, last_rate: b.rate, tax_rate_id: b.taxRateId }),
  // The screen knows unit codes, not the ids behind them.
  resolve: async (client, body) => {
    if (body.unit === undefined) return {};
    const { rows } = await client.query(
      'SELECT id FROM units WHERE code = $1 AND is_active',
      [body.unit]
    );
    if (!rows.length) throw notFound(`Unit ${body.unit}`);
    return { default_unit_id: Number(rows[0].id) };
  },
  blockers: [
    {
      sql: `SELECT COALESCE(SUM(quantity_remaining), 0) AS value FROM crop_batches
             WHERE crop_id = $1 AND org_id = $2 AND is_active`,
      code: 'HAS_STOCK',
      message: (n) =>
        `${n} is still in stock for this crop. Sell or write the batches off before retiring it.`,
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    rate: num(r.last_rate),
    unitId: Number(r.default_unit_id),
    status: r.is_active ? 'Active' : 'Retired',
  }),
});

/**
 * The small reference tables a master row points at by name.
 *
 * They are not shaped alike: categories and brands are shared across
 * organisations and can be retired, while departments belong to one
 * organisation and have no active flag at all. Describing that here keeps the
 * lookup honest instead of assuming every one of them has both columns.
 */
/**
 * A date column as YYYY-MM-DD.
 *
 * A `date` comes back from pg as a JS Date, and stringifying one gives
 * "Sat Aug 01". Reading the local parts rather than calling toISOString is
 * deliberate: pg parses a bare date into local midnight, so converting to UTC
 * would move it a day back east of Greenwich.
 */
const isoDate = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};

const REFERENCE_TABLES = {
  product_categories: { orgScoped: false, retirable: true },
  brands: { orgScoped: false, retirable: true },
  departments: { orgScoped: true, retirable: false },
};

/**
 * Resolve a reference row by name, creating nothing: a typo should not quietly
 * become a new brand that then appears in every picker.
 */
async function referenceId(client, table, name, orgId) {
  const shape = REFERENCE_TABLES[table];
  const params = [name];
  let where = 'lower(name) = lower($1)';
  if (shape.orgScoped) {
    params.push(orgId);
    where += ` AND org_id = $${params.length}`;
  }
  if (shape.retirable) where += ' AND is_active';

  const { rows } = await client.query(`SELECT id FROM ${table} WHERE ${where}`, params);
  return rows.length ? Number(rows[0].id) : null;
}

registerMasterCrud(router, {
  path: 'products',
  table: 'products',
  label: 'Product',
  permissions: { create: 'product.create', edit: 'product.edit', remove: 'product.delete' },
  code: { prefix: 'P', width: 4 },
  schema: productSchema,
  columns: (b) => ({
    name: b.name,
    purchase_rate: b.pur,
    sale_rate: b.sale,
    min_stock: b.min,
    // Null is a real answer: it means this product is charged at whatever the
    // organisation's default rate is, so a catalogue-wide change is one row.
    tax_rate_id: b.taxRateId,
  }),
  // The screen works in unit codes and category and brand names; the ids
  // behind them are not its business.
  resolve: async (client, body, orgId) => {
    const resolved = {};

    if (body.unit !== undefined) {
      const { rows } = await client.query(
        'SELECT id FROM units WHERE code = $1 AND is_active',
        [body.unit]
      );
      if (!rows.length) throw notFound(`Unit ${body.unit}`);
      resolved.unit_id = Number(rows[0].id);
    }

    // Category and brand are optional, so an empty one clears the column
    // rather than failing.
    if (body.cat !== undefined) {
      if (!body.cat) resolved.category_id = null;
      else {
        const id = await referenceId(client, 'product_categories', body.cat, orgId);
        if (!id) throw notFound(`Category ${body.cat}`);
        resolved.category_id = id;
      }
    }

    if (body.brand !== undefined) {
      if (!body.brand) resolved.brand_id = null;
      else {
        const id = await referenceId(client, 'brands', body.brand, orgId);
        if (!id) throw notFound(`Brand ${body.brand}`);
        resolved.brand_id = id;
      }
    }

    return resolved;
  },
  blockers: [
    {
      sql: `SELECT COALESCE(SUM(quantity), 0) AS value FROM stock
             WHERE product_id = $1 AND item_type = 'PRODUCT' AND org_id = $2`,
      code: 'HAS_STOCK',
      message: (n) =>
        `${n} of this product is still in stock. Sell or write it off before retiring it.`,
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    unitId: Number(r.unit_id),
    pur: num(r.purchase_rate),
    sale: num(r.sale_rate),
    min: num(r.min_stock),
    status: r.is_active ? 'Active' : 'Retired',
  }),
});

registerMasterCrud(router, {
  path: 'warehouses',
  table: 'warehouses',
  label: 'Warehouse',
  permissions: { create: 'warehouse.create', edit: 'warehouse.edit', remove: 'warehouse.delete' },
  code: { prefix: 'WH', width: 2 },
  schema: warehouseSchema,
  columns: (b) => ({ name: b.name, district: b.district || null }),
  blockers: [
    {
      sql: `SELECT COALESCE(SUM(quantity), 0) AS value FROM stock
             WHERE warehouse_id = $1 AND org_id = $2`,
      code: 'HAS_STOCK',
      message: (n) =>
        `${n} is still held in this warehouse. Transfer or write the stock off before closing it.`,
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    district: r.district || '',
    status: r.is_active ? 'Active' : 'Closed',
  }),
});

registerMasterCrud(router, {
  path: 'employees',
  table: 'employees',
  label: 'Employee',
  permissions: { create: 'employee.create', edit: 'employee.edit', remove: 'employee.delete' },
  code: { prefix: 'EMP', width: 2 },
  schema: employeeSchema,
  columns: (b) => ({
    name: b.name,
    designation: b.designation || null,
    mobile: b.mobile || null,
    joined_on: b.joined,
  }),
  resolve: async (client, body, orgId) => {
    if (body.department === undefined) return {};
    if (!body.department) return { department_id: null };
    const id = await referenceId(client, 'departments', body.department, orgId);
    if (!id) throw notFound(`Department ${body.department}`);
    return { department_id: id };
  },
  blockers: [
    {
      // Retiring someone whose login still works leaves an account nobody
      // owns. The account is deactivated first, deliberately.
      sql: `SELECT COUNT(*)::int AS value FROM users
             WHERE employee_id = $1 AND org_id = $2 AND is_active`,
      code: 'HAS_ACTIVE_LOGIN',
      message: () =>
        'This employee still has an active login. Deactivate the user account before retiring them.',
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    designation: r.designation || '',
    mobile: r.mobile || '',
    joined: isoDate(r.joined_on),
    status: r.is_active ? 'Active' : 'Retired',
  }),
});

/* ------------------------------------------------------------------- units */

/**
 * Units of measure.
 *
 * The Settings screen listed five of them and their conversions as fixed text,
 * which meant a business trading in a unit nobody thought of -- a 25 kg bag, a
 * quintal -- could not record it. Units are shared rather than org-scoped, and
 * carry no timestamps, which the generated CRUD already accommodates.
 */
const unitSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9 ]{0,15}$/, 'Use letters and digits, like Bag.'),
  name: z.string().trim().min(1).max(80),
  // How many base units one of this unit is worth: 1 Kg is 0.001 MT. A unit
  // with no base is a base itself, and a base is worth one of itself.
  factor: z.coerce.number().positive().default(1),
  base: z.string().trim().max(16).optional(),
});

router.get(
  '/units',
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.code, u.name, u.factor, u.is_active, b.code AS base_code
         FROM units u LEFT JOIN units b ON b.id = u.base_unit_id
        ORDER BY u.id`
    );
    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        factor: num(r.factor),
        base: r.base_code || '',
        active: r.is_active,
        status: r.is_active ? 'Active' : 'Retired',
      }))
    );
  })
);

registerMasterCrud(router, {
  path: 'units',
  table: 'units',
  label: 'Unit',
  permissions: { create: 'unit.create', edit: 'unit.edit', remove: 'unit.delete' },
  // The code is the unit itself -- MT, Kg, Maund -- so it is never allocated.
  code: { prefix: 'U', width: 2, fromBody: true },
  schema: unitSchema,
  orgScoped: false,
  timestamped: false,
  columns: (b) => ({ name: b.name, factor: b.factor }),
  resolve: async (client, body) => {
    if (body.base === undefined) return {};
    if (!body.base) return { base_unit_id: null };
    const { rows } = await client.query('SELECT id FROM units WHERE code = $1', [body.base]);
    if (!rows.length) throw notFound(`Unit ${body.base}`);
    return { base_unit_id: Number(rows[0].id) };
  },
  blockers: [
    {
      // Retiring the unit a crop or product is measured in would leave the
      // record with a quantity and nothing to say what of.
      // Units are shared rather than org-scoped, so the org id the blocker is
      // handed is not part of the question; it is bound and ignored.
      sql: `SELECT (SELECT COUNT(*) FROM products WHERE unit_id = $1 AND is_active)
                 + (SELECT COUNT(*) FROM crops WHERE default_unit_id = $1 AND is_active)
                 + (SELECT COUNT(*) FROM units WHERE base_unit_id = $1 AND is_active)
                 AS value,
                   $2::bigint AS org_id`,
      code: 'UNIT_IN_USE',
      message: (n) =>
        `${n} crop, product or unit still measures in this unit. Move them to another unit first.`,
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    factor: num(r.factor),
    active: r.is_active,
    status: r.is_active ? 'Active' : 'Retired',
  }),
});

/* ------------------------------------------- product categories and brands */

/**
 * What a product is classified by.
 *
 * The product form offers the categories and brands the catalogue already
 * uses, which is a dead end on an empty database: with no product carrying a
 * category there is none to choose, so none is ever set. These two routes are
 * what break that circle. Both tables are shared rather than org-scoped and
 * carry no timestamps, as expense categories do.
 */
const classificationSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(80),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]*$/, 'Use capitals, digits and underscores, like AGROCHEMICAL.')
    .max(24)
    .optional(),
});

/** In use by a product, so retiring it would leave that product unclassified. */
const inUseBy = (column) => ({
  sql: `SELECT COUNT(*)::int AS value, $2::bigint AS org_id
          FROM products WHERE ${column} = $1 AND is_active`,
  code: 'CLASSIFICATION_IN_USE',
  message: (n) =>
    `${n} active product${n === 1 ? ' is' : 's are'} filed under this. Move them first.`,
});

const presentClassification = (r) => ({
  id: Number(r.id),
  code: r.code,
  name: r.name,
  active: r.is_active,
  status: r.is_active ? 'Active' : 'Retired',
});

for (const entity of [
  {
    path: 'product-categories',
    table: 'product_categories',
    label: 'Product category',
    prefix: 'CAT',
    column: 'category_id',
    permissions: {
      create: 'product.category.create',
      edit: 'product.category.edit',
      remove: 'product.category.delete',
    },
  },
  {
    path: 'brands',
    table: 'brands',
    label: 'Brand',
    prefix: 'BRAND',
    column: 'brand_id',
    permissions: { create: 'brand.create', edit: 'brand.edit', remove: 'brand.delete' },
  },
]) {
  router.get(
    `/${entity.path}`,
    requirePermission('product.view'),
    handler(async (_req, res) => {
      const { rows } = await query(
        `SELECT id, code, name, is_active,
                (SELECT COUNT(*)::int FROM products p
                  WHERE p.${entity.column} = t.id AND p.is_active) AS products
           FROM ${entity.table} t ORDER BY name`
      );
      ok(
        res,
        rows.map((r) => ({ ...presentClassification(r), products: r.products }))
      );
    })
  );

  registerMasterCrud(router, {
    ...entity,
    // The code is optional; the next in sequence is allocated when it is omitted.
    code: { prefix: entity.prefix, width: 2, fromBody: true },
    schema: classificationSchema,
    orgScoped: false,
    timestamped: false,
    columns: (b) => ({ name: b.name }),
    blockers: [inUseBy(entity.column)],
    present: presentClassification,
  });
}

/* --------------------------------------------------------------- tax rates */

/**
 * VAT rates.
 *
 * Bangladesh has a standard rate, truncated rates for particular trades,
 * zero-rating and exemption, and the standard rate itself moves at a budget.
 * Every one of those is a row here rather than a number in a service, which is
 * what lets a business that starts paying the truncated rate on one product
 * line say so without anybody deploying anything.
 */
const taxRateSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9.]{1,12}$/, 'Use capitals, digits and dots, like VAT7.5.')
    .optional(),
  name: z.string().trim().min(1, 'A name is required').max(80),
  nameBn: z.string().trim().max(80).optional(),
  kind: z.enum(['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT']),
  rate: z.coerce.number().min(0).max(100).default(0),
  isReclaimable: z.coerce.boolean().default(true),
  isDefault: z.coerce.boolean().optional(),
});

const presentTaxRate = (r) => ({
  id: Number(r.id),
  code: r.code,
  name: r.name,
  nameBn: r.name_bn || '',
  kind: r.kind,
  rate: num(r.rate),
  isReclaimable: r.is_reclaimable,
  isDefault: r.is_default,
  active: r.is_active,
  status: r.is_active ? 'Active' : 'Retired',
});

router.get(
  '/tax-rates',
  requirePermission('tax.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT t.*,
              (SELECT COUNT(*)::int FROM products WHERE tax_rate_id = t.id) AS products,
              (SELECT COUNT(*)::int FROM crops    WHERE tax_rate_id = t.id) AS crops
         FROM tax_rates t
        WHERE t.org_id = $1
        ORDER BY t.is_default DESC, t.rate DESC, t.code`,
      [req.orgId]
    );
    ok(
      res,
      rows.map((r) => ({ ...presentTaxRate(r), products: r.products, crops: r.crops }))
    );
  })
);

registerMasterCrud(router, {
  path: 'tax-rates',
  table: 'tax_rates',
  label: 'Tax rate',
  permissions: { create: 'tax.create', edit: 'tax.edit', remove: 'tax.delete' },
  code: { prefix: 'TAX', width: 2, fromBody: true },
  schema: taxRateSchema,
  orgScoped: true,
  columns: (b) => ({
    name: b.name,
    name_bn: b.nameBn,
    kind: b.kind,
    // Zero-rated and exempt supplies carry no rate whatever was typed. The
    // table holds the same rule; saying it here turns a constraint violation
    // into a rate that is simply right.
    rate:
      b.rate === undefined && b.kind === undefined
        ? undefined
        : b.kind === 'ZERO' || b.kind === 'EXEMPT'
          ? 0
          : b.rate,
    // Tax paid on an exempt input is never reclaimable, whatever was ticked.
    is_reclaimable: b.kind === 'EXEMPT' ? false : b.isReclaimable,
  }),
  resolve: async (client, body, orgId) => {
    if (body.isDefault === undefined) return {};
    if (!body.isDefault) return { is_default: false };
    // Exactly one rate is the default, so claiming it releases the last one.
    // Both statements are in the caller's transaction, so the partial unique
    // index never sees two.
    await client.query('UPDATE tax_rates SET is_default = false WHERE org_id = $1', [orgId]);
    return { is_default: true };
  },
  blockers: [
    {
      // Retiring a rate a product still points at would leave that product
      // falling back to the default, quietly changing what it charges.
      sql: `SELECT (SELECT COUNT(*) FROM products WHERE tax_rate_id = $1 AND is_active)
                 + (SELECT COUNT(*) FROM crops    WHERE tax_rate_id = $1 AND is_active)
                 AS value, $2::bigint AS org_id`,
      code: 'TAX_RATE_IN_USE',
      message: (n) =>
        `${n} product or crop is charged at this rate. Move them to another rate first.`,
    },
  ],
  present: presentTaxRate,
});

export default router;