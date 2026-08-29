import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction, num } from '../lib/db.js';
import { handler, ok, parseBody, parseParams, idParamSchema, parseQuery, listQuerySchema, paginate, pageMeta } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { decide } from '../services/approvalService.js';
import { postCropPurchase } from '../services/cropPurchaseService.js';
import { postCropSale } from '../services/cropSaleService.js';
import { postDealerPurchase, postDealerSale } from '../services/dealerService.js';
import { formatDateTime } from '../services/workspaceService.js';

/**
 * Approval queue.
 *
 * Approving does two things in one transaction: records the decision, and
 * posts the document it unblocks. That way an approved purchase cannot sit in
 * limbo waiting for someone to remember to post it.
 */
const router = Router();

/** Which posting routine to run once a document is approved. */
const POSTERS = {
  crop_purchases: (client, ctx) => postCropPurchase(client, { ...ctx, purchaseId: ctx.entityId }),
  crop_sales: (client, ctx) => postCropSale(client, { ...ctx, saleId: ctx.entityId }),
  dealer_purchases: (client, ctx) => postDealerPurchase(client, { ...ctx, purchaseId: ctx.entityId }),
  dealer_sales: (client, ctx) => postDealerSale(client, { ...ctx, saleId: ctx.entityId }),
};

router.get(
  '/',
  requirePermission('approval.view'),
  handler(async (req, res) => {
    const q = parseQuery(
      listQuerySchema.extend({ status: z.enum(['PENDING', 'DECIDED', 'ALL']).default('ALL') }),
      req
    );
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'a.org_id = $1';
    if (q.status === 'PENDING') where += " AND a.status = 'PENDING'";
    if (q.status === 'DECIDED') where += " AND a.status <> 'PENDING'";

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM approvals a WHERE ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT a.id, a.request_no, a.entity_type, a.entity_id, a.reference_no, a.party_name,
              a.amount, a.reason, a.status, a.requested_at, a.decided_at,
              re.name AS requested_by, re.designation AS requested_by_role,
              de.name AS decided_by
         FROM approvals a
         JOIN users ru ON ru.id = a.requested_by
         LEFT JOIN employees re ON re.id = ru.employee_id
         LEFT JOIN users du ON du.id = a.decided_by
         LEFT JOIN employees de ON de.id = du.employee_id
        WHERE ${where}
        ORDER BY a.requested_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        requestNo: r.request_no,
        entityType: r.entity_type,
        entityId: Number(r.entity_id),
        reference: r.reference_no || '',
        party: r.party_name || '',
        amount: num(r.amount),
        reason: r.reason,
        status: r.status,
        requestedBy: `${r.requested_by || ''}${r.requested_by_role ? ` (${r.requested_by_role})` : ''}`,
        requestedAt: formatDateTime(r.requested_at),
        decidedBy: r.decided_by || '',
        decidedAt: r.decided_at ? formatDateTime(r.decided_at) : '',
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

/** Full action history for one request. */
router.get(
  '/:id/history',
  requirePermission('approval.view'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const { rows } = await query(
      `SELECT aa.action, aa.comment, aa.previous_status, aa.new_status, aa.acted_at,
              COALESCE(e.name, u.username) AS actor
         FROM approval_actions aa
         JOIN users u ON u.id = aa.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
        WHERE aa.approval_id = $1
        ORDER BY aa.acted_at ASC`,
      [id]
    );

    ok(
      res,
      rows.map((r) => ({
        action: r.action,
        actor: r.actor,
        comment: r.comment || '',
        from: r.previous_status,
        to: r.new_status,
        at: formatDateTime(r.acted_at),
      }))
    );
  })
);

const decisionSchema = z.object({
  approved: z.boolean(),
  comment: z.string().max(300).optional(),
});

router.post(
  '/:id/decide',
  requirePermission('approval.decide'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(decisionSchema, req);

    const result = await withTransaction(async (client) => {
      const decision = await decide(client, {
        orgId: req.orgId,
        approvalId: id,
        userId: req.user.id,
        approved: body.approved,
        comment: body.comment,
        actor: req.actor,
      });

      // Approving releases the document straight through to posting.
      if (body.approved) {
        const post = POSTERS[decision.entityType];
        if (post) {
          await post(client, {
            orgId: req.orgId,
            user: req.user,
            actor: req.actor,
            entityId: decision.entityId,
          });
        }
      }

      return decision;
    });

    ok(res, result);
  })
);

/** Configurable rules, shown on the Settings screen. */
router.get(
  '/rules',
  requirePermission('settings.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, code, name, entity_type, business_type, condition_type, threshold, is_active
         FROM approval_rules WHERE org_id = $1 ORDER BY id`,
      [req.orgId]
    );
    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        entityType: r.entity_type,
        businessType: r.business_type,
        condition: r.condition_type,
        threshold: num(r.threshold),
        active: r.is_active,
      }))
    );
  })
);

export default router;
