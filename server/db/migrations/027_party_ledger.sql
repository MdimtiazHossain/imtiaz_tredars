-- 027_party_ledger.sql — one running account per party, out of the journal.
--
-- The Customers screen has three tabs -- purchase history, payment history and
-- a ledger with a running balance -- and all three were written into the
-- browser as example rows. They showed the same four invoices for every
-- customer, and the ledger's closing balance had no relationship to what the
-- customer actually owed.
--
-- Nothing had to be computed to fix that. Every posting that moves a party's
-- balance already writes a journal line naming them: a sale debits the
-- customer, a receipt credits them, a credit note takes it back off, a return
-- adjusts it, and a purchase does the same to a supplier the other way round.
-- The statement is those lines in date order with a running total, which is
-- what a statement has always been.
--
-- What the journal does not carry is the document's number -- it holds a
-- reference type and an id, because a narration is prose and prose is not a
-- key. A statement has to print the number, so the reference is resolved here
-- rather than in six report queries that would each resolve it differently.

CREATE VIEW v_party_ledger AS
SELECT l.id,
       l.org_id,
       l.entry_date,
       l.business_type,
       l.party_type,
       l.party_id,
       l.narration,
       l.debit,
       l.credit,
       l.reference_type,
       l.reference_id,
       c.code AS account_code,
       c.name AS account_name,
       -- The number the document is known by. CASE rather than a chain of
       -- COALESCE so only the one table that can hold it is ever read.
       CASE l.reference_type
         WHEN 'dealer_sales'     THEN (SELECT txn_no  FROM dealer_sales     WHERE id = l.reference_id)
         WHEN 'dealer_purchases' THEN (SELECT txn_no  FROM dealer_purchases WHERE id = l.reference_id)
         WHEN 'crop_sales'       THEN (SELECT txn_no  FROM crop_sales       WHERE id = l.reference_id)
         WHEN 'crop_purchases'   THEN (SELECT txn_no  FROM crop_purchases   WHERE id = l.reference_id)
         WHEN 'payments'         THEN (SELECT txn_no  FROM payments         WHERE id = l.reference_id)
         WHEN 'returns'          THEN (SELECT txn_no  FROM returns          WHERE id = l.reference_id)
         WHEN 'credit_notes'     THEN (SELECT note_no FROM credit_notes     WHERE id = l.reference_id)
       END AS document_no
  FROM ledger_entries l
  JOIN chart_of_accounts c ON c.id = l.coa_id
 WHERE l.party_id IS NOT NULL;

COMMENT ON VIEW v_party_ledger IS
  'Every journal line that moves a trading party''s balance, with the number '
  'of the document that caused it. Debit less credit is what the party owes '
  'us; a negative balance is what we owe them.';
