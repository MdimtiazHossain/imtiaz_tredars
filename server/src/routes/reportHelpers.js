/**
 * Shared building blocks for report definitions.
 *
 * Kept in their own module so the definitions can be split across files
 * without either importing the other.
 */

/**
 * Column descriptor.
 *
 * A report says what each column *is* — money, a count, a percentage — and the
 * client renders accordingly. Without this the browser would have to guess
 * from the value, which reads a rate of 30,500 the same way as a quantity of
 * 30,500.
 *
 * @param {string} key    property on each row
 * @param {string} label  header text
 * @param {'text'|'code'|'money'|'number'|'percent'} [type='text']
 */
export const col = (key, label, type = 'text') => ({ key, label, type });

/**
 * Build the shared WHERE fragment for date range and business type.
 *
 * Appends to `params` and returns SQL to splice after an existing condition,
 * so every caller filters identically.
 *
 * @param {object} q       parsed query string
 * @param {Array} params   bind values, appended to in place
 * @param {string} alias   the table's alias in the query
 * @param {string} [businessColumn='business_type']
 */
export function dateAndBusiness(q, params, alias, businessColumn = 'business_type') {
  let where = '';
  if (q.from) {
    params.push(q.from);
    where += ` AND ${alias}.txn_date >= $${params.length}`;
  }
  if (q.to) {
    params.push(q.to);
    where += ` AND ${alias}.txn_date <= $${params.length}`;
  }
  if (q.businessType !== 'ALL') {
    params.push(q.businessType);
    where += ` AND ${alias}.${businessColumn} = $${params.length}`;
  }
  return where;
}
