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
import { allocatePayment, writeLedger } from '../services/financeService.js';
import { evaluateRules, requestApproval } from '../services/approvalService.js';
import { badRequest } from '../lib/errors.js';

/** Payments, expenses, cash/bank accounts, receivables and payables. */
const router = Router();

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
  '/payment-methods',
  requirePermission('payment.view'),
  handler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, code, name, account_id, is_active FROM payment_methods
        WHERE org_id = $1 ORDER BY id`,
      [req.orgId]
    );
    ok(
      res,
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        accountId: r.account_id ? Number(r.account_id) : null,
        active: r.is_active,
      }))
    );
  })
);

/* ------------------------------------------------------ receivable / payable */

router.get(
  '/receivables',
  requirePermission('payment.view'),
  handler(async (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const params = [req.orgId];
    let where = 'r.org_id = $1 AND NOT r.is_settled';
    if (q.businessType !== 'ALL') {
      params.push(q.businessType);
      where += ` AND r.business_type = $${params.length}`;
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
    const q = parseQuery(listQuerySchema, req);
    const { limit, offset } = paginate(q.page, q.pageSize);

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(balance), 0) AS outstanding
         FROM payables WHERE org_id = $1 AND NOT is_settled`,
      [req.orgId]
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
        WHERE p.org_id = $1 AND NOT p.is_settled
        ORDER BY p.due_date ASC
        LIMIT ${limit} OFFSET ${offset}`,
      [req.orgId]
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

      // Cash in raises the account; cash out reduces it.
      const receipt = input.direction === 'RECEIPT';
      await writeLedger(client, {
        orgId: req.orgId,
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
        await writeLedger(client, {
          orgId: req.orgId,
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

export default router;
