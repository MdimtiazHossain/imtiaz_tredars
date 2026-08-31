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
  paginate,
  pageMeta,
} from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';

import { nextDocumentNo } from '../lib/numbering.js';
import { writeAudit } from '../lib/audit.js';
import { profitAndLoss, trialBalance, balanceSheet } from '../services/statementService.js';
import {
  allocatePayment,
  writeLedger,
  ledgerAccount,
  cashAccountFor,
  expenseAccountFor,
  LEDGER,
} from '../services/financeService.js';
import { evaluateRules, requestApproval } from '../services/approvalService.js';
import { badRequest, notFound } from '../lib/errors.js';
import { registerMasterCrud } from './masterCrud.js';

/** Payments, expenses, cash/bank accounts, receivables and payables. */
const router = Router();

/**
 * Narrowing a listing to one party is what the payment form allocates against.
 * Shared so the receivable and payable listings filter identically.
 */
const partyFilter = {
  partyType: z.enum(['CUSTOMER', 'SUPPLIER', 'COMPANY']).optional(),
  partyId: z.coerce.number().int().positive().optional(),
};

/* ------------------------------------------------------------------ accounts */

router.get(
  '/accounts',
  requirePermission('payment.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.id, a.code, a.name, a.account_type, a.opening_balance,
              a.opening_balance
                + COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger_entries l
                             WHERE l.account_id = a.id), 0) AS balance,
              (SELECT MAX(l.entry_date) FROM ledger_entries l
                WHERE l.account_id = a.id) AS last_movement
         FROM accounts a
        WHERE a.org_id = $1 AND a.is_active
        ORDER BY a.id`,
      [req.orgId]
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        type: r.account_type,
        balance: num(r.balance),
        lastMovement: r.last_movement,
      }))
    );
  })
);

router.get(
  '/expense-categories',
  requirePermission('expense.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT c.id, c.code, c.name, c.is_active,
              COALESCE(e.vouchers, 0) AS vouchers,
              COALESCE(e.spent, 0)    AS spent
         FROM expense_categories c
         LEFT JOIN (
           SELECT category_id, COUNT(*) AS vouchers, SUM(amount) AS spent
             FROM expenses
            WHERE org_id = $1 AND status = 'POSTED'
            GROUP BY category_id
         ) e ON e.category_id = c.id
        WHERE c.is_active
        ORDER BY c.id`,
      [req.orgId]
    );

    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        vouchers: Number(r.vouchers),
        spent: num(r.spent),
        status: r.is_active ? 'Active' : 'Retired',
      }))
    );
  })
);

router.get(
  '/payment-methods',
  requirePermission('payment.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT m.id, m.code, m.name, m.account_id, m.is_active,
              a.name AS account, a.code AS account_code
         FROM payment_methods m
         LEFT JOIN accounts a ON a.id = m.account_id
        WHERE m.org_id = $1 ORDER BY m.id`,
      [req.orgId]
    );
    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        accountId: r.account_id ? Number(r.account_id) : null,
        // The account this method pays into, named rather than only numbered,
        // so a screen can say where the money lands.
        account: r.account || '',
        accountCode: r.account_code || '',
        active: r.is_active,
        status: r.is_active ? 'Active' : 'Retired',
      }))
    );
  })
);

/* ------------------------------------------------------ receivable / payable */

router.get(
  '/receivables',
  requirePermission('payment.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema.extend(partyFilter), req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'r.org_id = $1 AND NOT r.is_settled';
    if (q.businessType !== 'ALL') {
      params.push(q.businessType);
      where += ` AND r.business_type = $${params.length}`;
    }
    // Narrowing to one party is what the payment form allocates against.
    if (q.partyType) {
      params.push(q.partyType);
      where += ` AND r.party_type = $${params.length}`;
    }
    if (q.partyId) {
      params.push(q.partyId);
      where += ` AND r.party_id = $${params.length}`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(balance), 0) AS outstanding
         FROM receivables r WHERE ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT r.invoice_no, r.invoice_type, r.invoice_id, r.invoice_date, r.due_date,
              r.invoice_amount, r.paid_amount, r.balance, r.business_type,
              COALESCE(c.name, co.name) AS party,
              COALESCE(c.customer_type, 'Company') AS party_type,
              a.aging_bucket, a.days_overdue
         FROM receivables r
         LEFT JOIN customers c ON r.party_type = 'CUSTOMER' AND c.id = r.party_id
         LEFT JOIN companies co ON r.party_type = 'COMPANY' AND co.id = r.party_id
         LEFT JOIN v_receivable_aging a
                ON a.invoice_type = r.invoice_type AND a.invoice_id = r.invoice_id
        WHERE ${where}
        ORDER BY r.due_date ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        invoiceNo: r.invoice_no,
        invoiceType: r.invoice_type,
        invoiceId: Number(r.invoice_id),
        party: r.party,
        partyType: r.party_type,
        businessType: r.business_type,
        invoiceDate: r.invoice_date,
        dueDate: r.due_date,
        amount: num(r.invoice_amount),
        paid: num(r.paid_amount),
        balance: num(r.balance),
        bucket: r.aging_bucket,
        daysOverdue: r.days_overdue === null ? 0 : Number(r.days_overdue),
      })),
      { ...pageMeta(q.page, q.pageSize, countRows[0].total), outstanding: num(countRows[0].outstanding) }
    );
  })
);

router.get(
  '/payables',
  requirePermission('payment.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema.extend(partyFilter), req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'p.org_id = $1 AND NOT p.is_settled';
    if (q.businessType !== 'ALL') {
      params.push(q.businessType);
      where += ` AND p.business_type = $${params.length}`;
    }
    if (q.partyType) {
      params.push(q.partyType);
      where += ` AND p.party_type = $${params.length}`;
    }
    if (q.partyId) {
      params.push(q.partyId);
      where += ` AND p.party_id = $${params.length}`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(p.balance), 0) AS outstanding
         FROM payables p WHERE ${where}`,
      params
    );

    const { rows } = await query(
      `SELECT p.invoice_no, p.invoice_type, p.invoice_id, p.invoice_date, p.due_date,
              p.invoice_amount, p.paid_amount, p.balance, p.business_type, p.party_type,
              COALESCE(s.name, co.name) AS party, a.aging_bucket
         FROM payables p
         LEFT JOIN suppliers s ON p.party_type = 'SUPPLIER' AND s.id = p.party_id
         LEFT JOIN companies co ON p.party_type = 'COMPANY' AND co.id = p.party_id
         LEFT JOIN v_payable_aging a
                ON a.invoice_type = p.invoice_type AND a.invoice_id = p.invoice_id
        WHERE ${where}
        ORDER BY p.due_date ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        invoiceNo: r.invoice_no,
        invoiceType: r.invoice_type,
        invoiceId: Number(r.invoice_id),
        party: r.party,
        partyType: r.party_type,
        businessType: r.business_type,
        dueDate: r.due_date,
        amount: num(r.invoice_amount),
        paid: num(r.paid_amount),
        balance: num(r.balance),
        bucket: r.aging_bucket,
      })),
      { ...pageMeta(q.page, q.pageSize, countRows[0].total), outstanding: num(countRows[0].outstanding) }
    );
  })
);

/* ------------------------------------------------------------------ payments */

const paymentSchema = z.object({
  txnDate: z.string().date(),
  direction: z.enum(['RECEIPT', 'PAYMENT']),
  businessType: z.enum(['DEALER', 'BULK_CROP']),
  partyType: z.enum(['CUSTOMER', 'SUPPLIER', 'COMPANY']),
  partyId: z.coerce.number().int().positive(),
  accountId: z.coerce.number().int().positive(),
  paymentMethodId: z.coerce.number().int().positive().optional(),
  amount: z.coerce.number().positive('Amount must be greater than zero'),
  referenceNo: z.string().max(60).optional(),
  note: z.string().max(300).optional(),
  allocations: z
    .array(
      z.object({
        invoiceType: z.string().min(1),
        invoiceId: z.coerce.number().int().positive(),
        amount: z.coerce.number().positive(),
      })
    )
    .default([]),
});

/**
 * Record a receipt or a payment and allocate it across invoices.
 * One payment can settle several invoices; whatever is left stays on account.
 */
router.post(
  '/payments',
  requirePermission('payment.create'),
  handler(async (req, res) => {
    const input = parseBody(paymentSchema, req);

    const allocatedTotal = input.allocations.reduce((t, a) => t + num(a.amount), 0);
    if (allocatedTotal > input.amount) {
      throw badRequest(
        'ALLOCATION_EXCEEDS_PAYMENT',
        'The allocated amount is more than the payment itself.'
      );
    }

    const result = await withTransaction(async (client) => {
      const docType = input.direction === 'RECEIPT' ? 'receipt' : 'payment';
      const txnNo = await nextDocumentNo(client, req.orgId, docType, input.txnDate);

      const { rows } = await client.query(
        `INSERT INTO payments
           (org_id, txn_no, txn_date, business_type, direction, party_type, party_id,
            account_id, payment_method_id, amount, unallocated_amount, reference_no,
            note, status, posted_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,'POSTED',now(),$13)
         RETURNING id`,
        [
          req.orgId,
          txnNo,
          input.txnDate,
          input.businessType,
          input.direction,
          input.partyType,
          input.partyId,
          input.accountId,
          input.paymentMethodId ?? null,
          input.amount,
          input.referenceNo ?? null,
          input.note ?? null,
          req.user.id,
        ]
      );

      const paymentId = Number(rows[0].id);

      const allocation = await allocatePayment(client, {
        paymentId,
        direction: input.direction,
        amount: input.amount,
        allocations: input.allocations,
      });

      // Cash in raises the account; cash out reduces it. A receipt settles a
      // receivable, a payment settles a payable -- which is what the party
      // side of the entry is, and what it has to be classified as.
      const receipt = input.direction === 'RECEIPT';
      const cashSide = await cashAccountFor(client, req.orgId, input.accountId);
      const partySide = await ledgerAccount(
        client,
        req.orgId,
        receipt ? LEDGER.RECEIVABLE : LEDGER.PAYABLE
      );
      await writeLedger(client, {
        orgId: req.orgId,
        coaId: cashSide,
        entryDate: input.txnDate,
        businessType: input.businessType,
        accountId: input.accountId,
        narration: `${receipt ? 'Receipt' : 'Payment'} ${txnNo}`,
        debit: receipt ? input.amount : 0,
        credit: receipt ? 0 : input.amount,
        referenceType: 'payments',
        referenceId: paymentId,
        userId: req.user.id,
      });
      await writeLedger(client, {
        orgId: req.orgId,
        entryDate: input.txnDate,
        businessType: input.businessType,
        coaId: partySide,
        partyType: input.partyType,
        partyId: input.partyId,
        narration: `${receipt ? 'Received from' : 'Paid to'} party for ${txnNo}`,
        debit: receipt ? 0 : input.amount,
        credit: receipt ? input.amount : 0,
        referenceType: 'payments',
        referenceId: paymentId,
        userId: req.user.id,
      });

      await writeAudit(client, {
        actor: req.actor,
        entityType: 'payments',
        entityId: paymentId,
        action: 'POST',
        newValue: {
          txnNo,
          amount: input.amount,
          allocated: allocation.allocated,
          unallocated: allocation.unallocated,
        },
        summary: `${receipt ? 'Receipt' : 'Payment'} ${txnNo} of ${input.amount} recorded`,
      });

      return { id: paymentId, txnNo, ...allocation };
    });

    created(res, result);
  })
);

router.get(
  '/payments',
  requirePermission('payment.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'p.org_id = $1';
    if (q.from) {
      params.push(q.from);
      where += ` AND p.txn_date >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND p.txn_date <= $${params.length}`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM payments p WHERE ${where}`,
      params
    );
    const { rows } = await query(
      `SELECT p.txn_no, p.txn_date, p.direction, p.amount, p.unallocated_amount,
              a.name AS account, m.name AS method, p.reference_no, p.status,
              COALESCE(c.name, s.name, co.name) AS party
         FROM payments p
         JOIN accounts a ON a.id = p.account_id
         LEFT JOIN payment_methods m ON m.id = p.payment_method_id
         LEFT JOIN customers c ON p.party_type = 'CUSTOMER' AND c.id = p.party_id
         LEFT JOIN suppliers s ON p.party_type = 'SUPPLIER' AND s.id = p.party_id
         LEFT JOIN companies co ON p.party_type = 'COMPANY' AND co.id = p.party_id
        WHERE ${where}
        ORDER BY p.txn_date DESC, p.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        no: r.txn_no,
        date: r.txn_date,
        direction: r.direction,
        party: r.party,
        account: r.account,
        method: r.method || '',
        amount: num(r.amount),
        unallocated: num(r.unallocated_amount),
        reference: r.reference_no || '',
        status: r.status,
      })),
      pageMeta(q.page, q.pageSize, countRows[0].total)
    );
  })
);

/* ------------------------------------------------------------------ expenses */

const expenseSchema = z.object({
  txnDate: z.string().date(),
  businessType: z.enum(['DEALER', 'BULK_CROP']).nullable().optional(),
  categoryId: z.coerce.number().int().positive(),
  accountId: z.coerce.number().int().positive().optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  amount: z.coerce.number().positive('Amount must be greater than zero'),
  note: z.string().max(300).optional(),
});

router.post(
  '/expenses',
  requirePermission('expense.create'),
  handler(async (req, res) => {
    const input = parseBody(expenseSchema, req);

    const result = await withTransaction(async (client) => {
      const txnNo = await nextDocumentNo(client, req.orgId, 'expense', input.txnDate);

      const { rows } = await client.query(
        `INSERT INTO expenses
           (org_id, txn_no, txn_date, business_type, category_id, account_id,
            warehouse_id, amount, note, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10) RETURNING id`,
        [
          req.orgId,
          txnNo,
          input.txnDate,
          input.businessType ?? null,
          input.categoryId,
          input.accountId ?? null,
          input.warehouseId ?? null,
          input.amount,
          input.note ?? null,
          req.user.id,
        ]
      );
      const expenseId = Number(rows[0].id);

      const rule = await evaluateRules(client, {
        orgId: req.orgId,
        entityType: 'expenses',
        businessType: input.businessType ?? null,
        amount: input.amount,
      });

      if (rule) {
        const approval = await requestApproval(client, {
          orgId: req.orgId,
          entityType: 'expenses',
          entityId: expenseId,
          businessType: input.businessType ?? null,
          ruleId: rule.id,
          referenceNo: txnNo,
          partyName: input.note ?? '',
          amount: input.amount,
          reason: rule.reason,
          date: input.txnDate,
          userId: req.user.id,
          actor: req.actor,
        });
        return { id: expenseId, txnNo, status: 'PENDING_APPROVAL', approval };
      }

      if (input.accountId) {
        // The category says which expense account the voucher belongs in;
        // without one it lands in operating expenses rather than being refused.
        const expenseSide = await expenseAccountFor(client, req.orgId, input.categoryId);
        const paidFrom = await cashAccountFor(client, req.orgId, input.accountId);
        await writeLedger(client, {
          orgId: req.orgId,
          coaId: expenseSide,
          entryDate: input.txnDate,
          businessType: input.businessType ?? null,
          narration: `Expense ${txnNo}`,
          debit: input.amount,
          credit: 0,
          referenceType: 'expenses',
          referenceId: expenseId,
          userId: req.user.id,
        });
        await writeLedger(client, {
          orgId: req.orgId,
          entryDate: input.txnDate,
          businessType: input.businessType ?? null,
          coaId: paidFrom,
          accountId: input.accountId,
          narration: `Expense ${txnNo} paid`,
          debit: 0,
          credit: input.amount,
          referenceType: 'expenses',
          referenceId: expenseId,
          userId: req.user.id,
        });
      }

      await client.query(
        `UPDATE expenses SET status = 'POSTED', posted_at = now() WHERE id = $1`,
        [expenseId]
      );

      await writeAudit(client, {
        actor: req.actor,
        entityType: 'expenses',
        entityId: expenseId,
        action: 'POST',
        newValue: { txnNo, amount: input.amount },
        summary: `Expense ${txnNo} of ${input.amount} posted`,
      });

      return { id: expenseId, txnNo, status: 'POSTED' };
    });

    created(res, result);
  })
);

router.get(
  '/expenses',
  requirePermission('expense.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = "e.org_id = $1 AND e.status = 'POSTED'";
    if (q.from) {
      params.push(q.from);
      where += ` AND e.txn_date >= $${params.length}`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND e.txn_date <= $${params.length}`;
    }
    if (q.businessType !== 'ALL') {
      params.push(q.businessType);
      where += ` AND e.business_type = $${params.length}`;
    }

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(amount), 0) AS total_amount
         FROM expenses e WHERE ${where}`,
      params
    );
    const { rows } = await query(
      `SELECT e.txn_no, e.txn_date, ec.name AS category, e.note, e.business_type, e.amount
         FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
        WHERE ${where}
        ORDER BY e.txn_date DESC, e.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    ok(
      res,
      rows.map((r) => ({
        no: r.txn_no,
        date: r.txn_date,
        category: r.category,
        note: r.note || '',
        businessType: r.business_type,
        amount: num(r.amount),
      })),
      { ...pageMeta(q.page, q.pageSize, countRows[0].total), totalAmount: num(countRows[0].total_amount) }
    );
  })
);

/* ------------------------------------------- accounts and expense categories */

/**
 * Both carry a code that means something -- BANK-IBBL reconciles against a
 * bank statement, TRANSPORT reads in a report -- so the operator may choose
 * one, and gets a clear message rather than a constraint violation when it is
 * taken.
 */

const accountSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]+$/, 'Use capitals, digits and dashes, like BANK-IBBL')
    .max(24)
    .optional(),
  name: z.string().trim().min(1, 'Account name is required').max(160),
  type: z.enum(['CASH', 'BANK', 'MFS']).default('CASH'),
  opening: z.coerce.number().default(0),
});

const expenseCategorySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and underscores, like OFFICE_UTILITY')
    .max(32)
    .optional(),
  name: z.string().trim().min(1, 'Category name is required').max(120),
});

registerMasterCrud(router, {
  path: 'accounts',
  table: 'accounts',
  label: 'Account',
  permissions: { create: 'account.create', edit: 'account.edit', remove: 'account.delete' },
  code: { prefix: 'ACC', width: 2, fromBody: true },
  schema: accountSchema,
  columns: (b) => ({
    name: b.name,
    account_type: b.type,
    opening_balance: b.opening,
  }),
  blockers: [
    {
      // Money still sitting in an account is the hazard: closing it would hide
      // a balance that is genuinely there. A used-but-empty account closes
      // fine, and its history keeps naming it.
      sql: `SELECT ABS(a.opening_balance
                       + COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger_entries l
                                    WHERE l.account_id = a.id), 0)) AS value
              FROM accounts a WHERE a.id = $1 AND a.org_id = $2`,
      code: 'HAS_BALANCE',
      message: (n) =>
        `This account still holds Tk ${Math.round(n).toLocaleString('en-IN')}. ` +
        'Move the balance out before closing it.',
    },
  ],
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    type: r.account_type,
    opening: num(r.opening_balance),
    status: r.is_active ? 'Active' : 'Closed',
  }),
});

registerMasterCrud(router, {
  path: 'expense-categories',
  table: 'expense_categories',
  label: 'Expense category',
  permissions: {
    create: 'expense.category.create',
    edit: 'expense.category.edit',
    remove: 'expense.category.delete',
  },
  code: { prefix: 'EXP', width: 2, fromBody: true },
  schema: expenseCategorySchema,
  // Shared across organisations, and four columns wide: no org_id, no
  // timestamps.
  orgScoped: false,
  timestamped: false,
  columns: (b) => ({ name: b.name }),
  // Nothing blocks retiring one. Past expenses keep pointing at the category
  // they were booked to, and it simply stops being offered on new ones.
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    status: r.is_active ? 'Active' : 'Retired',
  }),
});

const paymentMethodSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and underscores, like BANK_TRANSFER')
    .max(32)
    .optional(),
  name: z.string().trim().min(1, 'Method name is required').max(80),
  // The account is optional because the column is: a method can be set up
  // before the account it will pay into exists.
  account: z.string().trim().max(160).optional(),
});

registerMasterCrud(router, {
  path: 'payment-methods',
  table: 'payment_methods',
  label: 'Payment method',
  permissions: {
    create: 'payment.method.create',
    edit: 'payment.method.edit',
    remove: 'payment.method.delete',
  },
  code: { prefix: 'PM', width: 2, fromBody: true },
  schema: paymentMethodSchema,
  // Six columns and a flag: org-scoped, but with no timestamps to touch.
  timestamped: false,
  columns: (b) => ({ name: b.name }),
  // The screen names the account; the id behind it is not its business.
  resolve: async (client, body, orgId) => {
    if (body.account === undefined) return {};
    if (!body.account) return { account_id: null };
    const { rows } = await client.query(
      `SELECT id FROM accounts
        WHERE org_id = $1 AND is_active AND (code = $2 OR lower(name) = lower($2))`,
      [orgId, body.account]
    );
    if (!rows.length) throw notFound(`Account ${body.account}`);
    return { account_id: Number(rows[0].id) };
  },
  // Nothing blocks retiring one. Past payments keep naming the method they
  // were taken by, and it stops being offered on new ones.
  present: (r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    accountId: r.account_id ? Number(r.account_id) : null,
    active: r.is_active,
    status: r.is_active ? 'Active' : 'Retired',
  }),
});

/* ------------------------------------------------------------- statements */

/**
 * The profit and loss, from the journal.
 *
 * Needs `report.profit`, the same permission that governs profit everywhere
 * else: a Sales or Warehouse user does not see margin on a screen simply
 * because it is called Accounts rather than Reports.
 */
router.get(
  '/profit-and-loss',
  requirePermission('report.profit'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    ok(res, await profitAndLoss(req.orgId, q));
  })
);

router.get(
  '/trial-balance',
  requirePermission('report.profit'),
  handler(async (req, res) => {
    ok(res, await trialBalance(req.orgId));
  })
);

router.get(
  '/balance-sheet',
  requirePermission('report.profit'),
  handler(async (req, res) => {
    ok(res, await balanceSheet(req.orgId));
  })
);

export default router;
