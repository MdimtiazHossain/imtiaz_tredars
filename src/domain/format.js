/**
 * Money and number formatting for the Bangladeshi market.
 *
 * The app reports in BDT and uses the Indian digit grouping (lakh / crore)
 * that Bangladeshi accounting follows, matching the imported design.
 */

/** Format a taka amount, e.g. `৳30,20,000`. */
export function money(n, dec) {
  const v = dec ? Number(n).toFixed(dec) : Math.round(Number(n) || 0);
  return '৳' + Number(v).toLocaleString('en-IN');
}

/** Format an integer with lakh/crore grouping. */
export function int(n) {
  return Number(Math.round(Number(n) || 0)).toLocaleString('en-IN');
}

/** Format with exactly two decimals, e.g. quantities in MT. */
export function dec2(n) {
  return (Number(n) || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Condense a taka amount to lakh or crore, e.g. `৳24.60 L`, `৳1.87 Cr`. */
export function lakh(n) {
  const v = (Number(n) || 0) / 100000;
  return '৳' + (Math.abs(v) >= 100 ? (v / 100).toFixed(2) + ' Cr' : v.toFixed(2) + ' L');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Spelled out, for headings rather than table cells. */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * A date as "27 Aug", the way the screens write one.
 *
 * Accepts what the API sends -- an ISO date or a full timestamp -- and reads
 * the calendar parts out of the string rather than through a Date, so a
 * timestamp at midnight UTC does not slip to the previous day east of
 * Greenwich.
 */
export function shortDate(value) {
  if (!value) return '—';
  const iso = String(value).slice(0, 10);
  const [, month, day] = iso.split('-');
  const index = Number(month) - 1;
  if (!day || index < 0 || index > 11) return String(value);
  return `${Number(day)} ${MONTHS[index]}`;
}

/**
 * Name the span a statement covers, e.g. `August 2026`, `1 Jan – 31 Mar 2026`.
 *
 * A heading that names a month it was not given is a claim, and the P&L header
 * carried one for as long as the figures beneath it were a fixture. This says
 * only what the period actually is: a whole calendar month by its name, a range
 * within one year without repeating the year, and anything else in full.
 */
export function periodLabel(period) {
  const from = period && period.from ? String(period.from).slice(0, 10) : '';
  const to = period && period.to ? String(period.to).slice(0, 10) : '';
  if (!from && !to) return 'all posted transactions';
  if (!from || !to) return shortDate(from || to);

  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const monthName = (y, m) => `${MONTH_NAMES[m - 1]} ${y}`;
  if (!MONTHS[fm - 1] || !MONTHS[tm - 1]) return `${from} – ${to}`;

  // A range that fills exactly one month is that month.
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  if (fy === ty && fm === tm) {
    if (fd === 1 && td === lastDay) return monthName(fy, fm);
    return `${fd} – ${td} ${monthName(fy, fm)}`;
  }

  if (fy === ty) return `${shortDate(from)} – ${shortDate(to)} ${ty}`;
  return `${shortDate(from)} ${fy} – ${shortDate(to)} ${ty}`;
}
