/**
 * Document numbering.
 *
 * Numbers follow the pattern the business already uses: PREFIX-YYMM-NNN, for
 * example PC-2608-014. The counter lives in `document_sequences` and is taken
 * with a single UPDATE ... RETURNING inside the caller's transaction, so two
 * concurrent posts serialise on the row lock and can never collide.
 */

/** Prefixes match the numbering shown on the Settings screen. */
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
  const prefix = DOC_PREFIXES[docType];
  if (!prefix) throw new Error(`Unknown document type: ${docType}`);

  const { rows } = await client.query(
    'SELECT next_document_no($1,$2,$3,$4,$5) AS no',
    [orgId, docType, prefix, periodOf(date), docType === 'approval' ? 4 : 3]
  );
  return rows[0].no;
}
