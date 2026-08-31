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
