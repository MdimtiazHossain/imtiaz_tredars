import { money, dec2 } from '../domain/format.js';

/**
 * The printed invoice.
 *
 * A document rather than a screen, so it is built as its own page rather than
 * squeezed out of the application's layout: a customer receives this on paper,
 * and what belongs on it is the two parties, the goods, the money and nothing
 * else. No navigation, no profit, no controls.
 *
 * It is rendered as a whole HTML document and handed to the browser's own print
 * dialogue. That is deliberate rather than lazy -- the browser already has the
 * Bengali fonts installed on the machine, and a customer name in Bangla renders
 * as itself here where a server-side PDF would need a font bundled to match.
 */

/** Escape anything that came out of the database before it becomes markup. */
function escapeHtml(value) {
  return String(value ?? '')
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

const e = escapeHtml;

/** A row of the goods table. */
function lineRow(line, index) {
  const bonus = line.bonus ? `<div class="sub">+ ${dec2(line.bonus)} ${e(line.unit)} bonus</div>` : '';
  const brand = line.brand ? `<div class="sub">${e(line.brand)}</div>` : '';
  return `
    <tr>
      <td class="num">${index + 1}</td>
      <td>
        <div class="name">${e(line.name)}</div>
        <div class="sub">${e(line.code)}</div>
        ${brand}
      </td>
      <td class="right mono">${dec2(line.quantity)} ${e(line.unit)}${bonus}</td>
      <td class="right mono">${money(line.rate)}</td>
      <td class="right mono">${line.discountPct ? `${dec2(line.discountPct)}%` : '—'}</td>
      <td class="right mono strong">${money(line.amount)}</td>
    </tr>`;
}

/**
 * Build the whole document.
 *
 * @param {object} invoice as `GET /dealer/sales/:id` returns it
 * @returns {string} a complete HTML document
 */
export function invoiceDocument(invoice) {
  const { org, customer, totals, lines = [] } = invoice;
  const draft = invoice.status && invoice.status !== 'POSTED';

  const detail = (label, value) =>
    value ? `<div><span class="k">${e(label)}</span><span class="v">${e(value)}</span></div>` : '';

  const totalRow = (label, value, cls = '') =>
    `<tr class="${cls}"><td>${e(label)}</td><td class="right mono">${money(value)}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${e(invoice.no)} — ${e(customer.name)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #1A1817; background: #fff;
    font-family: 'Instrument Sans', 'Segoe UI', system-ui, sans-serif;
    font-size: 12px; line-height: 1.45;
  }
  .mono { font-family: 'Roboto Mono', ui-monospace, monospace; }
  .right { text-align: right; }
  .strong { font-weight: 700; }
  .sub { font-size: 10.5px; color: #8C877F; margin-top: 2px; }

  header { display: flex; justify-content: space-between; gap: 24px;
           border-bottom: 2px solid #8A2233; padding-bottom: 12px; }
  .org-name { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; }
  .org-line { font-size: 11px; color: #4A463F; margin-top: 2px; }
  .doc { text-align: right; flex: none; }
  .doc-title { font-size: 15px; font-weight: 700; color: #8A2233; letter-spacing: 0.04em;
               text-transform: uppercase; }
  .doc-no { font-size: 17px; font-weight: 700; margin-top: 2px; }

  .draft { margin-top: 10px; padding: 6px 10px; border: 1px solid #B58900;
           background: #FDF6E3; color: #8A5A00; font-size: 11px; font-weight: 600; }

  .parties { display: flex; gap: 28px; margin: 16px 0 14px; }
  .party { flex: 1; }
  .party h2 { margin: 0 0 5px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
              text-transform: uppercase; color: #8C877F; }
  .party .who { font-size: 13.5px; font-weight: 700; }
  .meta { flex: none; min-width: 190px; font-size: 11px; }
  .meta div { display: flex; justify-content: space-between; gap: 14px; padding: 2px 0; }
  .meta .k { color: #8C877F; }
  .meta .v { font-weight: 600; }

  table.goods { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.goods th { background: #FAF9F7; border-top: 1px solid #E3E0DA;
                   border-bottom: 1px solid #E3E0DA; padding: 7px 8px; text-align: left;
                   font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em;
                   text-transform: uppercase; color: #6E6A64; }
  table.goods td { padding: 8px; border-bottom: 1px solid #F0EEE9; vertical-align: top; }
  table.goods td.num { color: #8C877F; width: 26px; }
  table.goods .name { font-weight: 600; }

  .foot { display: flex; justify-content: space-between; gap: 28px; margin-top: 14px; }
  .terms { font-size: 11px; color: #4A463F; max-width: 300px; }
  table.totals { border-collapse: collapse; min-width: 240px; }
  table.totals td { padding: 4px 0 4px 18px; }
  table.totals tr.net td { border-top: 1px solid #E3E0DA; font-weight: 700; font-size: 13.5px;
                           padding-top: 8px; }
  table.totals tr.due td { border-top: 1px solid #E3E0DA; font-weight: 700; color: #8A2233;
                           padding-top: 8px; }

  .signatures { display: flex; justify-content: space-between; gap: 40px; margin-top: 44px; }
  .sign { flex: 1; border-top: 1px solid #CFC9C0; padding-top: 5px; font-size: 10.5px;
          color: #6E6A64; }
  footer { margin-top: 22px; border-top: 1px solid #F0EEE9; padding-top: 8px;
           font-size: 10px; color: #A39D93; text-align: center; }

  .toolbar { position: fixed; top: 0; left: 0; right: 0; padding: 10px;
             background: #1A1817; text-align: center; }
  .toolbar button { border: 0; border-radius: 6px; padding: 8px 18px; font-size: 13px;
                    font-weight: 600; cursor: pointer; background: #8A2233; color: #fff; }
  .toolbar span { color: #CFC9C0; font-size: 12px; margin-left: 12px; }
  .sheet { padding-top: 52px; }
  /* The toolbar is for the screen; paper gets the document alone. */
  @media print { .toolbar { display: none; } .sheet { padding-top: 0; } }
</style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">Print this invoice</button>
    <span>or press Ctrl+P</span>
  </div>

  <div class="sheet">
    <header>
      <div>
        <div class="org-name">${e(org.name)}</div>
        ${org.headOffice ? `<div class="org-line">${e(org.headOffice)}</div>` : ''}
        <div class="org-line">${[
          org.mobile ? `Mobile ${e(org.mobile)}` : '',
          org.email ? e(org.email) : '',
        ].filter(Boolean).join(' &nbsp;·&nbsp; ')}</div>
        <div class="org-line">${[
          org.tradeLicenceNo ? `Trade licence ${e(org.tradeLicenceNo)}` : '',
          org.binNo ? `BIN ${e(org.binNo)}` : '',
        ].filter(Boolean).join(' &nbsp;·&nbsp; ')}</div>
      </div>
      <div class="doc">
        <div class="doc-title">Sales Invoice</div>
        <div class="doc-no mono">${e(invoice.no)}</div>
        <div class="org-line">${e(invoice.date)}</div>
      </div>
    </header>

    ${draft ? `<div class="draft">Not posted — status ${e(invoice.status)}. This is not a valid invoice.</div>` : ''}

    <div class="parties">
      <div class="party">
        <h2>Invoice to</h2>
        <div class="who">${e(customer.name)}</div>
        ${customer.bn ? `<div>${e(customer.bn)}</div>` : ''}
        ${customer.address ? `<div class="sub">${e(customer.address)}</div>` : ''}
        ${customer.mobile ? `<div class="sub mono">${e(customer.mobile)}</div>` : ''}
      </div>
      <div class="meta">
        ${detail('Customer', customer.code)}
        ${detail('Terms', invoice.terms)}
        ${detail('Due', invoice.dueDate)}
        ${detail('Delivered from', invoice.warehouse)}
        ${detail('Sales officer', invoice.salesperson)}
      </div>
    </div>

    <table class="goods">
      <thead>
        <tr>
          <th></th><th>Item</th><th class="right">Quantity</th>
          <th class="right">Rate</th><th class="right">Discount</th><th class="right">Amount</th>
        </tr>
      </thead>
      <tbody>${lines.map(lineRow).join('')}</tbody>
    </table>

    <div class="foot">
      <div class="terms">
        ${invoice.terms ? `Payment terms: ${e(invoice.terms)}.` : ''}
        ${totals.due > 0 ? ' The balance above remains payable.' : ' Settled in full — thank you.'}
      </div>
      <table class="totals">
        ${totalRow('Gross', totals.gross)}
        ${totals.discount ? totalRow('Discount', -totals.discount) : ''}
        ${totalRow('Net payable', totals.net, 'net')}
        ${totals.paid ? totalRow('Paid', totals.paid) : ''}
        ${totalRow('Balance due', totals.due, 'due')}
      </table>
    </div>

    <div class="signatures">
      <div class="sign">Received the goods in good order</div>
      <div class="sign">For ${e(org.name)}</div>
    </div>

    <footer>${e(invoice.no)} &nbsp;·&nbsp; ${e(org.name)} &nbsp;·&nbsp; amounts in ${e(org.currency || 'BDT')}</footer>
  </div>
</body>
</html>`;
}

/**
 * Open the invoice in its own window, ready to print.
 *
 * A window rather than the current page, so the application is still there
 * behind it and nothing about the app's own stylesheet reaches the paper.
 *
 * @returns {boolean} false when the browser blocked the window
 */
export function openInvoice(invoice, open = (...args) => window.open(...args)) {
  const printer = open('', '_blank', 'noopener,width=900,height=1000');
  if (!printer) return false;

  printer.document.write(invoiceDocument(invoice));
  printer.document.close();
  return true;
}
