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
  orderBy,
  paginate,
  pageMeta,
  idParamSchema,
  parseParams,
} from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { writeAudit, changedFields } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';

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

router.post(
  '/customers',
  requirePermission('customer.create'),
  handler(async (req, res) => {
    const body = parseBody(customerSchema, req);

    const record = await withTransaction(async (client) => {
      // Codes are allocated under the transaction so two clerks adding a
      // customer at the same moment cannot land on the same one.
      const { rows: seq } = await client.query(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) + 1 AS next
           FROM customers WHERE org_id = $1`,
        [req.orgId]
      );
      const code = `CUS-${String(seq[0].next).padStart(3, '0')}`;

      const { rows } = await client.query(
        `INSERT INTO customers
           (org_id, code, name, name_bn, customer_type, contact_person, mobile,
            district, upazila, credit_limit, credit_days, opening_balance, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          req.orgId,
          code,
          body.name,
          body.bn || null,
          body.type,
          body.person || null,
          body.mobile,
          body.district || null,
          body.upazila || null,
          body.limit,
          body.days,
          body.opening,
          req.user.id,
        ]
      );

      await writeAudit(client, {
        actor: req.actor,
        entityType: 'customers',
        entityId: Number(rows[0].id),
        action: 'CREATE',
        newValue: { code, name: body.name, mobile: body.mobile, creditLimit: body.limit },
        summary: `Customer ${code} — ${body.name} created`,
      });

      return rows[0];
    });

    created(res, {
      id: Number(record.id),
      code: record.code,
      name: record.name,
      bn: record.name_bn || '',
      type: record.customer_type,
      person: record.contact_person || '',
      mobile: record.mobile,
      district: record.district || '',
      upazila: record.upazila || '',
      limit: num(record.credit_limit),
      days: num(record.credit_days),
      sales: 0,
      coll: 0,
      out: num(record.opening_balance),
      last: '—',
      b30: num(record.opening_balance),
      b60: 0,
      b90: 0,
      b90p: 0,
    });
  })
);

router.patch(
  '/customers/:id',
  requirePermission('customer.edit'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(customerSchema.partial(), req);

    const updated = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        'SELECT * FROM customers WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [id, req.orgId]
      );
      if (!existing.length) throw notFound('Customer');

      const before = existing[0];
      const { rows } = await client.query(
        `UPDATE customers SET
           name = COALESCE($1, name),
           name_bn = COALESCE($2, name_bn),
           customer_type = COALESCE($3, customer_type),
           contact_person = COALESCE($4, contact_person),
           mobile = COALESCE($5, mobile),
           district = COALESCE($6, district),
           upazila = COALESCE($7, upazila),
           credit_limit = COALESCE($8, credit_limit),
           credit_days = COALESCE($9, credit_days),
           updated_by = $10
         WHERE id = $11 RETURNING *`,
        [
          body.name ?? null,
          body.bn ?? null,
          body.type ?? null,
          body.person ?? null,
          body.mobile ?? null,
          body.district ?? null,
          body.upazila ?? null,
          body.limit ?? null,
          body.days ?? null,
          req.user.id,
          id,
        ]
      );

      const diff = changedFields(before, rows[0]);
      if (diff) {
        await writeAudit(client, {
          actor: req.actor,
          entityType: 'customers',
          entityId: id,
          action: 'UPDATE',
          ...diff,
          summary: `Customer ${before.code} updated`,
        });
      }
      return rows[0];
    });

    ok(res, { id: Number(updated.id), code: updated.code, name: updated.name });
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

export default router;
