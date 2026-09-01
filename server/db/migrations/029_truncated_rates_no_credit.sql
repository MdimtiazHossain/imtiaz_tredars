-- 029_truncated_rates_no_credit.sql — a truncated rate buys no rebate.
--
-- The three truncated rates shipped as reclaimable, which is how a standard
-- rate behaves and not how these do. A truncated rate is a settlement: the
-- trade charges less than 15% and gives up the input credit that would
-- otherwise come with it. Claiming both is claiming twice.
--
-- Left as they were, marking a supply at 7.5% would have put its input tax
-- into the rebate the VAT return adds up, and the business would have filed
-- for money the NBR does not owe it -- while the goods carried a cost lighter
-- than they really were, because tax that is never repaid is part of what the
-- goods cost. Migration 026 built the machinery to tell the two apart; this is
-- the data finally saying which is which.
--
-- Zero-rated is deliberately untouched. It charges nothing *and* keeps the
-- credit -- that is the whole difference between zero-rating an export and
-- exempting a supply, and getting it wrong here would cost an exporter the
-- rebate they are actually owed.
--
-- The rate a document was raised under is recorded on the document, so nothing
-- already posted is restated: this decides what the next one does.

UPDATE tax_rates
   SET is_reclaimable = false,
       updated_at = now()
 WHERE kind = 'REDUCED'
   AND is_reclaimable;

COMMENT ON COLUMN tax_rates.is_reclaimable IS
  'Whether input tax at this rate may be set against output tax. '
  'False for exempt supplies and for the truncated rates, whose lower rate '
  'is given in exchange for the credit; the tax then forms part of the cost '
  'of what was bought.';
