import { num } from '../lib/db.js';
import { nextDocumentNo } from '../lib/numbering.js';
import { writeAudit } from '../lib/audit.js';
import { conflict, notFound, forbidden } from '../lib/errors.js';

/**
 * Approval engine.
 *
 * Rules live in `approval_rules` as data, so a limit change is a row update
 * rather than a deployment. A document that trips a rule goes to
 * PENDING_APPROVAL instead of POSTED, and only an approver can move it on.
 *
 * `approvals_one_pending_per_entity` is a partial unique index, so two users
 * submitting the same document race on the index and exactly one wins.
 */

/** Document tables an approval may govern, and their display names. */
export const APPROVABLE = {
  crop_purchases: 'Bulk Crop Purchase',
  crop_sales: 'Bulk Crop Sales',
  dealer_purchases: 'Dealer Purchase',
  dealer_sales: 'Dealer Sales',
  stock_adjustments: 'Stock Adjustment',
  expenses: 'Expense',
};

/**
 * Find the first active rule a document trips.
 *
 * @returns {Promise<{id:number, code:string, name:string, reason:string}|null>}
 */
export async function evaluateRules(client, { orgId, entityType, businessType, amount, discountPct }) {
  const { rows } = await client.query(
    `SELECT id, code, name, condition_type, threshold
       FROM approval_rules
      WHERE org_id = $1
        AND entity_type = $2
        AND is_active
        AND (business_type IS NULL OR business_type = $3)
      ORDER BY id`,
    [orgId, entityType, businessType ?? null]
  );

  for (const rule of rows) {
    const threshold = num(rule.threshold);

    if (rule.condition_type === 'ALWAYS') {
      return { id: Number(rule.id), code: rule.code, name: rule.name, reason: rule.name };
    }
    if (rule.condition_type === 'AMOUNT_ABOVE' && num(amount) > threshold) {
      return {
        id: Number(rule.id),
        code: rule.code,
        name: rule.name,
        reason: `Value above the ${threshold.toLocaleString('en-IN')} limit`,
      };
    }
    if (rule.condition_type === 'DISCOUNT_PCT_ABOVE' && num(discountPct) > threshold) {
      return {
        id: Number(rule.id),
        code: rule.code,
        name: rule.name,
        reason: `Discount ${num(discountPct).toFixed(2)}% exceeds the ${threshold}% ceiling`,
      };
    }
  }

  return null;
}

/**
 * Raise an approval request and move the document to PENDING_APPROVAL.
 * Called inside the posting transaction, so a document is never left pending
 * without its request, or vice versa.
 */
export async function requestApproval(client, req) {
  const requestNo = await nextDocumentNo(client, req.orgId, 'approval', req.date);

  const { rows } = await client.query(
    `INSERT INTO approvals
       (org_id, request_no, entity_type, entity_id, business_type, rule_id,
        reference_no, party_name, amount, reason, status, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11)
     RETURNING id, request_no`,
    [
      req.orgId,
      requestNo,
      req.entityType,
      req.entityId,
      req.businessType ?? null,
      req.ruleId ?? null,
      req.referenceNo ?? null,
      req.partyName ?? null,
      num(req.amount),
      req.reason,
      req.userId,
    ]
  );

  const approvalId = Number(rows[0].id);

  await client.query(
    `INSERT INTO approval_actions
       (approval_id, user_id, action, comment, previous_status, new_status, ip, user_agent)
     VALUES ($1,$2,'SUBMIT',$3,'PENDING','PENDING',$4,$5)`,
    [approvalId, req.userId, req.comment ?? null, req.actor?.ip ?? null, req.actor?.userAgent ?? null]
  );

  await client.query(
    `UPDATE ${req.entityType} SET status = 'PENDING_APPROVAL', updated_by = $1 WHERE id = $2`,
    [req.userId, req.entityId]
  );

  await writeAudit(client, {
    actor: req.actor,
    entityType: req.entityType,
    entityId: req.entityId,
    action: 'SUBMIT_APPROVAL',
    newValue: { requestNo: rows[0].request_no, reason: req.reason, amount: num(req.amount) },
    summary: `${APPROVABLE[req.entityType] || req.entityType} ${req.referenceNo || ''} sent for approval`,
  });

  return { id: approvalId, requestNo: rows[0].request_no };
}

/**
 * Approve or reject a pending request.
 *
 * The request row is locked first, so two approvers clicking at the same moment
 * cannot both record a decision -- the second sees it is no longer pending.
 */
export async function decide(client, { orgId, approvalId, userId, approved, comment, actor }) {
  const { rows } = await client.query(
    `SELECT id, entity_type, entity_id, reference_no, status, amount
       FROM approvals
      WHERE id = $1 AND org_id = $2
      FOR UPDATE`,
    [approvalId, orgId]
  );

  if (!rows.length) throw notFound('Approval request');
  const approval = rows[0];

  if (approval.status !== 'PENDING') {
    throw conflict(
      'APPROVAL_ALREADY_DECIDED',
      `This request was already ${approval.status.toLowerCase()}.`
    );
  }

  const newStatus = approved ? 'APPROVED' : 'REJECTED';

  await client.query(
    `UPDATE approvals
        SET status = $1, decided_by = $2, decided_at = now()
      WHERE id = $3`,
    [newStatus, userId, approvalId]
  );

  await client.query(
    `INSERT INTO approval_actions
       (approval_id, user_id, action, comment, previous_status, new_status, ip, user_agent)
     VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7)`,
    [
      approvalId,
      userId,
      approved ? 'APPROVE' : 'REJECT',
      comment ?? null,
      newStatus,
      actor?.ip ?? null,
      actor?.userAgent ?? null,
    ]
  );

  // An approved document becomes postable; a rejected one goes back to draft
  // so it can be corrected and resubmitted.
  await client.query(
    `UPDATE ${approval.entity_type} SET status = $1, updated_by = $2 WHERE id = $3`,
    [approved ? 'APPROVED' : 'DRAFT', userId, approval.entity_id]
  );

  await writeAudit(client, {
    actor,
    entityType: approval.entity_type,
    entityId: Number(approval.entity_id),
    action: approved ? 'APPROVE' : 'REJECT',
    oldValue: { status: 'PENDING_APPROVAL' },
    newValue: { status: approved ? 'APPROVED' : 'DRAFT', comment: comment ?? null },
    summary: `${approval.reference_no || approval.entity_type} ${approved ? 'approved' : 'rejected'}`,
  });

  return {
    id: approvalId,
    entityType: approval.entity_type,
    entityId: Number(approval.entity_id),
    status: newStatus,
  };
}

/** Guard used by routes: only these roles may decide. */
export function assertCanApprove(user) {
  if (!user.permissions.includes('approval.decide')) {
    throw forbidden('Only Admin and Management users can approve or reject requests.');
  }
}
