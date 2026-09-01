-- 030_return_credits_what_was_claimed.sql — give back only what was taken.
--
-- Migration 026 stopped a purchase at a non-reclaimable rate from being
-- claimed. It left the other half: sending those goods back still credited the
-- NBR with the whole of the tax on them.
--
-- So a truncated-rate purchase claimed nothing, and returning it gave back
-- something. The period's input tax fell by tax the business never reclaimed,
-- and the business paid that much more VAT than it owed. Not a rebate it was
-- not entitled to -- the opposite, money out of its own pocket, which is the
-- kind of error nobody comes to tell you about.
--
-- What is credited is now the reclaimable share of the document being
-- returned. A share rather than a flag, because one purchase can carry lines
-- at different rates and a return can be partial: half a mixed bill sends back
-- half of what that bill was allowed to claim. Where the source has no tax at
-- all, or is not a purchase this view covers, the share is 1 and the old
-- behaviour stands.
--
-- Read live from `tax_rates`, like the purchase side above it, so the register
-- and the return keep agreeing with each other. That does mean changing a
-- rate's credit restates what earlier periods could have claimed; a rate is
-- master data, and the alternative -- copying the flag onto every line -- would
-- let the two drift apart instead.

DROP VIEW v_input_tax;

CREATE VIEW v_input_tax AS
SELECT p.org_id, p.txn_date, p.business_type, 'dealer_purchases' AS document_type,
       p.id AS document_id, p.txn_no, 'COMPANY'::party_type AS party_type,
       p.company_id AS party_id,
       p.net_amount AS taxable_value,
       p.tax_amount,
       COALESCE((
         SELECT SUM(i.tax_amount)
           FROM dealer_purchase_items i
           JOIN tax_rates t ON t.id = i.tax_rate_id
          WHERE i.purchase_id = p.id AND t.is_reclaimable
       ), 0) AS reclaimable_tax
  FROM dealer_purchases p WHERE p.status = 'POSTED'
UNION ALL
SELECT p.org_id, p.txn_date, p.business_type, 'crop_purchases', p.id, p.txn_no,
       'SUPPLIER'::party_type, p.supplier_id, p.net_amount, p.tax_amount,
       COALESCE((
         SELECT SUM(i.tax_amount)
           FROM crop_purchase_items i
           JOIN tax_rates t ON t.id = i.tax_rate_id
          WHERE i.purchase_id = p.id AND t.is_reclaimable
       ), 0)
  FROM crop_purchases p WHERE p.status = 'POSTED'
UNION ALL
-- A purchase return gives back the goods and, with them, whatever rebate the
-- original bill was actually allowed. The rate on the return line is the rate
-- that bill paid, so the question is only how much of that rate carried a
-- credit.
SELECT r.org_id, r.txn_date, r.business_type, 'returns', r.id, r.txn_no,
       r.party_type, r.party_id, -r.net_amount, -r.tax_amount,
       -ROUND(r.tax_amount * COALESCE(
         (SELECT COALESCE(SUM(i.tax_amount) FILTER (WHERE t.is_reclaimable), 0)
                 / NULLIF(SUM(i.tax_amount), 0)
            FROM dealer_purchase_items i
            JOIN tax_rates t ON t.id = i.tax_rate_id
           WHERE r.source_type = 'dealer_purchases' AND i.purchase_id = r.source_id),
         (SELECT COALESCE(SUM(i.tax_amount) FILTER (WHERE t.is_reclaimable), 0)
                 / NULLIF(SUM(i.tax_amount), 0)
            FROM crop_purchase_items i
            JOIN tax_rates t ON t.id = i.tax_rate_id
           WHERE r.source_type = 'crop_purchases' AND i.purchase_id = r.source_id),
         1), 2)
  FROM returns r
 WHERE r.status = 'POSTED'
   AND r.source_type IN ('dealer_purchases', 'crop_purchases');

COMMENT ON VIEW v_input_tax IS
  'Tax paid on posted purchases, less tax given back on purchase returns. '
  '`tax_amount` is what was paid, for the purchase register; '
  '`reclaimable_tax` is what may be claimed, for the return -- and on a '
  'return line, only the share of it the original purchase was allowed.';
