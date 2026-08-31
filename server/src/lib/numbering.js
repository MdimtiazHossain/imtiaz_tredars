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
export async function nextDocumentNo(client, orgId, docType, date) {
  if (!DOC_PREFIXES[docType]) throw new Error(`Unknown document type: ${docType}`);

  // The configured format wins; the built-in default covers a type nobody has
  // configured yet. Read inside the caller's transaction so a prefix changed
  // half a second ago is the one this document gets.
  const { rows: format } = await client.query(
    'SELECT prefix, padding FROM document_number_formats WHERE org_id = $1 AND doc_type = $2',
    [orgId, docType]
  );
  const prefix = format[0]?.prefix || DOC_PREFIXES[docType];
  const padding = format[0]?.padding ?? (docType === 'approval' ? 4 : 3);

  const { rows } = await client.query(
    'SELECT next_document_no($1,$2,$3,$4,$5) AS no',
    [orgId, docType, prefix, periodOf(date), padding]
  );
  return rows[0].no;
}
