/**
 * Document numbering.
 *
 * Numbers follow the pattern the business already uses: PREFIX-YYMM-NNN, for
 * example PC-2608-014. The counter lives in `document_sequences` and is taken
 * with a single UPDATE ... RETURNING inside the caller's transaction, so two
 * concurrent posts serialise on the row lock and can never collide.
 */

/**
 * Fallback prefixes and widths.
 *
 * The Settings screen edits `document_number_formats`, and that is what a
 * running system numbers from. These are what a document type falls back to
 * when no row has been configured for it -- a doc type added by a later
 * migration, before anyone has visited the numbering panel.
 */
export const DOC_PREFIXES = {
  crop_purchase: 'PC',
  crop_sale: 'SC',
  dealer_purchase: 'DP',
  dealer_sale: 'DS',
  crop_batch: 'BC',
  receipt: 'RC',
  payment: 'PY',
  expense: 'EXP',
  adjustment: 'ADJ',
  transfer: 'TRF',
  movement: 'MOV',
  approval: 'AP',
  sale_return: 'SR',
  purchase_return: 'PR',
  credit_note: 'CN',
  debit_note: 'DN',
};

/** `YYMM` period key for a date. */
export function periodOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

/**
 * Allocate the next number for a document type.
 *
 * @param {import('pg').PoolClient} client must be inside a transaction
 * @param {number} orgId
 * @param {keyof typeof DOC_PREFIXES} docType
 * @param {string|Date} date  determines the YYMM period
 * @returns {Promise<string>} e.g. 'DS-2608-222'
 */
/** The prefix and padding a document type numbers with, configured or default. */
async function formatFor(client, orgId, docType) {
  const { rows } = await client.query(
    'SELECT prefix, padding FROM document_number_formats WHERE org_id = $1 AND doc_type = $2',
    [orgId, docType]
  );
  return {
    prefix: rows[0]?.prefix || DOC_PREFIXES[docType],
    padding: rows[0]?.padding ?? (docType === 'approval' ? 4 : 3),
  };
}

/** Assemble a number the way the allocator does, so a preview matches it. */
const compose = (prefix, period, value, padding) =>
  `${prefix}-${period}-${String(value).padStart(Math.max(padding, String(value).length), '0')}`;

export async function nextDocumentNo(client, orgId, docType, date) {
  if (!DOC_PREFIXES[docType]) throw new Error(`Unknown document type: ${docType}`);

  // The configured format wins; the built-in default covers a type nobody has
  // configured yet. Read inside the caller's transaction so a prefix changed
  // half a second ago is the one this document gets.
  const { prefix, padding } = await formatFor(client, orgId, docType);

  const { rows } = await client.query(
    'SELECT next_document_no($1,$2,$3,$4,$5) AS no',
    [orgId, docType, prefix, periodOf(date), padding]
  );
  return rows[0].no;
}

/**
 * What the next number would be, without taking it.
 *
 * The document screens show the number a document is about to get. They used to
 * show a fixed string written into the frontend -- every crop sale was going to
 * be SC-2608-052 -- so anyone who wrote the number on a paper file before
 * posting had recorded a document that would never exist.
 *
 * This reads the counter rather than advancing it, so opening a form does not
 * consume a number and abandoning one does not leave a hole in the sequence.
 * It is therefore a prediction: whoever posts first takes it, and a second
 * clerk with the same form open gets the one after. That is worth saying on
 * screen, and it is still the truth where a constant never was.
 *
 * @param {{query: Function}} client  a pool or a transaction client
 * @returns {Promise<string>}
 */
export async function peekDocumentNo(client, orgId, docType, date) {
  if (!DOC_PREFIXES[docType]) throw new Error(`Unknown document type: ${docType}`);

  const { prefix, padding } = await formatFor(client, orgId, docType);
  const period = periodOf(date);

  const { rows } = await client.query(
    `SELECT next_value FROM document_sequences
      WHERE org_id = $1 AND doc_type = $2 AND period = $3`,
    [orgId, docType, period]
  );

  // No row yet means nothing has been numbered in this period, and the
  // allocator will start it at one.
  return compose(prefix, period, rows[0]?.next_value ?? 1, padding);
}
