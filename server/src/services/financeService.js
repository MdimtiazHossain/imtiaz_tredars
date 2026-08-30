import { num } from '../lib/db.js';
import { unprocessable, notFound } from '../lib/errors.js';

/**
 * Receivables, payables and the journal.
 *
 * Posting a credit sale raises a receivable; posting a credit purchase raises a
 * payable; a payment settles them through allocations. Every one of these also
 * writes balanced journal rows, so cash, bank and party balances can be
 * re-derived from `ledger_entries` independently of the maintained totals.
 */

/**
 * Normalise a date to `YYYY-MM-DD`.
 *
 * `pg` hands back a `DATE` column as a JavaScript `Date` at local midnight, so
 * stringifying one gives `Wed Aug 20 2026 ...` rather than an ISO date. Both
 * shapes reach these services — a Date read back from a query, a string from
 * request input — so every date is put through this on the way in.
 *
 * The local parts are read rather than the UTC ones on purpose: at a positive
 * UTC offset local midnight is the previous day in UTC, so `toISOString` would
 * silently move every date back by one.
 */
export function toIsoDate(value) {
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

/** Add `days` to a date and return an ISO date. */
export function addDays(date, days) {
  const d = new Date(`${toIsoDate(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/** Write one side of a journal entry. */
export async function writeLedger(client, e) {
  await client.query(
    `INSERT INTO ledger_entries
       (org_id, entry_date, business_type, account_id, party_type, party_id,
        narration, debit, credit, reference_type, reference_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      e.orgId,
      e.entryDate,
      e.businessType ?? null,
      e.accountId ?? null,
      e.partyType ?? null,
      e.partyId ?? null,
      e.narration,
      num(e.debit),
      num(e.credit),
      e.referenceType,
      e.referenceId,
      e.userId,
    ]
  );
}

/** Write a balanced debit/credit pair. */
export async function writeLedgerPair(client, { debit, credit, ...shared }) {
  await writeLedger(client, { ...shared, ...debit, debit: shared.amount, credit: 0 });
  await writeLedger(client, { ...shared, ...credit, debit: 0, credit: shared.amount });
}

/* ------------------------------------------------------------- receivables */

export async function createReceivable(client, r) {
  const amount = num(r.invoiceAmount);
  const paid = num(r.paidAmount);

  if (paid > amount) {
    throw unprocessable(
      'PAYMENT_EXCEEDS_INVOICE',
      'The amount received is more than the invoice total.'
    );
  }

  const { rows } = await client.query(
    `INSERT INTO receivables
       (org_id, party_type, party_id, business_type, invoice_type, invoice_id, invoice_no,
        invoice_date, due_date, invoice_amount, paid_amount, balance, is_settled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      r.orgId,
      r.partyType,
      r.partyId,
      r.businessType,
      r.invoiceType,
      r.invoiceId,
      r.invoiceNo,
      r.invoiceDate,
      r.dueDate,
      amount,
      paid,
      amount - paid,
      amount - paid <= 0,
    ]
  );
  return Number(rows[0].id);
}

export async function createPayable(client, p) {
  const amount = num(p.invoiceAmount);
  const paid = num(p.paidAmount);

  const { rows } = await client.query(
    `INSERT INTO payables
       (org_id, party_type, party_id, business_type, invoice_type, invoice_id,
        invoice_no, invoice_date, due_date, invoice_amount, paid_amount, balance, is_settled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      p.orgId,
      p.partyType,
      p.partyId,
      p.businessType,
      p.invoiceType,
      p.invoiceId,
      p.invoiceNo,
      p.invoiceDate,
      p.dueDate,
      amount,
      paid,
      amount - paid,
      amount - paid <= 0,
    ]
  );
  return Number(rows[0].id);
}

/* --------------------------------------------------------- payment posting */

const TABLE_FOR = { RECEIPT: 'receivables', PAYMENT: 'payables' };

/**
 * Allocate a payment across one or more invoices.
 *
 * Each target row is locked before its paid amount moves, so two clerks
 * settling the same invoice cannot both succeed and over-allocate it.
 *
 * @returns {{allocated:number, unallocated:number}}
 */
export async function allocatePayment(client, { paymentId, direction, amount, allocations }) {
  const table = TABLE_FOR[direction];
  let allocated = 0;

  for (const line of allocations || []) {
    const requested = num(line.amount);
    if (requested <= 0) continue;

    const { rows } = await client.query(
      `SELECT id, invoice_no, invoice_amount, paid_amount, balance
         FROM ${table}
        WHERE invoice_type = $1 AND invoice_id = $2
        FOR UPDATE`,
      [line.invoiceType, line.invoiceId]
    );

    if (!rows.length) throw notFound(`Invoice ${line.invoiceId}`);
    const target = rows[0];
    const balance = num(target.balance);

    if (requested > balance) {
      throw unprocessable(
        'ALLOCATION_EXCEEDS_BALANCE',
        `Cannot allocate more than the ${num(balance).toLocaleString('en-IN')} still ` +
          `outstanding on invoice ${target.invoice_no}.`
      );
    }

    const paid = num(target.paid_amount) + requested;
    const invoiceAmount = num(target.invoice_amount);

    await client.query(
      `UPDATE ${table}
          SET paid_amount = $1, balance = $2, is_settled = $3, updated_at = now()
        WHERE id = $4`,
      [paid, invoiceAmount - paid, invoiceAmount - paid <= 0, target.id]
    );

    await client.query(
      `INSERT INTO payment_allocations (payment_id, invoice_type, invoice_id, amount)
       VALUES ($1,$2,$3,$4)`,
      [paymentId, line.invoiceType, line.invoiceId, requested]
    );

    allocated += requested;
  }

  const total = num(amount);
  if (allocated > total) {
    throw unprocessable(
      'ALLOCATION_EXCEEDS_PAYMENT',
      'The allocated amount is more than the payment itself.'
    );
  }

  const unallocated = total - allocated;
  await client.query('UPDATE payments SET unallocated_amount = $1 WHERE id = $2', [
    unallocated,
    paymentId,
  ]);

  return { allocated, unallocated };
}

/** Undo a payment's allocations when it is cancelled. */
export async function reverseAllocations(client, paymentId, direction) {
  const table = TABLE_FOR[direction];
  const { rows } = await client.query(
    'SELECT invoice_type, invoice_id, amount FROM payment_allocations WHERE payment_id = $1',
    [paymentId]
  );

  for (const line of rows) {
    const { rows: found } = await client.query(
      `SELECT id, invoice_amount, paid_amount FROM ${table}
        WHERE invoice_type = $1 AND invoice_id = $2 FOR UPDATE`,
      [line.invoice_type, line.invoice_id]
    );
    if (!found.length) continue;

    const paid = Math.max(0, num(found[0].paid_amount) - num(line.amount));
    const invoiceAmount = num(found[0].invoice_amount);
    await client.query(
      `UPDATE ${table}
          SET paid_amount = $1, balance = $2, is_settled = $3, updated_at = now()
        WHERE id = $4`,
      [paid, invoiceAmount - paid, invoiceAmount - paid <= 0, found[0].id]
    );
  }

  await client.query('DELETE FROM payment_allocations WHERE payment_id = $1', [paymentId]);
  return rows.length;
}

/* -------------------------------------------------------------- balances */

/** Outstanding for one customer, including the opening balance. */
export async function customerOutstanding(client, customerId) {
  const { rows } = await client.query(
    'SELECT outstanding, credit_limit FROM v_customer_outstanding WHERE customer_id = $1',
    [customerId]
  );
  if (!rows.length) return { outstanding: 0, creditLimit: 0 };
  return { outstanding: num(rows[0].outstanding), creditLimit: num(rows[0].credit_limit) };
}

/**
 * Refuse a credit sale that would push a customer past their limit.
 * The frontend shows the same figure before posting; this is the authority.
 */
export async function assertWithinCreditLimit(client, customerId, additionalExposure) {
  const { outstanding, creditLimit } = await customerOutstanding(client, customerId);
  if (creditLimit <= 0) return;

  const exposure = outstanding + num(additionalExposure);
  if (exposure > creditLimit) {
    throw unprocessable(
      'CREDIT_LIMIT_EXCEEDED',
      `This invoice takes the customer to ${exposure.toLocaleString('en-IN')} against a ` +
        `credit limit of ${creditLimit.toLocaleString('en-IN')}. Approval is required.`
    );
  }
}
