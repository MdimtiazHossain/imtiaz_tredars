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

/**
 * Which entity a report has been narrowed to.
 *
 * The Reports Centre offers a filter bar — warehouse, customer, supplier, crop
 * or product — and every one of them read "All" and could not be changed,
 * because nothing behind them did anything. A filter that cannot filter is
 * worse than no filter: it tells the reader the report has been narrowed when
 * it has not.
 *
 * A report declares which filters apply to it and which column each one means,
 * because "customer" is `s.customer_id` on a sale and `i.sale_id`'s parent two
 * joins away on a sale line. The same object drives both this and the
 * catalogue, so a report can never offer a filter it does not apply.
 *
 * @param {object} q       parsed query string
 * @param {Array} params   bind values, appended to in place
 * @param {object} columns filter name -> SQL column, e.g. {customerId: 's.customer_id'}
 */
export function entityFilters(q, params, columns) {
  let where = '';
  for (const [key, column] of Object.entries(columns || {})) {
    const value = q[key];
    if (value === undefined || value === null || value === '') continue;
    params.push(value);
    where += ` AND ${column} = $${params.length}`;
  }
  return where;
}

/**
 * What a filter is called on screen, and where its options come from.
 *
 * The client needs both to draw a picker: a label, and which master list to
 * offer. Keyed by the same names the query string uses, so a report's filter
 * map is the only thing that has to be maintained.
 */
export const FILTER_LABELS = {
  warehouseId: { label: 'Warehouse', source: 'warehouses' },
  customerId: { label: 'Customer', source: 'customers' },
  supplierId: { label: 'Supplier', source: 'suppliers' },
  companyId: { label: 'Company', source: 'companies' },
  productId: { label: 'Product', source: 'products' },
  cropId: { label: 'Crop', source: 'crops' },
  employeeId: { label: 'Salesperson', source: 'employees' },
  categoryId: { label: 'Category', source: 'expenseCategories' },
};

/**
 * Name the entities a report was narrowed to.
 *
 * An exported report is filed and read months later, so its header has to say
 * what it covers. Printing "Business type: All" on a report showing one
 * customer is a document that misrepresents itself, and the reader has no way
 * to tell.
 *
 * Ids are resolved to names here rather than carried from the browser: the
 * client sends what to filter by, and what the server actually filtered by is
 * what the paper should say.
 *
 * @param {(text: string, params: Array) => Promise<{rows: Array}>} run
 * @param {object} q       parsed query
 * @param {object} columns the report's filter map
 * @returns {Promise<string[]>} e.g. ['Customer: Messrs. Rahman Traders']
 */
export async function describeEntityFilters(run, orgId, q, columns) {
  const TABLES = {
    warehouseId: 'warehouses',
    customerId: 'customers',
    supplierId: 'suppliers',
    companyId: 'companies',
    productId: 'products',
    cropId: 'crops',
    employeeId: 'employees',
    categoryId: 'expense_categories',
  };

  const said = [];
  const seen = new Set();

  for (const key of Object.keys(columns || {})) {
    const id = q[key];
    if (!id || seen.has(key)) continue;
    seen.add(key);

    const table = TABLES[key];
    const label = (FILTER_LABELS[key] || {}).label || key;
    if (!table) continue;

    const { rows } = await run(`SELECT name FROM ${table} WHERE id = $1`, [id]);
    // A filter naming a record that no longer exists still narrowed the
    // report, so it is reported by id rather than silently dropped.
    said.push(`${label}: ${rows.length ? rows[0].name : `#${id}`}`);
  }

  return said;
}
