import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../lib/db.js';
import { handler, ok, created, parseBody, parseParams, idParamSchema } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { writeAudit, changedFields } from '../lib/audit.js';
import { notFound, unprocessable, conflict } from '../lib/errors.js';
import { DOC_LABELS, ENTITY_LABELS, loadSettings } from '../services/settingsService.js';

/**
 * Configuration the business owns.
 *
 * Reading needs `settings.view`, which Management holds alongside Admin, so a
 * director can see how the system is set up. Every write needs `settings.edit`,
 * which only Admin holds, and every write is audited: these are the values that
 * decide what gets approved, how documents are numbered and which year is open,
 * so a change to one has to be answerable for later.
 */
const router = Router();

router.get(
  '/',
  requirePermission('settings.view'),
  handler(async (req, res) => {
    ok(res, await loadSettings(req.orgId));
  })
);

/* ------------------------------------------------------------- organisation */

const organizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  systemName: z.string().trim().min(2).max(80),
  tradeLicenceNo: z.string().trim().max(60).optional(),
  binNo: z.string().trim().max(60).optional(),
  headOffice: z.string().trim().max(240).optional(),
  mobile: z.string().trim().max(40).optional(),
  email: z.string().trim().max(160).email().or(z.literal('')).optional(),
  currency: z.string().trim().length(3).optional(),
  defaultDistrict: z.string().trim().max(80).optional(),
  valuation: z.enum(['FIFO', 'WEIGHTED_AVERAGE']).optional(),
  // Registering turns VAT on across every document; until then the rates are
  // master data with nothing charging at them.
  vatRegistered: z.coerce.boolean().optional(),
  // Each side of the trade quotes its own way, so each is set on its own.
  salePricesIncludeTax: z.coerce.boolean().optional(),
  purchasePricesIncludeTax: z.coerce.boolean().optional(),
});

const ORGANIZATION_COLUMNS = {
  name: 'name',
  systemName: 'system_name',
  tradeLicenceNo: 'trade_licence_no',
  binNo: 'bin_no',
  headOffice: 'head_office',
  mobile: 'mobile',
  email: 'email',
  currency: 'currency_code',
  defaultDistrict: 'default_district',
  valuation: 'valuation_method',
  vatRegistered: 'is_vat_registered',
  salePricesIncludeTax: 'sale_prices_include_tax',
  purchasePricesIncludeTax: 'purchase_prices_include_tax',
};

router.patch(
  '/organization',
  requirePermission('settings.edit'),
  handler(async (req, res) => {
    const body = parseBody(organizationSchema.partial(), req);

    const record = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        'SELECT * FROM organizations WHERE id = $1 FOR UPDATE',
        [req.orgId]
      );
      if (!existing.length) throw notFound('Organisation');

      const changes = Object.entries(body)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [ORGANIZATION_COLUMNS[key], value]);
      if (!changes.length) return existing[0];

      const assignments = changes.map(([column], i) => `${column} = $${i + 1}`);
      const { rows } = await client.query(
        `UPDATE organizations SET ${assignments.join(', ')}, updated_at = now()
          WHERE id = $${changes.length + 1} RETURNING *`,
        [...changes.map(([, value]) => value), req.orgId]
      );

      const diff = changedFields(existing[0], rows[0]);
      if (diff) {
        await writeAudit(client, {
          actor: req.actor,
          entityType: 'organizations',
          entityId: req.orgId,
          action: 'UPDATE',
          ...diff,
          summary: `Company profile updated — ${Object.keys(diff.newValue).join(', ')}`,
        });
      }
      return rows[0];
    });

    ok(res, {
      id: Number(record.id),
      code: record.code,
      name: record.name,
      systemName: record.system_name,
      tradeLicenceNo: record.trade_licence_no || '',
      binNo: record.bin_no || '',
      headOffice: record.head_office || '',
      mobile: record.mobile || '',
      email: record.email || '',
      currency: record.currency_code,
      defaultDistrict: record.default_district || '',
      valuation: record.valuation_method,
    });
  })
);

/* ------------------------------------------------------------ fiscal years */

const fiscalYearSchema = z
  .object({
    code: z.string().trim().min(3).max(40),
    startsOn: z.string().date(),
    endsOn: z.string().date(),
    current: z.boolean().optional(),
  })
  .refine((v) => v.endsOn > v.startsOn, {
    message: 'The year must end after it starts.',
    path: ['endsOn'],
  });

/**
 * Make one year the current one, clearing whichever held it.
 *
 * There is a partial unique index enforcing a single current year per
 * organisation, so this has to clear before it sets or the second statement
 * violates it.
 */
async function makeCurrent(client, orgId, id) {
  await client.query(
    'UPDATE fiscal_years SET is_current = false WHERE org_id = $1 AND is_current AND id <> $2',
    [orgId, id]
  );
  await client.query('UPDATE fiscal_years SET is_current = true WHERE id = $1', [id]);
}

router.post(
  '/fiscal-years',
  requirePermission('settings.edit'),
  handler(async (req, res) => {
    const body = parseBody(fiscalYearSchema, req);

    const record = await withTransaction(async (client) => {
      const { rows: clash } = await client.query(
        `SELECT code FROM fiscal_years
          WHERE org_id = $1 AND (code = $2 OR (starts_on, ends_on) OVERLAPS ($3::date, $4::date))`,
        [req.orgId, body.code, body.startsOn, body.endsOn]
      );
      if (clash.length) {
        throw conflict(
          'FISCAL_YEAR_OVERLAPS',
          `${clash[0].code} already covers part of that span. Financial years cannot overlap.`
        );
      }

      const { rows } = await client.query(
        `INSERT INTO fiscal_years (org_id, code, starts_on, ends_on, is_current, is_closed)
         VALUES ($1,$2,$3,$4,false,false) RETURNING *`,
        [req.orgId, body.code, body.startsOn, body.endsOn]
      );
      if (body.current) await makeCurrent(client, req.orgId, Number(rows[0].id));

      await writeAudit(client, {
        actor: req.actor,
        entityType: 'fiscal_years',
        entityId: Number(rows[0].id),
        action: 'CREATE',
        newValue: { code: body.code, startsOn: body.startsOn, endsOn: body.endsOn },
        summary: `Financial year ${body.code} added`,
      });

      return rows[0];
    });

    created(res, { id: Number(record.id), code: record.code });
  })
);

const fiscalYearPatchSchema = z.object({
  current: z.boolean().optional(),
  closed: z.boolean().optional(),
});

router.patch(
  '/fiscal-years/:id',
  requirePermission('settings.edit'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(fiscalYearPatchSchema, req);

    const record = await withTransaction(async (client) => {
      const { rows: before } = await client.query(
        'SELECT * FROM fiscal_years WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [id, req.orgId]
      );
      if (!before.length) throw notFound('Financial year');
      const year = before[0];

      if (body.closed === true) {
        // Closing the year the business is trading in would leave nothing open
        // to post into, and the numbering, dashboard and reports all read the
        // current year. Make the successor current first.
        if (year.is_current) {
          throw unprocessable(
            'YEAR_IS_CURRENT',
            `${year.code} is the current financial year. Make another year current before closing it.`
          );
        }
        await client.query('UPDATE fiscal_years SET is_closed = true WHERE id = $1', [id]);
      }

      if (body.closed === false) {
        await client.query('UPDATE fiscal_years SET is_closed = false WHERE id = $1', [id]);
      }

      if (body.current === true) {
        // A closed year cannot also be the one being traded in.
        if (year.is_closed && body.closed !== false) {
          throw unprocessable(
            'YEAR_IS_CLOSED',
            `${year.code} is closed. Reopen it before making it current.`
          );
        }
        await makeCurrent(client, req.orgId, id);
      }

      const { rows: after } = await client.query('SELECT * FROM fiscal_years WHERE id = $1', [id]);
      const diff = changedFields(year, after[0]);
      if (diff) {
        await writeAudit(client, {
          actor: req.actor,
          entityType: 'fiscal_years',
          entityId: id,
          action: 'UPDATE',
          ...diff,
          summary:
            after[0].is_closed && !year.is_closed
              ? `Financial year ${year.code} closed`
              : after[0].is_current && !year.is_current
                ? `Financial year ${year.code} made current`
                : `Financial year ${year.code} reopened`,
        });
      }
      return after[0];
    });

    ok(res, {
      id: Number(record.id),
      code: record.code,
      current: record.is_current,
      closed: record.is_closed,
    });
  })
);

/* -------------------------------------------------------- document numbers */

const numberingSchema = z.object({
  // Capitals and digits only: the prefix goes into a document number that gets
  // read down a phone line and written on a delivery challan.
  prefix: z.string().trim().regex(/^[A-Z][A-Z0-9]{0,5}$/, 'Use 1–6 capitals or digits, like PC.'),
  padding: z.coerce.number().int().min(1).max(10),
});

router.patch(
  '/numbering/:docType',
  requirePermission('settings.edit'),
  handler(async (req, res) => {
    const { docType } = parseParams(
      z.object({ docType: z.enum(Object.keys(DOC_LABELS)) }),
      req
    );
    const body = parseBody(numberingSchema, req);

    const record = await withTransaction(async (client) => {
      // Two document types sharing a prefix would produce two different
      // documents with the same number in the same month.
      const { rows: taken } = await client.query(
        `SELECT doc_type FROM document_number_formats
          WHERE org_id = $1 AND prefix = $2 AND doc_type <> $3`,
        [req.orgId, body.prefix, docType]
      );
      if (taken.length) {
        throw conflict(
          'PREFIX_IN_USE',
          `${body.prefix} is already used by ${DOC_LABELS[taken[0].doc_type] || taken[0].doc_type}.`
        );
      }

      const { rows: before } = await client.query(
        'SELECT * FROM document_number_formats WHERE org_id = $1 AND doc_type = $2',
        [req.orgId, docType]
      );

      const { rows } = await client.query(
        `INSERT INTO document_number_formats (org_id, doc_type, prefix, padding)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, doc_type)
         DO UPDATE SET prefix = EXCLUDED.prefix, padding = EXCLUDED.padding
         RETURNING *`,
        [req.orgId, docType, body.prefix, body.padding]
      );

      const diff = changedFields(before[0] || {}, rows[0]);
      if (diff) {
        await writeAudit(client, {
          actor: req.actor,
          entityType: 'document_number_formats',
          entityId: Number(rows[0].id),
          action: before.length ? 'UPDATE' : 'CREATE',
          ...diff,
          summary:
            `${DOC_LABELS[docType]} numbering set to ` +
            `${body.prefix}-YYMM-${'#'.repeat(body.padding)}`,
        });
      }
      return rows[0];
    });

    ok(res, {
      docType,
      label: DOC_LABELS[docType],
      prefix: record.prefix,
      padding: record.padding,
      pattern: `${record.prefix}-YYMM-${'#'.repeat(record.padding)}`,
    });
  })
);

/* --------------------------------------------------------- approval limits */

const approvalRuleSchema = z.object({
  name: z.string().trim().min(3).max(160).optional(),
  threshold: z.coerce.number().min(0).nullable().optional(),
  active: z.boolean().optional(),
});

router.patch(
  '/approval-rules/:id',
  requirePermission('settings.edit'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(approvalRuleSchema, req);

    const record = await withTransaction(async (client) => {
      const { rows: before } = await client.query(
        'SELECT * FROM approval_rules WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [id, req.orgId]
      );
      if (!before.length) throw notFound('Approval rule');
      const rule = before[0];

      // An ALWAYS rule -- stock adjustments -- has nothing to compare against,
      // so a threshold on it would be a number that never gets read.
      if (body.threshold !== undefined && rule.condition_type === 'ALWAYS') {
        throw unprocessable(
          'RULE_HAS_NO_THRESHOLD',
          `${ENTITY_LABELS[rule.entity_type] || rule.entity_type} always requires ` +
            'approval, so there is no limit to set on it.'
        );
      }
      if (body.threshold === null && rule.condition_type !== 'ALWAYS') {
        throw unprocessable(
          'THRESHOLD_REQUIRED',
          `${rule.name} compares against a limit, so it needs one.`
        );
      }

      const changes = [];
      if (body.name !== undefined) changes.push(['name', body.name]);
      if (body.threshold !== undefined) changes.push(['threshold', body.threshold]);
      if (body.active !== undefined) changes.push(['is_active', body.active]);
      if (!changes.length) return rule;

      const { rows } = await client.query(
        `UPDATE approval_rules
            SET ${changes.map(([c], i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now()
          WHERE id = $${changes.length + 1} RETURNING *`,
        [...changes.map(([, v]) => v), id]
      );

      const diff = changedFields(rule, rows[0]);
      if (diff) {
        await writeAudit(client, {
          actor: req.actor,
          entityType: 'approval_rules',
          entityId: id,
          action: 'UPDATE',
          ...diff,
          summary: `Approval rule ${rule.code} updated`,
        });
      }
      return rows[0];
    });

    ok(res, {
      id: Number(record.id),
      code: record.code,
      name: record.name,
      entityType: record.entity_type,
      entityLabel: ENTITY_LABELS[record.entity_type] || record.entity_type,
      condition: record.condition_type,
      threshold: record.threshold === null ? null : Number(record.threshold),
      active: record.is_active,
    });
  })
);

/* ------------------------------------------------------- notification rules */

const notificationRuleSchema = z.object({
  threshold: z.coerce.number().min(0).nullable().optional(),
  active: z.boolean().optional(),
});

router.patch(
  '/notification-rules/:id',
  requirePermission('settings.edit'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(notificationRuleSchema, req);

    const record = await withTransaction(async (client) => {
      const { rows: before } = await client.query(
        'SELECT * FROM notification_rules WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [id, req.orgId]
      );
      if (!before.length) throw notFound('Notification rule');
      const rule = before[0];

      // The overdue and low-stock rules fire on a condition, not on a number.
      if (body.threshold !== undefined && body.threshold !== null && rule.threshold === null) {
        throw unprocessable(
          'RULE_HAS_NO_THRESHOLD',
          `${rule.name} fires on a condition rather than an amount.`
        );
      }

      const changes = [];
      if (body.threshold !== undefined && rule.threshold !== null) {
        changes.push(['threshold', body.threshold]);
      }
      if (body.active !== undefined) changes.push(['is_active', body.active]);
      if (!changes.length) return rule;

      const { rows } = await client.query(
        `UPDATE notification_rules
            SET ${changes.map(([c], i) => `${c} = $${i + 1}`).join(', ')}
          WHERE id = $${changes.length + 1} RETURNING *`,
        [...changes.map(([, v]) => v), id]
      );

      await writeAudit(client, {
        actor: req.actor,
        entityType: 'notification_rules',
        entityId: id,
        action: 'UPDATE',
        ...(changedFields(rule, rows[0]) || {}),
        summary: `Notification rule ${rule.name} ${rows[0].is_active ? 'switched on' : 'switched off'}`,
      });

      return rows[0];
    });

    ok(res, {
      id: Number(record.id),
      code: record.code,
      name: record.name,
      description: record.description || '',
      threshold: record.threshold === null ? null : Number(record.threshold),
      active: record.is_active,
    });
  })
);

export default router;
