import { query, num } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';

/**
 * VAT.
 *
 * Two rules decide everything here, and they are worth stating plainly because
 * every awkward case below follows from one of them.
 *
 * **A rate is looked up, never assumed.** The rate a line is charged at comes
 * from the product or the crop, falling back to whichever rate the
 * organisation marked as its default. Nothing in this file knows that the
 * standard rate is fifteen percent, because it moves at a budget and a number
 * compiled into a service is a number that is wrong the morning after.
 *
 * **A document keeps the rate it used.** The percentage is written onto the
 * line beside the id of the rate it came from. Changing a rate then changes
 * what tomorrow's invoices charge and leaves every invoice already raised
 * saying exactly what it said. Without that, a rate change would silently
 * restate a year of filed returns.
 *
 * Rounding is per line, to paisa, which is the precision the columns hold.
 * Taxing the document total instead would produce a figure the lines do not
 * add up to, and a challanpatra whose column does not foot is a challanpatra
 * an auditor stops at.
 */

/** Round to paisa, which is what the money columns hold. */
const paisa = (n) => Math.round(n * 100) / 100;

/**
 * How the business is registered, and what it charges by default.
 *
 * Unregistered, there is no VAT on anything: the rates still exist as master
 * data, and every document behaves exactly as it did before VAT was modelled.
 */
export async function taxContext(orgId, client = { query }) {
  const { rows: org } = await client.query(
    `SELECT is_vat_registered, sale_prices_include_tax, purchase_prices_include_tax, bin_no
       FROM organizations WHERE id = $1`,
    [orgId]
  );

  const { rows: rates } = await client.query(
    `SELECT id, code, name, name_bn, kind, rate, is_reclaimable, is_default, is_active
       FROM tax_rates WHERE org_id = $1 ORDER BY is_default DESC, rate DESC, code`,
    [orgId]
  );

  const byId = new Map(rates.map((r) => [Number(r.id), normalise(r)]));
  return {
    registered: !!org[0]?.is_vat_registered,
    // Each side of the trade quotes its own way: this business sells at a
    // price with the tax inside it and buys at a price before it.
    pricesIncludeTax: {
      SALE: !!org[0]?.sale_prices_include_tax,
      PURCHASE: !!org[0]?.purchase_prices_include_tax,
    },
    binNo: org[0]?.bin_no || '',
    rates: rates.map(normalise),
    byId,
    defaultRate: rates.filter((r) => r.is_default).map(normalise)[0] || null,
  };
}

const normalise = (r) => ({
  id: Number(r.id),
  code: r.code,
  name: r.name,
  nameBn: r.name_bn,
  kind: r.kind,
  rate: num(r.rate),
  isReclaimable: r.is_reclaimable,
  isDefault: r.is_default,
  isActive: r.is_active,
});

/**
 * Which rate each product or crop attracts.
 *
 * One query for the whole document rather than one per line: a fifty-line
 * invoice should not be fifty round trips, and every line of it resolves
 * against the same master anyway.
 *
 * @param {'products'|'crops'} table
 * @param {number[]} ids
 */
export async function ratesForItems(client, { orgId, table, ids }) {
  const unique = [...new Set(ids.filter(Boolean).map(Number))];
  if (!unique.length) return new Map();

  const { rows } = await client.query(
    `SELECT id, tax_rate_id FROM ${table} WHERE org_id = $1 AND id = ANY($2)`,
    [orgId, unique]
  );
  return new Map(rows.map((r) => [Number(r.id), r.tax_rate_id ? Number(r.tax_rate_id) : null]));
}

/**
 * The rate one line is charged at.
 *
 * An explicit choice on the line wins -- an operator who says this delivery is
 * zero-rated has a reason. Otherwise the item's own rate, and otherwise the
 * organisation's default. An unregistered business charges nothing whatever
 * the master says.
 */
export function rateFor(context, { taxRateId, itemRateId }) {
  if (!context.registered) return null;

  const chosen = taxRateId ? context.byId.get(Number(taxRateId)) : null;
  if (taxRateId && !chosen) throw badRequest('INVALID_TAX_RATE', 'That tax rate does not exist.');
  if (chosen) return chosen;

  const item = itemRateId ? context.byId.get(Number(itemRateId)) : null;
  return item || context.defaultRate || null;
}

/**
 * Split one line's money into what the goods are worth and what the tax is.
 *
 * `amount` is the line after its discount. Where the business quotes prices
 * with VAT already inside them -- ordinary in Bangladeshi retail -- that
 * amount is what the customer pays, and the taxable value is what is left
 * once the tax within it is taken out.
 *
 * @returns {{taxableValue:number, taxAmount:number, rate:number, taxRateId:number|null}}
 */
export function splitLineTax({ amount, rate, inclusive }) {
  const value = num(amount);
  const pct = rate ? num(rate.rate) : 0;

  if (!rate || !pct) {
    return { taxableValue: paisa(value), taxAmount: 0, rate: pct, taxRateId: rate ? rate.id : null };
  }

  if (inclusive) {
    const taxable = paisa(value / (1 + pct / 100));
    // The tax is the remainder rather than a second rounding, so the two parts
    // always add back to the amount the customer was quoted.
    return { taxableValue: taxable, taxAmount: paisa(value - taxable), rate: pct, taxRateId: rate.id };
  }

  return { taxableValue: paisa(value), taxAmount: paisa((value * pct) / 100), rate: pct, taxRateId: rate.id };
}

/**
 * Apply tax to a whole document's lines.
 *
 * Takes lines that already carry `lineNet` -- the value after discount, which
 * every document's own totals function works out -- and returns them with the
 * tax split out, plus the document totals.
 *
 * @param {object} o
 * @param {Array} o.lines       each with lineNet, and optionally taxRateId
 * @param {Map} o.itemRates     item id -> tax rate id
 * @param {(line: object) => number|null} o.itemIdOf  which item a line names
 */
export function applyTax({ lines, context, itemRates, itemIdOf, inclusive }) {
  let taxableTotal = 0;
  let taxTotal = 0;

  const taxed = lines.map((line) => {
    const itemId = itemIdOf ? itemIdOf(line) : null;
    const rate = rateFor(context, {
      taxRateId: line.taxRateId,
      itemRateId: itemRates && itemId ? itemRates.get(Number(itemId)) : null,
    });
    const split = splitLineTax({ amount: line.lineNet, rate, inclusive });

    taxableTotal += split.taxableValue;
    taxTotal += split.taxAmount;

    return {
      ...line,
      // Inclusive pricing moves what the goods are worth, so the line's net is
      // restated rather than the tax being bolted on beside a stale figure.
      lineNet: split.taxableValue,
      taxRateId: split.taxRateId,
      taxRate: split.rate,
      taxAmount: split.taxAmount,
    };
  });

  return {
    lines: taxed,
    net: paisa(taxableTotal),
    tax: paisa(taxTotal),
    total: paisa(taxableTotal + taxTotal),
  };
}

/**
 * Whether tax paid on a purchase can be claimed back.
 *
 * Where it cannot, it is part of what the goods cost rather than a receivable
 * from the NBR, and the inventory has to carry it -- otherwise the business
 * would be sitting on a rebate it will never be paid.
 */
export function reclaimableTax(context, lines) {
  let reclaimable = 0;
  let embedded = 0;

  for (const line of lines) {
    const carried = embeddedTaxOf(context, line);
    embedded += carried;
    reclaimable += num(line.taxAmount) - carried;
  }

  return { reclaimable: paisa(reclaimable), embedded: paisa(embedded) };
}

/**
 * The part of one line's tax that the goods themselves have to carry.
 *
 * Nothing where the rate can be claimed back, the whole of it where it cannot.
 * Asked per line rather than per document because it has to reach the batch
 * that line becomes: stock valued without it would leave the inventory account
 * standing above the batches it is supposed to be the sum of.
 */
export function embeddedTaxOf(context, line) {
  const amount = num(line.taxAmount);
  if (!amount) return 0;
  const rate = line.taxRateId ? context.byId.get(Number(line.taxRateId)) : null;
  return rate && rate.isReclaimable === false ? paisa(amount) : 0;
}

/**
 * Put VAT onto a priced document.
 *
 * The pricing functions work out what the goods are worth; this works out what
 * is charged on top of them, which is a different question with a different
 * answer per line. Keeping the two apart means a discount rule never has to
 * know about a rate and a rate never has to know about a discount.
 *
 * A document that names no tax at all -- an unregistered business, or every
 * line exempt -- comes back with the same figures it went in with and a total
 * equal to its net, which is exactly what every document said before VAT was
 * modelled.
 *
 * @param {'SALE'|'PURCHASE'} o.side  which basis the rates are quoted on
 */
export async function taxDocument(client, { orgId, input, priced, table, itemIdOf, side }) {
  const context = await taxContext(orgId, client);
  // The document may say outright how its rates are quoted; otherwise the
  // organisation's basis for this side of the trade decides.
  const inclusive = input.taxInclusive ?? context.pricesIncludeTax[side] ?? false;
  const itemRates = await ratesForItems(client, {
    orgId,
    table,
    ids: priced.lines.map(itemIdOf),
  });

  // A purchase carries transport and handling in its net without them being
  // on any line. Rebuilding the net from the lines alone would drop them and
  // leave the principal owed less than the document says.
  const linesNet = priced.lines.reduce((total, l) => total + num(l.lineNet), 0);
  const carried = Math.round((num(priced.net) - linesNet) * 100) / 100;

  const applied = applyTax({ lines: priced.lines, context, itemRates, itemIdOf, inclusive });

  return {
    ...priced,
    lines: applied.lines,
    net: Math.round((applied.net + carried) * 100) / 100,
    tax: applied.tax,
    total: Math.round((applied.total + carried) * 100) / 100,
    taxInclusive: inclusive,
    context,
  };
}
