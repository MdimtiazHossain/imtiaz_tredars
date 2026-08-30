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
              p.purchase_rate, p.sale_rate, p.min_stock,
              COALESCE((SELECT SUM(s.quantity) FROM stock s
                         WHERE s.product_id = p.id AND s.item_type = 'PRODUCT'), 0) AS stock
         FROM products p
         LEFT JOIN product_categories pc ON pc.id = p.category_id
         LEFT JOIN brands b ON b.id = p.brand_id
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
        pur: num(r.purchase_rate),
        sale: num(r.sale_rate),
        min: num(r.min_stock),
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
    const { rows } = await query(
      'SELECT id, code, name, district FROM warehouses WHERE org_id = $1 AND is_active ORDER BY id',
      [req.orgId]
    );
    ok(res, rows.map((r) => ({ id: Number(r.id), code: r.code, name: r.name, district: r.district })));
  })
);

router.get(
  '/employees',
  requirePermission('employee.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT e.code, e.name, e.designation, d.name AS department, e.mobile,
              e.joined_on, e.is_active,
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
        code: r.code,
        name: r.name,
        designation: r.designation || '',
        department: r.department || '',
        mobile: r.mobile || '',
        role: r.role,
        joined: r.joined_on,
        status: r.is_active ? 'Active' : 'Inactive',
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

/** Backs the header search box; one round trip across every master. */
router.get(
  '/search',
  handler(async (req, res) => {
    const q = parseQuery(z.object({ q: z.string().trim().min(1).max(80) }), req);
    const term = `%${q.q}%`;

    const [customers, suppliers, companies, products, batches] = await Promise.all([
      query(
        `SELECT code, name, district FROM customers
          WHERE org_id = $1 AND is_active AND (name ILIKE $2 OR code ILIKE $2 OR mobile ILIKE $2)
          LIMIT 5`,
        [req.orgId, term]
      ),
      query(
        `SELECT code, name, district FROM suppliers
          WHERE org_id = $1 AND is_active AND (name ILIKE $2 OR code ILIKE $2 OR mobile ILIKE $2)
          LIMIT 5`,
        [req.orgId, term]
      ),
      query(
        `SELECT code, name, role FROM companies
          WHERE org_id = $1 AND (name ILIKE $2 OR code ILIKE $2) LIMIT 5`,
        [req.orgId, term]
      ),
      query(
        `SELECT code, name FROM products
          WHERE org_id = $1 AND is_active AND (name ILIKE $2 OR code ILIKE $2) LIMIT 5`,
        [req.orgId, term]
      ),
      query(
        `SELECT b.batch_no, c.name AS crop, b.quantity_remaining
           FROM crop_batches b JOIN crops c ON c.id = b.crop_id
          WHERE b.org_id = $1 AND b.quantity_remaining > 0
            AND (b.batch_no ILIKE $2 OR c.name ILIKE $2) LIMIT 5`,
        [req.orgId, term]
      ),
    ]);

    ok(res, {
      customers: customers.rows,
      suppliers: suppliers.rows,
      companies: companies.rows,
      products: products.rows,
      batches: batches.rows.map((b) => ({
        batchNo: b.batch_no,
        crop: b.crop,
        remaining: num(b.quantity_remaining),
      })),
    });
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
  name: z.string().trim().min(1, 'Crop name is required').max(120),
  unit: z.string().trim().min(1, 'Choose a unit').max(20).default('MT'),
  rate: z.coerce.number().min(0).default(0),
});

const productSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(200),
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
  columns: (b) => ({ name: b.name, last_rate: b.rate }),
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
 * Look up a row by name in one of the small reference tables a product points
 * at, creating nothing: a typo should not quietly become a new brand.
 *
 * Categories and brands are shared across organisations rather than owned by
 * one, so there is no org_id to filter on here.
 */
async function referenceId(client, table, name) {
  const { rows } = await client.query(
    `SELECT id FROM ${table} WHERE lower(name) = lower($1) AND is_active`,
    [name]
  );
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
  }),
  // The screen works in unit codes and category and brand names; the ids
  // behind them are not its business.
  resolve: async (client, body) => {
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
        const id = await referenceId(client, 'product_categories', body.cat);
        if (!id) throw notFound(`Category ${body.cat}`);
        resolved.category_id = id;
      }
    }

    if (body.brand !== undefined) {
      if (!body.brand) resolved.brand_id = null;
      else {
        const id = await referenceId(client, 'brands', body.brand);
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

export default router;
