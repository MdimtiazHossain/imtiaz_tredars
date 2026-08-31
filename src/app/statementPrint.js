import { money, shortDate } from '../domain/format.js';
import { e, printableDocument, openPrintable } from './printDocument.js';

/**
 * The printed statement of account.
 *
 * What gets sent when a balance is disputed, so it has to be the whole story
 * rather than a summary: what was owed at the start, every document and
 * receipt since in date order, and what is owed now. A reader adds the column
 * down and arrives at the closing figure — if they cannot, the statement has
 * not done its job.
 *
 * The direction is said in words. A supplier's balance is negative because we
 * owe them, and a farmer handed a page reading "−4,05,270" has been handed a
 * puzzle rather than a statement.
 */

/** Extra rules the ledger table needs; the sheet supplies the rest. */
const STATEMENT_STYLES = `
  table.ledger { width: 100%; border-collapse: collapse; margin-top: 10px; }
  table.ledger th { background: #FAF9F7; border-top: 1px solid #E3E0DA;
                    border-bottom: 1px solid #E3E0DA; padding: 6px 8px; text-align: left;
                    font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em;
                    text-transform: uppercase; color: #6E6A64; }
  table.ledger td { padding: 6px 8px; border-bottom: 1px solid #F0EEE9; }
  table.ledger tr.opening td { background: #FAF9F7; font-weight: 600; }
  table.ledger tr.closing td { border-top: 1px solid #E3E0DA; border-bottom: 0;
                               font-weight: 700; font-size: 12.5px; padding-top: 9px; }
  /* A long statement runs over pages; the header repeats so the columns are
     never anonymous on page two. */
  table.ledger thead { display: table-header-group; }
  table.ledger tr { break-inside: avoid; }
  .aging { display: flex; gap: 0; margin-top: 16px; border: 1px solid #E3E0DA;
           border-radius: 6px; overflow: hidden; }
  .aging div { flex: 1; padding: 8px 10px; border-right: 1px solid #E3E0DA; }
  .aging div:last-child { border-right: 0; }
  .aging .k { font-size: 9.5px; letter-spacing: 0.05em; text-transform: uppercase;
              color: #8C877F; }
  .aging .v { font-family: 'Roboto Mono', ui-monospace, monospace; font-size: 12px;
              font-weight: 700; margin-top: 3px; }
`;

/** One line of the running account. */
function ledgerRow(line) {
  return `
    <tr>
      <td>${e(shortDate(line.date))}</td>
      <td class="mono">${e(line.documentNo || '—')}</td>
      <td>${e(line.particulars)}</td>
      <td class="right mono">${line.debit ? money(line.debit) : '—'}</td>
      <td class="right mono">${line.credit ? money(line.credit) : '—'}</td>
      <td class="right mono strong">${money(line.balance)}</td>
    </tr>`;
}

/** The closing balance, said in the direction it points. */
export function balanceSentence(totals) {
  const amount = money(totals.outstanding);
  if (totals.direction === 'RECEIVABLE') return `${amount} receivable from this party`;
  if (totals.direction === 'PAYABLE') return `${amount} payable to this party`;
  return 'The account is settled in full';
}

/**
 * Build the whole document.
 *
 * @param {object} statement as `GET /parties/:type/:id/statement` returns it
 * @param {object} org       the business issuing it
 */
export function statementDocument(statement, org = {}) {
  const { party, totals, aging, lines = [] } = statement;

  const detail = (label, value) =>
    value ? `<div><span class="k">${e(label)}</span><span class="v">${e(value)}</span></div>` : '';

  const period = statement.period || {};
  const span = [period.from ? shortDate(period.from) : '', period.to ? shortDate(period.to) : '']
    .filter(Boolean)
    .join(' to ');

  const bucket = (label, value) =>
    `<div><div class="k">${e(label)}</div><div class="v">${money(value)}</div></div>`;

  return printableDocument({
    title: `Statement — ${party.name}`,
    action: 'Print this statement',
    extraCss: STATEMENT_STYLES,
    body: `
    <header>
      <div>
        <div class="org-name">${e(org.name || '')}</div>
        ${org.headOffice ? `<div class="org-line">${e(org.headOffice)}</div>` : ''}
        <div class="org-line">${[
          org.mobile ? `Mobile ${e(org.mobile)}` : '',
          org.binNo ? `BIN ${e(org.binNo)}` : '',
        ]
          .filter(Boolean)
          .join(' &nbsp;·&nbsp; ')}</div>
      </div>
      <div class="doc">
        <div class="doc-title">Statement of account</div>
        <div class="doc-no mono">${e(party.code)}</div>
        <div class="org-line">${e(span || 'All transactions')}</div>
      </div>
    </header>

    <div class="parties">
      <div class="party">
        <h2>Account of</h2>
        <div class="who">${e(party.name)}</div>
        ${party.nameBn ? `<div>${e(party.nameBn)}</div>` : ''}
        ${party.address ? `<div class="sub">${e(party.address)}</div>` : ''}
        ${party.mobile ? `<div class="sub mono">${e(party.mobile)}</div>` : ''}
        ${party.binNo ? `<div class="sub mono">BIN ${e(party.binNo)}</div>` : ''}
      </div>
      <div class="meta">
        ${detail('Type', party.type)}
        ${detail('Opening', money(statement.opening))}
        ${detail('Debits', money(totals.debit))}
        ${detail('Credits', money(totals.credit))}
        ${detail('Closing', money(statement.closing))}
      </div>
    </div>

    <table class="ledger">
      <thead>
        <tr>
          <th>Date</th><th>Document</th><th>Particulars</th>
          <th class="right">Debit</th><th class="right">Credit</th><th class="right">Balance</th>
        </tr>
      </thead>
      <tbody>
        <tr class="opening">
          <td>${e(period.from ? shortDate(period.from) : '—')}</td>
          <td class="mono">—</td>
          <td>Opening balance</td>
          <td class="right mono">—</td>
          <td class="right mono">—</td>
          <td class="right mono strong">${money(statement.opening)}</td>
        </tr>
        ${lines.map(ledgerRow).join('')}
        <tr class="closing">
          <td colspan="3">Closing balance — ${e(balanceSentence(totals))}</td>
          <td class="right mono">${money(totals.debit)}</td>
          <td class="right mono">${money(totals.credit)}</td>
          <td class="right mono">${money(statement.closing)}</td>
        </tr>
      </tbody>
    </table>

    ${
      aging && aging.total
        ? `<div class="aging">
      ${bucket('Not yet due', aging.current)}
      ${bucket('1–30 days', aging.b30)}
      ${bucket('31–60 days', aging.b60)}
      ${bucket('61–90 days', aging.b90)}
      ${bucket('Over 90 days', aging.b90plus)}
    </div>`
        : ''
    }

    <div class="signatures">
      <div class="sign">Confirmed as correct</div>
      <div class="sign">For ${e(org.name || '')}</div>
    </div>

    <footer>${e(party.code)} &nbsp;·&nbsp; ${e(org.name || '')} &nbsp;·&nbsp; amounts in ${e(
      org.currency || 'BDT'
    )}</footer>`,
  });
}

/**
 * Open the statement in its own window, ready to print.
 *
 * @returns {boolean} false when the browser blocked the window
 */
export function openStatement(statement, org, open) {
  if (!statement) return false;
  return openPrintable(statementDocument(statement, org || {}), open);
}
