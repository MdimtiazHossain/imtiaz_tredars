import { withTransaction } from '../lib/db.js';
import {
  handler,
  ok,
  created,
  parseBody,
  parseParams,
  idParamSchema,
} from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { writeAudit, changedFields } from '../lib/audit.js';
import { notFound, unprocessable } from '../lib/errors.js';

/**
 * Create, edit and deactivate for master data.
 *
 * Customers, suppliers, companies, crops and products differ in their columns
 * and in nothing else: each allocates a code, inserts a row, patches the
 * fields that were sent, writes an audit entry, and retires rather than
 * deletes. Written out per entity that is five copies of the same hundred
 * lines, and the copies drift — which is how customers ended up with an edit
 * route while suppliers did not.
 *
 * So each entity is described once, in `masters.js`, and the routes are
 * generated from the description. Adding the next one is a descriptor, not a
 * route file.
 */

/**
 * Allocate the next code for an entity, inside the caller's transaction.
 *
 * Reading the maximum under the transaction is what stops two clerks adding a
 * supplier at the same moment from landing on the same code. The numeric part
 * is extracted rather than assumed, so `SUP-007` and a hand-entered `SUP-7`
 * still order correctly.
 */
async function nextCode(client, { table, orgId, prefix, width }) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) + 1 AS next
       FROM ${table} WHERE org_id = $1`,
    [orgId]
  );
  return `${prefix}-${String(rows[0].next).padStart(width, '0')}`;
}

/** Columns whose value was actually supplied, so a PATCH leaves the rest alone. */
const supplied = (columns) =>
  Object.entries(columns).filter(([, value]) => value !== undefined);

/**
 * Refuse a deactivation that would hide something still live.
 *
 * Retiring a supplier you still owe, or a crop still sitting in a godown,
 * removes it from every picker while the obligation stays on the books. That
 * is a worse outcome than refusing, so the blocker says what is in the way.
 */
async function checkBlockers(client, entity, id, orgId) {
  for (const blocker of entity.blockers || []) {
    const { rows } = await client.query(blocker.sql, [id, orgId]);
    const amount = Number(rows[0]?.value || 0);
    if (amount > 0) throw unprocessable(blocker.code, blocker.message(amount));
  }
}

/** Read one row for the org, locked, or fail with a message naming the entity. */
async function loadRow(client, entity, id, orgId) {
  const { rows } = await client.query(
    `SELECT * FROM ${entity.table} WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [id, orgId]
  );
  if (!rows.length) throw notFound(entity.label);
  return rows[0];
}

/**
 * Register POST / PATCH / DELETE for one master entity.
 *
 * @param {import('express').Router} router
 * @param {object} entity
 * @param {string} entity.path       URL segment, e.g. 'suppliers'
 * @param {string} entity.table
 * @param {string} entity.label      how the entity is named in a message
 * @param {object} entity.permissions  {create, edit, remove}
 * @param {object} entity.code       {prefix, width}
 * @param {import('zod').ZodTypeAny} entity.schema
 * @param {(body:object) => object} entity.columns  column name -> value
 * @param {(row:object) => object} entity.present   the API shape
 * @param {boolean} [entity.tracksUser]  table has created_by / updated_by
 * @param {Array}  [entity.blockers]     reasons a deactivation is refused
 * @param {(client:object, body:object, orgId:number) => Promise<object>} [entity.resolve]
 *   extra columns needing a lookup, so a screen can send a unit code or a
 *   brand name rather than an id it has no reason to know
 */
export function registerMasterCrud(router, entity) {
  const { path, table, label, permissions } = entity;

  router.post(
    `/${path}`,
    requirePermission(permissions.create),
    handler(async (req, res) => {
      const body = parseBody(entity.schema, req);

      const record = await withTransaction(async (client) => {
        const code = await nextCode(client, {
          table,
          orgId: req.orgId,
          prefix: entity.code.prefix,
          width: entity.code.width,
        });

        const resolved = entity.resolve ? await entity.resolve(client, body, req.orgId) : {};
        const columns = { code, ...entity.columns(body), ...resolved };
        if (entity.tracksUser) columns.created_by = req.user.id;
        columns.org_id = req.orgId;

        const names = Object.keys(columns);
        const { rows } = await client.query(
          `INSERT INTO ${table} (${names.join(', ')})
           VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
           RETURNING *`,
          Object.values(columns)
        );

        await writeAudit(client, {
          actor: req.actor,
          entityType: table,
          entityId: Number(rows[0].id),
          action: 'CREATE',
          newValue: { code, name: body.name },
          summary: `${label} ${code} — ${body.name} created`,
        });

        return rows[0];
      });

      created(res, entity.present(record));
    })
  );

  router.patch(
    `/${path}/:id`,
    requirePermission(permissions.edit),
    handler(async (req, res) => {
      const { id } = parseParams(idParamSchema, req);
      // `.partial()` so a screen can send only what the operator changed.
      const body = parseBody(entity.schema.partial(), req);

      const record = await withTransaction(async (client) => {
        const before = await loadRow(client, entity, id, req.orgId);

        const resolved = entity.resolve ? await entity.resolve(client, body, req.orgId) : {};
        const changes = supplied({ ...entity.columns(body), ...resolved });
        if (!changes.length) return before;
        if (entity.tracksUser) changes.push(['updated_by', req.user.id]);

        const assignments = changes.map(([name], i) => `${name} = $${i + 1}`);
        const values = changes.map(([, value]) => value);
        const { rows } = await client.query(
          `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = now()
            WHERE id = $${values.length + 1} RETURNING *`,
          [...values, id]
        );

        const diff = changedFields(before, rows[0]);
        if (diff) {
          await writeAudit(client, {
            actor: req.actor,
            entityType: table,
            entityId: id,
            action: 'UPDATE',
            ...diff,
            summary: `${label} ${before.code} updated`,
          });
        }
        return rows[0];
      });

      ok(res, entity.present(record));
    })
  );

  router.delete(
    `/${path}/:id`,
    requirePermission(permissions.remove),
    handler(async (req, res) => {
      const { id } = parseParams(idParamSchema, req);

      const record = await withTransaction(async (client) => {
        const before = await loadRow(client, entity, id, req.orgId);
        if (!before.is_active) {
          throw unprocessable('ALREADY_INACTIVE', `${label} ${before.code} is already retired.`);
        }

        await checkBlockers(client, entity, id, req.orgId);

        // Never a DELETE: the row is referenced by posted documents, and a
        // report covering last season has to keep naming the party it was
        // actually traded with.
        const userColumn = entity.tracksUser ? ', updated_by = $2' : '';
        const { rows } = await client.query(
          `UPDATE ${table} SET is_active = false, updated_at = now()${userColumn}
            WHERE id = $1 RETURNING *`,
          entity.tracksUser ? [id, req.user.id] : [id]
        );

        await writeAudit(client, {
          actor: req.actor,
          entityType: table,
          entityId: id,
          action: 'DEACTIVATE',
          oldValue: { isActive: true },
          newValue: { isActive: false },
          summary: `${label} ${before.code} — ${before.name} retired`,
        });

        return rows[0];
      });

      ok(res, entity.present(record));
    })
  );
}
