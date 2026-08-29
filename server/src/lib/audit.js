import { config } from './config.js';

/**
 * Audit trail.
 *
 * Writes take the same client as the operation they describe, so the log entry
 * commits or rolls back with the change itself -- an audited action can never
 * be missing its record, and a rolled-back action never leaves a phantom one.
 */

/** Values that must never be written to the audit trail. */
const REDACTED = new Set(['password', 'password_hash', 'token', 'token_hash', 'secret']);

function scrub(value) {
  if (!value || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(scrub);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED.has(k) ? '[redacted]' : scrub(v);
  }
  return out;
}

/**
 * Record one mutation.
 *
 * @param {import('pg').PoolClient} client  the transaction's client
 * @param {object} entry
 * @param {object} entry.actor      request context: user id, ip, user agent
 * @param {string} entry.entityType table or domain name, e.g. 'dealer_sales'
 * @param {number|null} entry.entityId
 * @param {string} entry.action     CREATE | UPDATE | POST | CANCEL | APPROVE | ...
 * @param {object} [entry.oldValue]
 * @param {object} [entry.newValue]
 * @param {string} [entry.summary]  human-readable one-liner for the audit screen
 */
export async function writeAudit(client, entry) {
  const actor = entry.actor || {};
  await client.query(
    `INSERT INTO audit_logs
       (org_id, user_id, entity_type, entity_id, action, old_value, new_value,
        summary, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      actor.orgId ?? config.orgId,
      actor.userId ?? null,
      entry.entityType,
      entry.entityId ?? null,
      entry.action,
      entry.oldValue ? JSON.stringify(scrub(entry.oldValue)) : null,
      entry.newValue ? JSON.stringify(scrub(entry.newValue)) : null,
      entry.summary ?? null,
      actor.ip ?? null,
      actor.userAgent ?? null,
    ]
  );
}

/**
 * Diff two records and return only what actually changed, so the audit trail
 * stores the delta rather than a full copy of every row.
 */
export function changedFields(before, after) {
  const oldValue = {};
  const newValue = {};
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = before?.[key];
    const b = after?.[key];
    if (String(a ?? '') !== String(b ?? '')) {
      oldValue[key] = a ?? null;
      newValue[key] = b ?? null;
    }
  }
  return Object.keys(newValue).length ? { oldValue, newValue } : null;
}
