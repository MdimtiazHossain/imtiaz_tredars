import { describe, it, expect } from 'vitest';
import { invoiceDocument, openInvoice } from '../src/app/invoicePrint.js';
import { money } from '../src/domain/format.js';

/**
 * The printed invoice.
 *
 * A document that leaves the building: it is handed to a customer, so what it
 * says has to be right, and what it must never carry is the business's own
 * margin. These check both, and that a name typed by an operator cannot become
 * markup on the page.
 */
const INVOICE = {
  no: 'DS-2608-221',
  date: '28 Aug 2026',
  status: 'POSTED',
  terms: 'Credit 15 days',
  dueDate: '12 Sep 2026',
  warehouse: 'Bogura Depot',
  salesperson: 'Shamim Reza',
  customer: {
    code: 'CUS-003', name: 'Nabin Krishi Bitan', bn: 'নবীন কৃষি বিতান',
    mobile: '01911-450288', address: 'Mohadevpur, Naogaon', creditDays: 21,
  },
  org: {
    name: 'Imtiaz Tredars', tradeLicenceNo: 'BOG-TL-2019-04471', binNo: '003912847-0201',
    headOffice: 'Sherpur Road, Bogura', mobile: '01711-330099',
    email: 'accounts@example.com', currency: 'BDT',
  },
  lines: [
    { lineNo: 1, code: 'P-1001', name: 'Ridomil Gold', brand: 'Syngenta', unit: 'Pcs',
      quantity: 120, bonus: 4, rate: 295, discountPct: 2, amount: 34692 },
    { lineNo: 2, code: 'P-1004', name: 'Zinc Sulphate', brand: '', unit: 'Pcs',
      quantity: 60, bonus: 0, rate: 510, discountPct: 0, amount: 30600 },
  ],
  totals: { gross: 66000, discount: 708, net: 65292, paid: 10000, due: 55292 },
};

describe('the printed invoice', () => {
  it('names both parties, because an invoice without a seller is not one', () => {
    const html = invoiceDocument(INVOICE);
    expect(html).toContain('Imtiaz Tredars');
    expect(html).toContain('BOG-TL-2019-04471');
    expect(html).toContain('003912847-0201');
    expect(html).toContain('Nabin Krishi Bitan');
    expect(html).toContain('Mohadevpur, Naogaon');
  });

  it('carries the customer name in Bangla as itself', () => {
    expect(invoiceDocument(INVOICE)).toContain('নবীন কৃষি বিতান');
  });

  it('prints every line and the money that follows from them', () => {
    const html = invoiceDocument(INVOICE);
    expect(html).toContain('Ridomil Gold');
    expect(html).toContain('Zinc Sulphate');
    expect(html).toContain('4.00 Pcs bonus');
    expect(html).toContain(money(65292));
    expect(html).toContain(money(55292));
  });

  it('never puts profit or cost on a document the customer receives', () => {
    const withProfit = { ...INVOICE, profit: 12345, totals: { ...INVOICE.totals, cost: 52000 } };
    const html = invoiceDocument(withProfit);
    expect(html).not.toContain('12,345');
    expect(html).not.toContain('52,000');
    expect(html.toLowerCase()).not.toContain('profit');
  });

  it('marks a document that has not been posted', () => {
    const draft = { ...INVOICE, status: 'PENDING_APPROVAL' };
    expect(invoiceDocument(draft)).toContain('not a valid invoice');
    expect(invoiceDocument(INVOICE)).not.toContain('not a valid invoice');
  });

  it('escapes a name an operator typed rather than letting it become markup', () => {
    const nasty = {
      ...INVOICE,
      customer: { ...INVOICE.customer, name: '<script>alert(1)</script> & Sons' },
    };
    const html = invoiceDocument(nasty);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; Sons');
  });

  it('hides its own toolbar from the paper', () => {
    const html = invoiceDocument(INVOICE);
    expect(html).toContain('@media print');
    expect(html).toContain('.toolbar { display: none; }');
  });

  it('reports a blocked pop-up rather than pretending it printed', () => {
    expect(openInvoice(INVOICE, () => null)).toBe(false);
  });

  it('writes the document into the window it opened', () => {
    const written = [];
    const printer = /** @type {any} */ ({ document: { write: (h) => written.push(h), close: () => {} } });
    expect(openInvoice(INVOICE, () => printer)).toBe(true);
    expect(written[0]).toContain('DS-2608-221');
  });
});
