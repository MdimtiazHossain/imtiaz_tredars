import { query, num } from '../lib/db.js';
import { notFound } from '../lib/errors.js';

/**
 * A party's account.
 *
 * What a customer owes is not a number stored against the customer -- it is
 * the sum of everything that has happened between the business and them, which
 * is what a statement is and why one is what gets sent when a balance is
 * disputed. Every posting that moves a party's balance already writes a
 * journal line naming them, so this reads those lines rather than recomputing
 * a balance from the documents and hoping the two agree.
 *
 * Sign is the one thing worth being deliberate about. A line's debit less its
 * credit is what the party owes us, so a customer normally runs positive and a
 * supplier normally runs negative. Rather than showing a supplier a negative
 * balance -- which reads like a mistake -- the figure is reported with the
 * direction it points in, and the caller says "owes us" or "we owe" from that.
 * A company that both supplies and buys nets to whichever side is larger,
 * which is the only honest answer for a party with two relationships.
 */

const paisa = (n) => Math.round(num(n) * 100) / 100;

/** Which master a party type lives in, and what one of them is called. */
const PARTY_TABLE = {
  CUSTOMER: { table: 'customers', label: 'Customer' },
  SUPPLIER: { table: 'suppliers', label: 'Supplier' },
  COMPANY: { table: 'companies', label: 'Company' },
};

/**
 * The documents a party of this type appears on.
 *
 * A company is the awkward one: it can be the principal a purchase comes from
 * and the buyer a crop sale goes to, sometimes both, so both are listed and
 * the statement nets them.
 */
const PARTY_DOCUMENTS = {
  CUSTOMER: [{ table: 'dealer_sales', column: 'customer_id', label: 'Dealer sale', side: 'SALE' }],
  SUPPLIER: [
    { table: 'crop_purchases', column: 'supplier_id', label: 'Crop purchase', side: 'PURCHASE' },
  ],
  COMPANY: [
    { table: 'crop_sales', column: 'buyer_company_id', label: 'Crop sale', side: 'SALE' },
    {
      table: 'dealer_purchases',
      column: 'company_id',
      label: 'Dealer purchase',
      side: 'PURCHASE',
    },
  ],
};

/** What a journal line's reference is called, for a statement to read plainly. */
const DOCUMENT_LABEL = {
  dealer_sales: 'Dealer sale',
  dealer_purchases: 'Dealer purchase',
  crop_sales: 'Crop sale',
  crop_purchases: 'Crop purchase',
  payments: 'Payment',
  returns: 'Return',
  credit_notes: 'Credit note',
};

/** The party themselves, or nothing if this org has no such party. */
export async function loadParty(orgId, partyType, partyId) {
  const kind = PARTY_TABLE[partyType];
  if (!kind) throw notFound('Party');

  const columns =
    partyType === 'SUPPLIER'
      ? 'code, name, name_bn, supplier_type AS type, mobile, district, upazila, bin_no, is_vat_registered, 0 AS credit_limit, 0 AS credit_days'
      : partyType === 'COMPANY'
        ? "code, name, NULL AS name_bn, role AS type, mobile, district, NULL AS upazila, bin_no, is_vat_registered, credit_limit, credit_days"
        : 'code, name, name_bn, customer_type AS type, mobile, district, upazila, bin_no, is_vat_registered, credit_limit, credit_days';

  const { rows } = await query(
    `SELECT id, ${columns} FROM ${kind.table} WHERE id = $1 AND org_id = $2`,
    [partyId, orgId]
  );
  if (!rows.length) throw notFound(kind.label);

  const r = rows[0];
  return {
    id: Number(r.id),
    partyType,
    code: r.code,
    name: r.name,
    nameBn: r.name_bn || '',
    type: r.type,
    mobile: r.mobile || '',
    address: [r.upazila, r.district].filter(Boolean).join(', '),
    binNo: r.bin_no || '',
    vatRegistered: !!r.is_vat_registered,
    creditLimit: num(r.credit_limit),
    creditDays: Number(r.credit_days) || 0,
  };
}

/**
 * Everything the party's account has done, as a running statement.
 *
 * `from` decides where the statement starts, not what it includes: everything
 * before it is folded into one opening line, so a statement for August still
 * begins at the balance July left behind.
 *
 * @param {number} orgId
 * @param {{partyType: string, partyId: number, from?: string, to?: string}} q
 */
export async function partyStatement(orgId, q) {
  const party = await loadParty(orgId, q.partyType, q.partyId);

  // Only what happened before the statement starts. A statement with no start
  // date covers everything the party has ever done, so there is nothing before
  // it and the opening balance is nothing -- counting the lot would report the
  // whole account twice, once as an opening and once as the lines themselves.
  const { rows: openingRows } = q.from
    ? await query(
        `SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS opening
           FROM v_party_ledger
          WHERE org_id = $1 AND party_type = $2 AND party_id = $3
            AND entry_date < $4::date`,
        [orgId, q.partyType, q.partyId, q.from]
      )
    : { rows: [{ opening: 0 }] };
  const opening = paisa(openingRows[0].opening);

  const { rows } = await query(
    `SELECT entry_date, business_type, narration, debit, credit,
            reference_type, reference_id, document_no, account_code, account_name
       FROM v_party_ledger
      WHERE org_id = $1 AND party_type = $2 AND party_id = $3
        AND ($4::date IS NULL OR entry_date >= $4::date)
        AND ($5::date IS NULL OR entry_date <= $5::date)
      ORDER BY entry_date, id`,
    [orgId, q.partyType, q.partyId, q.from || null, q.to || null]
  );

  let balance = opening;
  let debitTotal = 0;
  let creditTotal = 0;

  const lines = rows.map((r) => {
    const debit = paisa(r.debit);
    const credit = paisa(r.credit);
    balance = paisa(balance + debit - credit);
    debitTotal += debit;
    creditTotal += credit;

    return {
      date: r.entry_date,
      // The number is what a party recognises; the narration is what it was
      // for. Both, because neither alone settles a dispute.
      documentNo: r.document_no || '',
      documentType: r.reference_type,
      documentLabel: DOCUMENT_LABEL[r.reference_type] || r.reference_type,
      businessType: r.business_type,
      particulars: r.narration,
      account: r.account_name,
      debit,
      credit,
      balance,
    };
  });

  const closing = balance;
  const [aging, documents, payments] = await Promise.all([
    partyAging(orgId, q.partyType, q.partyId),
    partyDocuments(orgId, q.partyType, q.partyId),
    partyPayments(orgId, q.partyType, q.partyId),
  ]);

  return {
    party,
    period: { from: q.from || (lines[0] ? lines[0].date : null), to: q.to || null },
    opening,
    lines,
    closing,
    totals: {
      debit: paisa(debitTotal),
      credit: paisa(creditTotal),
      // Signed, and named. A supplier's balance is negative because we owe
      // them, which is a direction rather than a shortfall.
      balance: closing,
      direction: closing > 0 ? 'RECEIVABLE' : closing < 0 ? 'PAYABLE' : 'SETTLED',
      outstanding: Math.abs(closing),
    },
    aging,
    documents,
    payments,
    // A statement with no lines and no opening balance is a party nothing has
    // been traded with yet, which the screen should say rather than drawing an
    // empty ledger.
    isEmpty: !lines.length && opening === 0,
  };
}

/**
 * How old the unsettled invoices are.
 *
 * Read from `receivables` and `payables` rather than from the journal: the
 * journal knows what moved and when, and only these know which invoice a
 * balance still belongs to and when it fell due.
 */
export async function partyAging(orgId, partyType, partyId) {
  const buckets = { current: 0, b30: 0, b60: 0, b90: 0, b90plus: 0 };

  for (const table of ['receivables', 'payables']) {
    const { rows } = await query(
      `SELECT due_date, balance FROM ${table}
        WHERE org_id = $1 AND party_type = $2 AND party_id = $3 AND NOT is_settled`,
      [orgId, partyType, partyId]
    );
    for (const r of rows) {
      const days = Math.floor((Date.now() - new Date(`${String(r.due_date).slice(0, 10)}T00:00:00Z`).getTime()) / 86_400_000);
      const amount = paisa(r.balance);
      if (days <= 0) buckets.current += amount;
      else if (days <= 30) buckets.b30 += amount;
      else if (days <= 60) buckets.b60 += amount;
      else if (days <= 90) buckets.b90 += amount;
      else buckets.b90plus += amount;
    }
  }

  const total = Object.values(buckets).reduce((t, v) => t + v, 0);
  return { ...Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, paisa(v)])), total: paisa(total) };
}

/** The documents raised for this party, with what is still owed on each. */
export async function partyDocuments(orgId, partyType, partyId) {
  const sources = PARTY_DOCUMENTS[partyType] || [];
  const out = [];

  for (const source of sources) {
    const settle = source.side === 'SALE' ? 'receivables' : 'payables';
    const { rows } = await query(
      `SELECT d.id, d.txn_no, d.txn_date, d.status, d.net_amount, d.tax_amount,
              d.total_amount, COALESCE(s.paid_amount, 0) AS paid,
              COALESCE(s.balance, 0) AS due,
              (SELECT COUNT(*)::int FROM ${source.table === 'dealer_sales' ? 'dealer_sale_items' : source.table === 'dealer_purchases' ? 'dealer_purchase_items' : source.table === 'crop_sales' ? 'crop_sale_items' : 'crop_purchase_items'} i
                WHERE i.${source.table === 'dealer_sales' || source.table === 'crop_sales' ? 'sale_id' : 'purchase_id'} = d.id) AS items
         FROM ${source.table} d
         LEFT JOIN ${settle} s ON s.invoice_type = $3 AND s.invoice_id = d.id
        WHERE d.org_id = $1 AND d.${source.column} = $2 AND d.status <> 'DRAFT'
        ORDER BY d.txn_date DESC, d.id DESC
        LIMIT 200`,
      [orgId, partyId, source.table]
    );

    for (const r of rows) {
      out.push({
        id: Number(r.id),
        no: r.txn_no,
        date: r.txn_date,
        documentType: source.table,
        label: source.label,
        side: source.side,
        items: r.items,
        net: paisa(r.net_amount),
        tax: paisa(r.tax_amount),
        amount: paisa(r.total_amount) || paisa(r.net_amount),
        paid: paisa(r.paid),
        due: paisa(r.due),
        status: r.status,
      });
    }
  }

  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** Money taken from or paid to this party, and what it was set against. */
export async function partyPayments(orgId, partyType, partyId) {
  const { rows } = await query(
    `SELECT p.id, p.txn_no, p.txn_date, p.direction, p.amount, p.unallocated_amount,
            p.reference_no, p.status, a.name AS account, m.name AS method,
            COALESCE(
              (SELECT string_agg(x.no, ', ' ORDER BY x.no) FROM (
                 SELECT COALESCE(
                          (SELECT txn_no FROM dealer_sales     WHERE id = al.invoice_id AND al.invoice_type = 'dealer_sales'),
                          (SELECT txn_no FROM crop_sales       WHERE id = al.invoice_id AND al.invoice_type = 'crop_sales'),
                          (SELECT txn_no FROM dealer_purchases WHERE id = al.invoice_id AND al.invoice_type = 'dealer_purchases'),
                          (SELECT txn_no FROM crop_purchases   WHERE id = al.invoice_id AND al.invoice_type = 'crop_purchases')
                        ) AS no
                   FROM payment_allocations al WHERE al.payment_id = p.id
               ) x),
              ''
            ) AS against
       FROM payments p
       LEFT JOIN accounts a ON a.id = p.account_id
       LEFT JOIN payment_methods m ON m.id = p.payment_method_id
      WHERE p.org_id = $1 AND p.party_type = $2 AND p.party_id = $3
        AND p.status <> 'DRAFT'
      ORDER BY p.txn_date DESC, p.id DESC
      LIMIT 200`,
    [orgId, partyType, partyId]
  );

  return rows.map((r) => ({
    id: Number(r.id),
    no: r.txn_no,
    date: r.txn_date,
    direction: r.direction,
    amount: paisa(r.amount),
    // Money not tied to an invoice is on account, which a party statement has
    // to show or the invoice list and the balance will not reconcile.
    onAccount: paisa(r.unallocated_amount),
    against: r.against || 'On account',
    method: r.method || '',
    account: r.account || '',
    reference: r.reference_no || '',
    status: r.status,
  }));
}
