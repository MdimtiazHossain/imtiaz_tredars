import { query, num } from '../lib/db.js';
import { badRequest, unprocessable } from '../lib/errors.js';
import { writeLedger, ledgerAccount, LEDGER } from './financeService.js';
import { writeAudit } from '../lib/audit.js';

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

/* ------------------------------------------------------------ apportionment */

/** The period clause both halves of the ratio are measured over. */
function periodClause(params, { from, to }) {
  let where = '';
  if (from) {
    params.push(from);
    where += ` AND txn_date >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    where += ` AND txn_date <= $${params.length}`;
  }
  return where;
}

/**
 * How much of a period's input tax the business actually earned the right to.
 *
 * A credit is earned by making supplies inside the VAT chain, so a business
 * making both kinds may not claim all of what it paid. The Act asks two
 * questions in order, and the order is the whole of the difference:
 *
 *   1. What is this input attributable to? Input tax wholly used for taxable
 *      supplies is claimed in full, and input tax wholly used for exempt ones
 *      is not claimed at all. No ratio is involved in either.
 *   2. Only what remains -- inputs serving both -- is apportioned, by turnover.
 *
 * Doing (2) alone, across the whole business, is the tempting mistake and an
 * expensive one here. Every taka of this organisation's input tax arises on
 * the dealer side, whose supplies are standard-rated; the crop side buys from
 * farmers, which is exempt, and pays no input tax at all. But crop turnover is
 * the larger part of the business, so a single turnover ratio would disallow
 * most of a claim that was wholly and properly attributable to taxable supply.
 *
 * The business line a document belongs to is what attributes it: crop inputs
 * make crop supplies and dealer inputs make dealer supplies. So each line is
 * apportioned by its own supply mix, which is direct attribution between the
 * lines and turnover apportionment within them.
 *
 * Measured on value rather than on tax, because an exempt supply charges no
 * tax and would weigh nothing in a ratio built on tax -- the opposite of what
 * it should do to a claim.
 *
 * The input tax here is what was already found claimable by its own rate: a
 * truncated-rate purchase never enters the pool, and is not narrowed twice.
 */
export async function apportionment(client, { orgId, from, to }) {
  const db = client || { query };

  const supplyParams = [orgId];
  const supplyWhere = periodClause(supplyParams, { from, to });
  const { rows: supplies } = await db.query(
    `SELECT business_type,
            COALESCE(SUM(taxable_value), 0)    AS total,
            COALESCE(SUM(creditable_value), 0) AS creditable
       FROM v_output_tax WHERE org_id = $1${supplyWhere}
      GROUP BY business_type`,
    supplyParams
  );

  const inputParams = [orgId];
  const inputWhere = periodClause(inputParams, { from, to });
  const { rows: inputs } = await db.query(
    `SELECT business_type, COALESCE(SUM(reclaimable_tax), 0) AS tax
       FROM v_input_tax WHERE org_id = $1${inputWhere}
      GROUP BY business_type`,
    inputParams
  );

  const supplyOf = new Map(supplies.map((r) => [r.business_type, r]));
  const businessTypes = new Set([
    ...supplies.map((r) => r.business_type),
    ...inputs.map((r) => r.business_type),
  ]);

  const lines = [];
  for (const businessType of [...businessTypes].sort()) {
    const supply = supplyOf.get(businessType);
    const total = supply ? num(supply.total) : 0;
    const creditable = supply ? num(supply.creditable) : 0;
    const tax = num((inputs.find((r) => r.business_type === businessType) || {}).tax);

    // A line that supplied nothing this period has no mix to be measured by.
    // Withholding its claim on that basis would punish a business for buying
    // in one month and selling in the next.
    const ratio = total > 0 ? Math.min(1, Math.max(0, creditable / total)) : 1;
    const claimable = paisa(tax * ratio);

    lines.push({
      businessType,
      creditableSupplies: paisa(creditable),
      totalSupplies: paisa(total),
      ratio,
      inputTax: paisa(tax),
      claimable,
      disallowed: paisa(tax - claimable),
    });
  }

  const sum = (key) => paisa(lines.reduce((t, l) => t + l[key], 0));
  const inputTax = sum('inputTax');
  const claimable = sum('claimable');

  return {
    lines,
    creditableSupplies: sum('creditableSupplies'),
    totalSupplies: sum('totalSupplies'),
    // What share of the claim survived, which is not the turnover ratio of any
    // one line and is the only ratio the return is actually filed on.
    ratio: inputTax > 0 ? claimable / inputTax : 1,
    inputTax,
    claimable,
    disallowed: paisa(inputTax - claimable),
  };
}

/**
 * Journal a period's disallowed input tax, once.
 *
 * The claim is only known at the end of a period -- it depends on what was
 * sold, which is not knowable when the input was bought -- so input VAT is
 * posted in full as it arrives and the part that turns out not to have been
 * earned is taken back out here. Until this runs the input VAT account stands
 * above what the return may claim, which is the divergence this exists to
 * close.
 */
export async function postApportionment(client, { orgId, user, actor, from, to }) {
  const { rows: already } = await client.query(
    `SELECT id FROM tax_apportionments
      WHERE org_id = $1 AND period_from = $2 AND period_to = $3`,
    [orgId, from, to]
  );
  if (already.length) {
    throw unprocessable(
      'ALREADY_APPORTIONED',
      'This period has already been apportioned. A period is adjusted once.'
    );
  }

  const worked = await apportionment(client, { orgId, from, to });

  const { rows } = await client.query(
    `INSERT INTO tax_apportionments
       (org_id, period_from, period_to, creditable_supplies, total_supplies,
        credit_ratio, input_tax, claimable, disallowed, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      orgId,
      from,
      to,
      worked.creditableSupplies,
      worked.totalSupplies,
      worked.ratio,
      worked.inputTax,
      worked.claimable,
      worked.disallowed,
      user.id,
    ]
  );
  const apportionmentId = Number(rows[0].id);

  // Nothing to journal where every supply earned its credit, which is the
  // ordinary case for a business making one kind of supply.
  if (worked.disallowed > 0) {
    const shared = {
      orgId,
      entryDate: to,
      businessType: 'ALL',
      narration: `Input VAT not claimable for ${from} to ${to}`,
      referenceType: 'tax_apportionments',
      referenceId: apportionmentId,
      userId: user.id,
    };
    await writeLedger(client, {
      ...shared,
      coaId: await ledgerAccount(client, orgId, LEDGER.IRRECOVERABLE_VAT),
      debit: worked.disallowed,
      credit: 0,
    });
    await writeLedger(client, {
      ...shared,
      coaId: await ledgerAccount(client, orgId, LEDGER.INPUT_VAT),
      debit: 0,
      credit: worked.disallowed,
    });
  }

  await writeAudit(client, {
    actor,
    entityType: 'tax_apportionments',
    entityId: apportionmentId,
    action: 'CREATE',
    newValue: worked,
    summary: `Input tax apportioned for ${from} to ${to} at ${(worked.ratio * 100).toFixed(2)}%`,
  });

  return { id: apportionmentId, periodFrom: from, periodTo: to, ...worked };
}
