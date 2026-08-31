-- 026_reclaimable_input_tax.sql — claim back only what can be claimed back.
--
-- `v_input_tax` sums the tax on the header of every posted purchase, which is
-- the right figure for a purchase register: a Mushak 6.1 lists what was paid.
-- It is the wrong figure for the rebate, because tax at a non-reclaimable rate
-- is not a rebate at all -- it is part of what the goods cost, and the posting
-- path already lands it on the inventory rather than in the input VAT account.
--
-- Left as it was, a VAT return would claim it: the report and the trial
-- balance would disagree by exactly the tax the NBR will not repay, and the
-- one the business filed would be the optimistic one.
--
-- The view now carries both. `tax_amount` is what was paid and belongs on the
-- register; `reclaimable_tax` is what may be claimed and is what the return
-- adds up.

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
-- A purchase return gives back the goods and the rebate with them. The rate on
-- the return line is the rate the original purchase paid, so what is given
-- back is whatever was claimed.
SELECT r.org_id, r.txn_date, r.business_type, 'returns', r.id, r.txn_no,
       r.party_type, r.party_id, -r.net_amount, -r.tax_amount, -r.tax_amount
  FROM returns r
 WHERE r.status = 'POSTED'
   AND r.source_type IN ('dealer_purchases', 'crop_purchases');

COMMENT ON VIEW v_input_tax IS
  'Tax paid on posted purchases, less tax given back on purchase returns. '
  '`tax_amount` is what was paid, for the purchase register; '
  '`reclaimable_tax` is what may be claimed, for the return.';
