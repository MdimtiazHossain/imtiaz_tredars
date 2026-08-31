import { query, num } from '../lib/db.js';
import { loadPermissionMatrix } from './roleService.js';
import { DOC_PREFIXES } from '../lib/numbering.js';

/**
 * Everything the Settings screen shows, read from the tables that own it.
 *
 * The screen has nine panels and every one of them was a constant in the
 * browser: the company on its own invoices, the financial years, the numbering
 * patterns, the unit conversions, the approval limits, the valuation method,
 * the permission matrix and the notification rules. All of those are records a
 * system of record already keeps, so this reads them rather than restating
 * them, and the panels became editable in the same pass.
 *
 * Presentation stays in the browser. This returns the facts -- a threshold, a
 * factor, whether a role holds a permission -- and the screen decides what
 * colour a badge is.
 */

/* ------------------------------------------------------------- organisation */

export async function loadOrganization(orgId) {
  const { rows } = await query(
    `SELECT id, code, name, system_name, trade_licence_no, bin_no, head_office,
            mobile, email, currency_code, default_district, valuation_method
       FROM organizations WHERE id = $1`,
    [orgId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    code: r.code,
    name: r.name,
    systemName: r.system_name,
    tradeLicenceNo: r.trade_licence_no || '',
    binNo: r.bin_no || '',
    headOffice: r.head_office || '',
    mobile: r.mobile || '',
    email: r.email || '',
    currency: r.currency_code,
    defaultDistrict: r.default_district || '',
    valuation: r.valuation_method,
  };
}

/**
 * The costing method configured for the organisation.
 *
 * Read on its own rather than through `loadOrganization` because the crop sale
 * routes need one column and nothing else, on every post.
 */
export async function orgValuationMethod(orgId) {
  const { rows } = await query('SELECT valuation_method FROM organizations WHERE id = $1', [orgId]);
  return rows[0]?.valuation_method || 'FIFO';
}

/* ------------------------------------------------------------ fiscal years */

/**
 * Dates are formatted by PostgreSQL rather than in JavaScript.
 *
 * A `date` column has no timezone, and turning it into a JS `Date` only to
 * print it back invites the off-by-one this codebase already had once: the
 * driver produces local midnight, and any UTC-based getter then reports the
 * day before. `to_char` never leaves the database's own calendar.
 */
export async function loadFiscalYears(orgId) {
  const { rows } = await query(
    `SELECT id, code, is_current, is_closed,
            to_char(starts_on, 'YYYY-MM-DD') AS starts_iso,
            to_char(ends_on,   'YYYY-MM-DD') AS ends_iso,
            to_char(starts_on, 'DD Mon YYYY') AS starts_label,
            to_char(ends_on,   'DD Mon YYYY') AS ends_label
       FROM fiscal_years WHERE org_id = $1 ORDER BY starts_on DESC`,
    [orgId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    // Both forms: the screen prints the span, a date input needs the ISO one.
    startsOn: r.starts_iso,
    endsOn: r.ends_iso,
    span: `${r.starts_label} – ${r.ends_label}`,
    current: r.is_current,
    closed: r.is_closed,
    status: r.is_current ? 'Current' : r.is_closed ? 'Closed' : 'Open',
  }));
}

/* -------------------------------------------------------- document numbers */

/** What each document type is called on the numbering panel. */
export const DOC_LABELS = {
  crop_purchase: 'Crop purchase',
  crop_sale: 'Crop sale',
  dealer_purchase: 'Dealer purchase',
  dealer_sale: 'Dealer sale',
  crop_batch: 'Batch / lot',
  receipt: 'Receipt',
  payment: 'Payment voucher',
  expense: 'Expense',
  adjustment: 'Stock adjustment',
  transfer: 'Stock transfer',
  movement: 'Stock movement',
  approval: 'Approval request',
};

export async function loadNumbering(orgId) {
  const [formats, sequences] = await Promise.all([
    query(
      'SELECT doc_type, prefix, padding FROM document_number_formats WHERE org_id = $1',
      [orgId]
    ),
    // The highest counter reached in any period, so the panel can say what the
    // next number of each type will look like rather than only its pattern.
    query(
      `SELECT DISTINCT ON (doc_type) doc_type, period, next_value
         FROM document_sequences WHERE org_id = $1
        ORDER BY doc_type, period DESC`,
      [orgId]
    ),
  ]);

  const configured = new Map(formats.rows.map((r) => [r.doc_type, r]));
  const latest = new Map(sequences.rows.map((r) => [r.doc_type, r]));

  return Object.keys(DOC_LABELS).map((docType) => {
    const format = configured.get(docType);
    const prefix = format?.prefix || DOC_PREFIXES[docType];
    const padding = format?.padding ?? (docType === 'approval' ? 4 : 3);
    const seq = latest.get(docType);
    return {
      docType,
      label: DOC_LABELS[docType],
      prefix,
      padding,
      // 'PC-YYMM-###' — the pattern the panel has always shown, now assembled
      // from the prefix and padding actually in force.
      pattern: `${prefix}-YYMM-${'#'.repeat(padding)}`,
      issued: seq ? Number(seq.next_value) - 1 : 0,
      lastPeriod: seq ? seq.period : '',
      configured: !!format,
    };
  });
}

/* ------------------------------------------------------------------- units */

export async function loadUnits() {
  const { rows } = await query(
    `SELECT u.id, u.code, u.name, u.factor, u.is_active, b.code AS base_code
       FROM units u LEFT JOIN units b ON b.id = u.base_unit_id
      ORDER BY u.id`
  );
  return rows.map((r) => {
    const factor = num(r.factor);
    return {
      id: Number(r.id),
      code: r.code,
      name: r.name,
      factor,
      base: r.base_code || '',
      active: r.is_active,
      status: r.is_active ? 'Active' : 'Retired',
      // 'base unit for crops', or '1 MT = 1,000 Kg'. Derived from the two
      // columns that state the relationship instead of being written out.
      conversion:
        !r.base_code || !factor
          ? 'base unit'
          : `1 ${r.base_code} = ${formatFactor(1 / factor)} ${r.code}`,
    };
  });
}

/** Conversions are rarely round; show enough digits without a trail of zeros. */
function formatFactor(value) {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded.toLocaleString('en-IN', { maximumFractionDigits: 4 });
}

/* --------------------------------------------------------- approval limits */

/** What the rule applies to, in the words the screen uses. */
export const ENTITY_LABELS = {
  crop_purchases: 'Crop purchase',
  crop_sales: 'Crop sale',
  dealer_purchases: 'Dealer purchase',
  dealer_sales: 'Dealer sale',
  stock_adjustments: 'Stock adjustment',
  expenses: 'Expense',
};

export async function loadApprovalRules(orgId) {
  const { rows } = await query(
    `SELECT id, code, name, entity_type, business_type, condition_type, threshold, is_active
       FROM approval_rules WHERE org_id = $1 ORDER BY id`,
    [orgId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    entityType: r.entity_type,
    entityLabel: ENTITY_LABELS[r.entity_type] || r.entity_type,
    businessType: r.business_type,
    condition: r.condition_type,
    threshold: r.threshold === null ? null : num(r.threshold),
    active: r.is_active,
  }));
}

/* ----------------------------------------------------- notification rules */

export async function loadNotificationRules(orgId) {
  const { rows } = await query(
    `SELECT id, code, name, description, threshold, is_active
       FROM notification_rules WHERE org_id = $1 ORDER BY id`,
    [orgId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    description: r.description || '',
    threshold: r.threshold === null ? null : num(r.threshold),
    // Day counts and taka amounts read differently; the screen needs to know
    // which it is holding to label the field and format the value.
    unit: r.code === 'SUPPLIER_DUE' || r.code === 'DEAD_STOCK' ? 'days' : 'amount',
    active: r.is_active,
  }));
}

/* ------------------------------------------------------ roles and permissions */

/**
 * The matrix lives with the writes that change it.
 *
 * It was computed here while it was only ever read. Now that a grant can be
 * moved from the screen, the table and the writes that alter it belong
 * together in `roleService`, and this passes it through so the Settings screen
 * still arrives in one round trip.
 */
export { loadPermissionMatrix } from './roleService.js';

/* ------------------------------------------------------------------ the lot */

/** One round trip for the whole Settings screen. */
export async function loadSettings(orgId) {
  const [organization, fiscalYears, numbering, units, approvalRules, notificationRules, permissions] =
    await Promise.all([
      loadOrganization(orgId),
      loadFiscalYears(orgId),
      loadNumbering(orgId),
      loadUnits(),
      loadApprovalRules(orgId),
      loadNotificationRules(orgId),
      loadPermissionMatrix(),
    ]);

  return { organization, fiscalYears, numbering, units, approvalRules, notificationRules, permissions };
}
