-- 025_vat_and_tax.sql — VAT, as the NBR expects it to be accounted for.
--
-- Every document in this system has priced goods and stopped. A dealer invoice
-- for fifty bags of pesticide records what the bags are worth and nothing
-- about the 15% the business is obliged to collect on top, so the invoice
-- total was wrong, the receivable was wrong, and there was nothing to file a
-- Mushak 9.1 from at the end of the month.
--
-- Three things follow from that, and this migration is all three:
--
--   1. A rate is master data. Bangladesh has a standard rate, truncated rates
--      for particular sectors, zero-rating and exemption, and the standard
--      rate itself moves at a budget. A number written into a service is a
--      number that is wrong the morning after it changes.
--   2. A document stores the rate it used. The master says what today's rate
--      is; the line says what this invoice charged. Changing a rate must never
--      rewrite an invoice raised last year.
--   3. VAT is not revenue and it is not cost. It is collected on the
--      government's behalf and it goes to its own accounts -- output VAT owed,
--      input VAT reclaimable -- so the profit and loss is unaffected by it and
--      the balance sheet says exactly what is owed to the NBR.
--
-- Deliberately not modelled, because this business does not do them and
-- guessing at them would be worse than leaving them out: input-tax
-- apportionment between taxable and exempt supplies, VAT deducted at source,
-- and supplementary duty. A rate can be marked non-reclaimable, which is the
-- one part of apportionment that a trading business actually meets.

-- What kind of supply a rate describes. The rate alone cannot say: zero-rated
-- and exempt are both 0%, but zero-rated inputs are reclaimable and exempt
-- ones are not, which is the whole difference between them.
CREATE TYPE tax_kind AS ENUM ('STANDARD', 'REDUCED', 'ZERO', 'EXEMPT');

CREATE TABLE tax_rates (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  code           text        NOT NULL,
  name           text        NOT NULL,
  name_bn        text,
  kind           tax_kind    NOT NULL,
  -- Percent, e.g. 15.0000. Four decimals because truncated rates are written
  -- as 7.5 and 2.4 and one of them will eventually be 1.5.
  rate           numeric(9,4) NOT NULL DEFAULT 0,
  -- Whether VAT paid on a purchase at this rate can be claimed back. False
  -- means it belongs in the cost of the goods instead.
  is_reclaimable boolean     NOT NULL DEFAULT true,
  -- What a line falls back to when neither the product nor the crop names one.
  is_default     boolean     NOT NULL DEFAULT false,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (rate >= 0 AND rate <= 100),
  -- Zero-rated and exempt supplies carry no rate; anything else must.
  CHECK ((kind IN ('ZERO', 'EXEMPT') AND rate = 0) OR (kind IN ('STANDARD', 'REDUCED'))),
  -- An exempt supply's input tax is never reclaimable; saying otherwise would
  -- let the books claim back tax the NBR will not repay.
  CHECK (kind <> 'EXEMPT' OR NOT is_reclaimable)
);

-- One default, so a line that names no rate has exactly one answer.
CREATE UNIQUE INDEX tax_rates_one_default ON tax_rates (org_id) WHERE is_default;

CREATE TRIGGER tax_rates_touch BEFORE UPDATE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* ------------------------------------------------------- what a rate is for */

-- A product and a crop each carry the rate their supply attracts. Null means
-- the organisation's default, which is how a catalogue of a thousand products
-- at the standard rate is maintained by setting one row.
ALTER TABLE products ADD COLUMN tax_rate_id bigint REFERENCES tax_rates(id);
ALTER TABLE crops    ADD COLUMN tax_rate_id bigint REFERENCES tax_rates(id);

/* -------------------------------------------------------------- registration */

-- The business's own registration. Unregistered, nothing is charged and
-- nothing is reclaimed, and every document behaves exactly as it did before
-- this migration ran.
ALTER TABLE organizations
  ADD COLUMN is_vat_registered boolean NOT NULL DEFAULT false,
  -- Prices as the business quotes them. In Bangladeshi retail a rate is
  -- usually the price the customer pays, VAT inside it; between businesses it
  -- is usually the price before VAT. Both are ordinary, so the default is
  -- configuration rather than an assumption.
  ADD COLUMN prices_include_tax boolean NOT NULL DEFAULT false;

-- A party's BIN goes on the challanpatra, and whether they are registered
-- decides whether they can claim what we charge them.
ALTER TABLE customers ADD COLUMN bin_no text, ADD COLUMN is_vat_registered boolean NOT NULL DEFAULT false;
ALTER TABLE suppliers ADD COLUMN bin_no text, ADD COLUMN is_vat_registered boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN bin_no text, ADD COLUMN is_vat_registered boolean NOT NULL DEFAULT false;

/* ---------------------------------------------------------------- documents */

-- `net_amount` keeps its meaning: the value of the goods, which is what the
-- revenue account is credited with and what VAT is charged on. `tax_amount` is
-- collected for the NBR and `total_amount` is what the party actually owes.
-- Defaulting the tax to zero means every document raised before today still
-- totals exactly what it always did.
ALTER TABLE dealer_sales
  ADD COLUMN tax_amount    numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN total_amount  numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_inclusive boolean       NOT NULL DEFAULT false;
ALTER TABLE dealer_purchases
  ADD COLUMN tax_amount    numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN total_amount  numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_inclusive boolean       NOT NULL DEFAULT false;
ALTER TABLE crop_sales
  ADD COLUMN tax_amount    numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN total_amount  numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_inclusive boolean       NOT NULL DEFAULT false;
ALTER TABLE crop_purchases
  ADD COLUMN tax_amount    numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN total_amount  numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_inclusive boolean       NOT NULL DEFAULT false;
ALTER TABLE returns
  ADD COLUMN tax_amount    numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN total_amount  numeric(18,2) NOT NULL DEFAULT 0;

-- Every document that existed before VAT owed exactly its goods value. A
-- posted document is frozen by trigger and rightly so; this is the migration
-- filling in a column that did not exist when it was posted, not a change to
-- what it says, so the guard stands down for exactly these statements.
ALTER TABLE dealer_sales     DISABLE TRIGGER dealer_sales_immutable;
ALTER TABLE dealer_purchases DISABLE TRIGGER dealer_purchases_immutable;
ALTER TABLE crop_sales       DISABLE TRIGGER crop_sales_immutable;
ALTER TABLE crop_purchases   DISABLE TRIGGER crop_purchases_immutable;
ALTER TABLE returns          DISABLE TRIGGER returns_posted_guard;

UPDATE dealer_sales     SET total_amount = net_amount WHERE total_amount = 0;
UPDATE dealer_purchases SET total_amount = net_amount WHERE total_amount = 0;
UPDATE crop_sales       SET total_amount = net_amount WHERE total_amount = 0;
UPDATE crop_purchases   SET total_amount = net_amount WHERE total_amount = 0;
UPDATE returns          SET total_amount = net_amount WHERE total_amount = 0;

ALTER TABLE dealer_sales     ENABLE TRIGGER dealer_sales_immutable;
ALTER TABLE dealer_purchases ENABLE TRIGGER dealer_purchases_immutable;
ALTER TABLE crop_sales       ENABLE TRIGGER crop_sales_immutable;
ALTER TABLE crop_purchases   ENABLE TRIGGER crop_purchases_immutable;
ALTER TABLE returns          ENABLE TRIGGER returns_posted_guard;

-- The rate is stored beside its id: the id says which rate was chosen, the
-- number says what was actually charged. A budget that moves the standard rate
-- to 12% must not restate every invoice ever raised at 15%.
ALTER TABLE dealer_sale_items
  ADD COLUMN tax_rate_id bigint REFERENCES tax_rates(id),
  ADD COLUMN tax_rate    numeric(9,4)  NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount  numeric(18,2) NOT NULL DEFAULT 0;
ALTER TABLE dealer_purchase_items
  ADD COLUMN tax_rate_id bigint REFERENCES tax_rates(id),
  ADD COLUMN tax_rate    numeric(9,4)  NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount  numeric(18,2) NOT NULL DEFAULT 0;
ALTER TABLE crop_sale_items
  ADD COLUMN tax_rate_id bigint REFERENCES tax_rates(id),
  ADD COLUMN tax_rate    numeric(9,4)  NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount  numeric(18,2) NOT NULL DEFAULT 0;
ALTER TABLE crop_purchase_items
  ADD COLUMN tax_rate_id bigint REFERENCES tax_rates(id),
  ADD COLUMN tax_rate    numeric(9,4)  NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount  numeric(18,2) NOT NULL DEFAULT 0;
ALTER TABLE return_items
  ADD COLUMN tax_rate    numeric(9,4)  NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount  numeric(18,2) NOT NULL DEFAULT 0;

/* ------------------------------------------------------------------ accounts */

-- VAT belongs to the NBR from the moment it is charged. Putting it through
-- income or cost of sales would inflate both and leave the balance sheet
-- silent about a real liability.
INSERT INTO chart_of_accounts (org_id, code, name, account_class, is_group, is_system)
SELECT o.id, v.code, v.name, v.klass::account_class, false, true
  FROM organizations o
  CROSS JOIN (VALUES
    ('1400', 'Input VAT receivable', 'ASSET'),
    ('2200', 'Output VAT payable',   'LIABILITY')
  ) AS v(code, name, klass)
ON CONFLICT (org_id, code) DO NOTHING;

UPDATE chart_of_accounts child
   SET parent_id = parent.id
  FROM chart_of_accounts parent
 WHERE parent.org_id = child.org_id
   AND parent.is_group
   AND parent.code = left(child.code, 1) || '000'
   AND child.code IN ('1400', '2200')
   AND child.parent_id IS NULL;

/* -------------------------------------------------------------- the rates */

-- Bangladesh's own rates, so a business can raise a taxable invoice the
-- moment it registers rather than having to describe its tax system first.
-- These are ordinary master data: rename them, change them, add the truncated
-- rate a particular trade uses.
INSERT INTO tax_rates (org_id, code, name, name_bn, kind, rate, is_reclaimable, is_default)
SELECT o.id, t.code, t.name, t.name_bn, t.kind::tax_kind, t.rate, t.reclaimable, t.is_default
  FROM organizations o
  CROSS JOIN (VALUES
    ('VAT15',  'VAT 15%',            'মূসক ১৫%',      'STANDARD', 15.0, true,  true),
    ('VAT10',  'VAT 10% truncated',  'মূসক ১০%',      'REDUCED',  10.0, true,  false),
    ('VAT7.5', 'VAT 7.5% truncated', 'মূসক ৭.৫%',     'REDUCED',   7.5, true,  false),
    ('VAT5',   'VAT 5% truncated',   'মূসক ৫%',       'REDUCED',   5.0, true,  false),
    ('ZERO',   'Zero-rated',         'শূন্য হার',      'ZERO',      0.0, true,  false),
    ('EXEMPT', 'Exempt',             'অব্যাহতিপ্রাপ্ত', 'EXEMPT',    0.0, false, false)
  ) AS t(code, name, name_bn, kind, rate, reclaimable, is_default)
ON CONFLICT (org_id, code) DO NOTHING;

-- Unprocessed agricultural produce is exempt, which is the whole bulk crop
-- side of this business. Saying so in the data means a crop sale charges
-- nothing without any service having to know what a crop is.
UPDATE crops SET tax_rate_id = (
  SELECT t.id FROM tax_rates t WHERE t.org_id = crops.org_id AND t.code = 'EXEMPT'
) WHERE tax_rate_id IS NULL;

/* ------------------------------------------------------------- permissions */

INSERT INTO permissions (code, description) VALUES
  ('tax.view',   'View tax rates and VAT reports'),
  ('tax.create', 'Create tax rates'),
  ('tax.edit',   'Edit tax rates'),
  ('tax.delete', 'Retire tax rates')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'Admin' AND p.code IN ('tax.view', 'tax.create', 'tax.edit', 'tax.delete')
ON CONFLICT DO NOTHING;

-- Accounts files the return, so Accounts maintains the rates. Everyone who
-- raises a document needs to see them, because the rate is on every line.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE (r.code = 'Accounts' AND p.code IN ('tax.view', 'tax.create', 'tax.edit'))
    OR (r.code IN ('Management', 'Sales', 'Purchase') AND p.code = 'tax.view')
ON CONFLICT DO NOTHING;

/* ------------------------------------------------------------------- views */

-- Output tax by document, which is the sales register a Mushak 6.2 is written
-- from. A return carries negative tax so the month nets off without the reader
-- having to subtract a second list from the first.
CREATE VIEW v_output_tax AS
SELECT s.org_id, s.txn_date, s.business_type, 'dealer_sales' AS document_type,
       s.id AS document_id, s.txn_no, 'CUSTOMER'::party_type AS party_type, s.customer_id AS party_id,
       s.net_amount AS taxable_value, s.tax_amount
  FROM dealer_sales s WHERE s.status = 'POSTED'
UNION ALL
SELECT s.org_id, s.txn_date, s.business_type, 'crop_sales', s.id, s.txn_no,
       'COMPANY'::party_type, s.buyer_company_id, s.net_amount, s.tax_amount
  FROM crop_sales s WHERE s.status = 'POSTED'
UNION ALL
SELECT r.org_id, r.txn_date, r.business_type, 'returns', r.id, r.txn_no,
       r.party_type, r.party_id, -r.net_amount, -r.tax_amount
  FROM returns r
 WHERE r.status = 'POSTED' AND r.source_type IN ('dealer_sales', 'crop_sales');

COMMENT ON VIEW v_output_tax IS
  'Tax charged on posted sales, less tax credited back on sale returns. The '
  'sales side of a VAT return.';

CREATE VIEW v_input_tax AS
SELECT p.org_id, p.txn_date, p.business_type, 'dealer_purchases' AS document_type,
       p.id AS document_id, p.txn_no, 'COMPANY'::party_type AS party_type, p.company_id AS party_id,
       p.net_amount AS taxable_value, p.tax_amount
  FROM dealer_purchases p WHERE p.status = 'POSTED'
UNION ALL
SELECT p.org_id, p.txn_date, p.business_type, 'crop_purchases', p.id, p.txn_no,
       'SUPPLIER'::party_type, p.supplier_id, p.net_amount, p.tax_amount
  FROM crop_purchases p WHERE p.status = 'POSTED'
UNION ALL
SELECT r.org_id, r.txn_date, r.business_type, 'returns', r.id, r.txn_no,
       r.party_type, r.party_id, -r.net_amount, -r.tax_amount
  FROM returns r
 WHERE r.status = 'POSTED' AND r.source_type IN ('dealer_purchases', 'crop_purchases');

COMMENT ON VIEW v_input_tax IS
  'Tax paid on posted purchases, less tax given back on purchase returns. The '
  'rebate side of a VAT return.';
