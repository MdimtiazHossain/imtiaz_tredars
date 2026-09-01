-- 031_input_tax_apportionment.sql — claim input tax in the proportion it earns.
--
-- Until now a rate decided whether the tax paid on it could be claimed. That
-- is only half the test. The other half is what the input was used *for*: a
-- credit is earned by making supplies that sit inside the VAT chain, and a
-- business making both kinds may claim only the share its creditable supplies
-- represent. Buy fertiliser at 15%, sell half of it as exempt produce, and
-- half of that 15% was never yours to claim.
--
-- This business makes both kinds today -- dealer goods at the standard rate,
-- crop supplies exempt -- so the share is not hypothetical. It has simply been
-- claiming all of it.
--
-- The statutory basis is turnover: creditable supplies over all supplies, for
-- the period being filed. Value, not tax, because an exempt supply charges no
-- tax and would otherwise weigh nothing in a ratio built on tax.
--
-- Whether a supply carries a credit is the same question `is_reclaimable`
-- already answers on the buying side, and deliberately the same column. A rate
-- either sits inside the chain or outside it: standard and zero-rated are in,
-- which is the whole point of zero-rating an export rather than exempting it;
-- exempt and the truncated rates are out.

/* ------------------------------------------- what share of supply earns credit */

DROP VIEW v_output_tax;

CREATE VIEW v_output_tax AS
SELECT s.org_id, s.txn_date, s.business_type, 'dealer_sales' AS document_type,
       s.id AS document_id, s.txn_no, 'CUSTOMER'::party_type AS party_type,
       s.customer_id AS party_id,
       s.net_amount AS taxable_value, s.tax_amount,
       -- The header's value apportioned by the mix of rates on its lines, so a
       -- part-exempt invoice counts for the part that earns a credit. A line
       -- with no rate at all predates registration; it is left creditable
       -- rather than counted against a business that was not yet in the chain.
       ROUND(s.net_amount * COALESCE((
         SELECT COALESCE(SUM(i.line_net) FILTER (WHERE t.is_reclaimable), 0)
                / NULLIF(SUM(i.line_net), 0)
           FROM dealer_sale_items i
           JOIN tax_rates t ON t.id = i.tax_rate_id
          WHERE i.sale_id = s.id
       ), 1), 2) AS creditable_value
  FROM dealer_sales s WHERE s.status = 'POSTED'
UNION ALL
SELECT s.org_id, s.txn_date, s.business_type, 'crop_sales', s.id, s.txn_no,
       'COMPANY'::party_type, s.buyer_company_id, s.net_amount, s.tax_amount,
       ROUND(s.net_amount * COALESCE((
         SELECT COALESCE(SUM(i.line_value) FILTER (WHERE t.is_reclaimable), 0)
                / NULLIF(SUM(i.line_value), 0)
           FROM crop_sale_items i
           JOIN tax_rates t ON t.id = i.tax_rate_id
          WHERE i.sale_id = s.id
       ), 1), 2)
  FROM crop_sales s WHERE s.status = 'POSTED'
UNION ALL
-- A sale returned is a supply unmade, and it comes out of the ratio on the
-- same footing it went in on.
SELECT r.org_id, r.txn_date, r.business_type, 'returns', r.id, r.txn_no,
       r.party_type, r.party_id, -r.net_amount, -r.tax_amount,
       -ROUND(r.net_amount * COALESCE(
         (SELECT COALESCE(SUM(i.line_net) FILTER (WHERE t.is_reclaimable), 0)
                 / NULLIF(SUM(i.line_net), 0)
            FROM dealer_sale_items i
            JOIN tax_rates t ON t.id = i.tax_rate_id
           WHERE r.source_type = 'dealer_sales' AND i.sale_id = r.source_id),
         (SELECT COALESCE(SUM(i.line_value) FILTER (WHERE t.is_reclaimable), 0)
                 / NULLIF(SUM(i.line_value), 0)
            FROM crop_sale_items i
            JOIN tax_rates t ON t.id = i.tax_rate_id
           WHERE r.source_type = 'crop_sales' AND i.sale_id = r.source_id),
         1), 2)
  FROM returns r
 WHERE r.status = 'POSTED' AND r.source_type IN ('dealer_sales', 'crop_sales');

COMMENT ON VIEW v_output_tax IS
  'Tax charged on posted sales, less tax credited back on sale returns. '
  '`creditable_value` is the part of each supply made inside the VAT chain, '
  'which is what apportions the input tax that may be claimed against it.';

/* --------------------------------------------- where the disallowed part goes */

INSERT INTO chart_of_accounts (org_id, code, name, account_class, is_group, is_system)
SELECT o.id, '5400', 'Irrecoverable input VAT', 'EXPENSE', false, true
  FROM organizations o
ON CONFLICT (org_id, code) DO NOTHING;

UPDATE chart_of_accounts child
   SET parent_id = parent.id
  FROM chart_of_accounts parent
 WHERE parent.org_id = child.org_id
   AND parent.is_group
   AND parent.code = '5000'
   AND child.code = '5400'
   AND child.parent_id IS NULL;

/* ------------------------------------------------- what was worked out, and when */

-- The ratio is a property of a period rather than of a document, so the
-- adjustment it produces is recorded once for that period and not again. The
-- unique key is what makes filing twice a no-op instead of a second journal.
CREATE TABLE tax_apportionments (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_from         date        NOT NULL,
  period_to           date        NOT NULL,
  creditable_supplies numeric(18,2) NOT NULL,
  total_supplies      numeric(18,2) NOT NULL,
  credit_ratio        numeric(9,6)  NOT NULL,
  input_tax           numeric(18,2) NOT NULL,
  claimable           numeric(18,2) NOT NULL,
  disallowed          numeric(18,2) NOT NULL,
  posted_by           bigint      NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period_from, period_to),
  CHECK (period_to >= period_from),
  CHECK (credit_ratio >= 0 AND credit_ratio <= 1)
);

CREATE INDEX tax_apportionments_period_idx
  ON tax_apportionments (org_id, period_from, period_to);

COMMENT ON TABLE tax_apportionments IS
  'One row per period whose input tax has been apportioned and journalled. '
  'Its presence is what stops the same period being adjusted twice.';
