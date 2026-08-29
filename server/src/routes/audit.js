import { Router } from 'express';
import { query } from '../lib/db.js';
import { handler, ok, parseQuery, listQuerySchema, paginate, pageMeta } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { formatDateTime } from '../services/workspaceService.js';

/**
 * Audit trail. Read-only by construction: the table refuses UPDATE and DELETE
 * at the database level, so there is no endpoint that could alter history.
 */
const router = Router();

router.get(
  '/',
  requirePermission('audit.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'a.org_id = $1';
    if (q.from) {
      params.push(q.from);
      where += ` AND a.created_at >= $${params.length}::date`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND a.created_at < ($${params.length}::date + 1)`;
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (a.entity_type ILIKE $${params.length} OR a.summary ILIKE $${params.length})`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM audit_logs a WHERE ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT a.created_at, a.entity_type, a.entity_id, a.action, a.old_value,
              a.new_value, a.summary, a.ip,
              COALESCE(e.name, u.username, 'system') AS actor
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
        WHERE ${where}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        when: formatDateTime(r.created_at),
        at: r.created_at,
        user: r.actor,
        action: r.action,
        entity: r.entity_type,
        entityId: r.entity_id ? Number(r.entity_id) : null,
        summary: r.summary || '',
        oldValue: r.old_value,
        newValue: r.new_value,
        ip: r.ip,
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

export default router;
