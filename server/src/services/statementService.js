import { query, num } from '../lib/db.js';
import { LEDGER } from './financeService.js';

/**
 * Financial statements, read from the journal.
 *
 * The profit and loss existed twice: as a report computing its own totals from
 * the transaction tables, and as a hard-coded fixture on the Accounts screen.
 * Two independent computations of the same figure will agree until they do
 * not, and a screen that never agreed with anything is worse than either.
 *
 * There is one computation now, and it reads `ledger_entries` through
 * `v_profit_and_loss`. Anything posted is in it and anything not posted is not,
 * which is the property that makes a statement worth signing: it says what the
 * books say, rather than what a second pass over the documents concluded.
 */

/** What each business line is called on a statement. */
const BUSINESS_LABEL = {
  DEALER: 'Dealer business',
  BULK_CROP: 'Bulk crop business',
};

/** A period filter over the P&L view, as SQL and parameters. */
function period(q, params) {
  let where = '';
  if (q.from) {
    params.push(q.from);
    where += ` AND entry_date >= $${params.length}::date`;
  }
  if (q.to) {
    params.push(q.to);
    where += ` AND entry_date <= $${params.length}::date`;
  }
  if (q.businessType && q.businessType !== 'ALL') {
    params.push(q.businessType);
    where += ` AND business_type = $${params.length}`;
  }
  return where;
}

/** The earliest or latest date across the grouped rows, as `YYYY-MM-DD`. */
function dateOf(rows, field, pick) {
  const times = rows.map((r) => new Date(r[field]).getTime()).filter((t) => !Number.isNaN(t));
  return times.length ? new Date(pick(...times)).toISOString().slice(0, 10) : null;
}

/**
 * Income and expense for a period, grouped the way a statement reads.
 *
 * @param {number} orgId
 * @param {{from?: string, to?: string, businessType?: string}} [q]
 */
export async function profitAndLoss(orgId, q = {}) {
  const params = [orgId];
  const where = period(q, params);

  const { rows } = await query(
    `SELECT code, name, account_class, business_type,
            COALESCE(SUM(amount), 0) AS amount,
            MIN(entry_date) AS first_entry,
            MAX(entry_date) AS last_entry
       FROM v_profit_and_loss
      WHERE org_id = $1 ${where}
      GROUP BY code, name, account_class, business_type
      HAVING COALESCE(SUM(amount), 0) <> 0
      ORDER BY code`,
    params
  );

  const revenue = rows.filter((r) => r.account_class === 'INCOME');
  const costOfSales = rows.filter((r) => r.code === LEDGER.COST_OF_SALES);
  const operating = rows.filter(
    (r) => r.account_class === 'EXPENSE' && r.code !== LEDGER.COST_OF_SALES
  );

  const total = (list) => list.reduce((t, r) => t + num(r.amount), 0);
  const revenueTotal = total(revenue);
  const costTotal = total(costOfSales);
  const operatingTotal = total(operating);
  const grossProfit = revenueTotal - costTotal;
  const netProfit = grossProfit - operatingTotal;

  /**
   * The statement as it is read, top to bottom.
   *
   * Costs are negative so the column sums down to the net figure rather than
   * needing the reader to know which lines to subtract.
   */
  const lines = [];
  const label = (r) =>
    r.business_type ? `${r.name} — ${BUSINESS_LABEL[r.business_type] || r.business_type}` : r.name;

  for (const r of revenue) lines.push({ label: label(r), amount: num(r.amount) });
  lines.push({ label: 'Total revenue', amount: revenueTotal, bold: true });

  for (const r of costOfSales) lines.push({ label: label(r), amount: -num(r.amount) });
  lines.push({ label: 'Gross profit', amount: grossProfit, bold: true, good: grossProfit >= 0 });

  for (const r of operating) lines.push({ label: label(r), amount: -num(r.amount) });
  lines.push({ label: 'Total operating expense', amount: -operatingTotal, bold: true });

  lines.push({
    label: 'Net profit',
    amount: netProfit,
    bold: true,
    big: true,
    good: netProfit >= 0,
  });

  return {
    lines,
    totals: {
      revenue: revenueTotal,
      costOfSales: costTotal,
      grossProfit,
      operatingExpense: operatingTotal,
      netProfit,
      // Margin against total revenue, never against one business line.
      marginPct: revenueTotal ? (netProfit / revenueTotal) * 100 : 0,
    },
    // What the figures above actually cover, so a heading can say so instead
    // of asserting a month. Where the caller gave no dates, it is the range the
    // journal itself spans.
    period: {
      from: q.from || dateOf(rows, 'first_entry', Math.min),
      to: q.to || dateOf(rows, 'last_entry', Math.max),
      businessType: q.businessType && q.businessType !== 'ALL' ? q.businessType : null,
    },
    // An empty statement is a real answer — a business that has posted nothing
    // has made nothing — and the screen needs to tell that apart from a
    // statement it failed to load.
    isEmpty: rows.length === 0,
  };
}

/** Account balances for the balance sheet, from the same journal. */
export async function balanceSheet(orgId) {
  const { rows } = await query(
    `SELECT code, name, account_class, balance
       FROM v_balance_sheet
      WHERE org_id = $1 AND balance <> 0
      ORDER BY code`,
    [orgId]
  );

  const of = (klass) => rows.filter((r) => r.account_class === klass);
  const total = (list) => list.reduce((t, r) => t + num(r.balance), 0);

  return {
    assets: of('ASSET').map((r) => ({ code: r.code, name: r.name, amount: num(r.balance) })),
    liabilities: of('LIABILITY').map((r) => ({ code: r.code, name: r.name, amount: num(r.balance) })),
    equity: of('EQUITY').map((r) => ({ code: r.code, name: r.name, amount: num(r.balance) })),
    totals: {
      assets: total(of('ASSET')),
      liabilities: total(of('LIABILITY')),
      equity: total(of('EQUITY')),
    },
  };
}

/** Every account and its movement, which is what a trial balance is. */
export async function trialBalance(orgId) {
  const { rows } = await query(
    `SELECT code, name, account_class, total_debit, total_credit, balance
       FROM v_trial_balance
      WHERE org_id = $1 AND (total_debit <> 0 OR total_credit <> 0)
      ORDER BY code`,
    [orgId]
  );

  return {
    rows: rows.map((r) => ({
      code: r.code,
      name: r.name,
      accountClass: r.account_class,
      debit: num(r.total_debit),
      credit: num(r.total_credit),
      balance: num(r.balance),
    })),
    totals: {
      debit: rows.reduce((t, r) => t + num(r.total_debit), 0),
      credit: rows.reduce((t, r) => t + num(r.total_credit), 0),
    },
  };
}
