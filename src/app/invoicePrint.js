import { money, dec2 } from '../domain/format.js';
import { e, printableDocument, openPrintable } from './printDocument.js';

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

  return printableDocument({
    title: `${e(invoice.no)} — ${e(customer.name)}`,
    action: 'Print this invoice',
    body: `
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
        ${customer.binNo ? `<div class="sub mono">BIN ${e(customer.binNo)}</div>` : ''}
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
        ${totals.tax ? totalRow('Taxable value', totals.net) : ''}
        ${totals.tax ? totalRow(totals.taxLabel || 'VAT', totals.tax) : ''}
        ${totalRow('Net payable', totals.total ?? totals.net, 'net')}
        ${totals.paid ? totalRow('Paid', totals.paid) : ''}
        ${totalRow('Balance due', totals.due, 'due')}
      </table>
    </div>

    <div class="signatures">
      <div class="sign">Received the goods in good order</div>
      <div class="sign">For ${e(org.name)}</div>
    </div>

    <footer>${e(invoice.no)} &nbsp;·&nbsp; ${e(org.name)} &nbsp;·&nbsp; amounts in ${e(org.currency || 'BDT')}</footer>
`,
  });
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
  return openPrintable(invoiceDocument(invoice), open);
}
