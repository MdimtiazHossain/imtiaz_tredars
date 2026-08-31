-- 015_settings.sql — the Settings screen stops being a picture.
--
-- Every panel on that screen described something the business genuinely
-- configures -- the company on its own invoices, the financial year, document
-- numbering, unit conversion, approval limits, the valuation method and the
-- notification rules -- and all of it was hard-coded in the frontend. The
-- tables behind most of it already existed (organizations, fiscal_years, units,
-- approval_rules, document_sequences); they were simply never read or written.
--
-- This migration adds the three things that were actually missing: somewhere to
-- keep the valuation method, a table for the notification rules, and the unit
-- relationships that the conversion list was only asserting in prose.

-- ------------------------------------------------------- inventory valuation

-- The valuation method was a pair of buttons that changed a value in browser
-- memory: reloading the page put it back, and the server went on defaulting to
-- FIFO regardless of what the screen showed. It belongs with the organisation,
-- next to the currency and the financial year.
ALTER TABLE organizations
  ADD COLUMN valuation_method text NOT NULL DEFAULT 'FIFO'
    CHECK (valuation_method IN ('FIFO', 'WEIGHTED_AVERAGE'));

COMMENT ON COLUMN organizations.valuation_method IS
  'Default costing for crop sales and dealer stock; a sale may still override it.';

-- ------------------------------------------------------- notification rules

-- Rules are data for the same reason approval rules are: switching off the
-- overdue reminder, or moving the large-transaction alert from 20 lakh to 30,
-- is an afternoon decision and must not need a deployment.
CREATE TABLE notification_rules (
  id          bigserial PRIMARY KEY,
  org_id      bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code        text        NOT NULL,
  name        text        NOT NULL,
  description text,
  -- The amount or day count the rule fires on, where it has one. An overdue
  -- reminder has no threshold; a large-transaction alert is nothing without it.
  threshold   numeric(18,2),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TRIGGER notification_rules_touch BEFORE UPDATE ON notification_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The six rules the screen has always listed, now as rows. Inserted for every
-- organisation that already exists so an installed database gains them without
-- a reseed; the seed script inserts the same set for a fresh one.
INSERT INTO notification_rules (org_id, code, name, description, threshold)
SELECT o.id, r.code, r.name, r.description, r.threshold
  FROM organizations o
  CROSS JOIN (VALUES
    ('CUSTOMER_OVERDUE', 'Customer payment overdue',
     'daily 9:00 am for invoices past due date', NULL::numeric),
    ('SUPPLIER_DUE', 'Supplier payment due',
     'days before the due date', 2),
    ('LOW_STOCK', 'Low stock',
     'when quantity falls below minimum stock', NULL),
    ('DEAD_STOCK', 'Dead stock',
     'crop batch older than this many days', 60),
    ('LARGE_TRANSACTION', 'Large transaction',
     'any single transaction above this amount', 2000000),
    ('EXPENSE_THRESHOLD', 'Expense threshold',
     'expense above this amount', 50000)
  ) AS r(code, name, description, threshold)
ON CONFLICT (org_id, code) DO NOTHING;

-- --------------------------------------------------------- document numbers

-- The numbering panel listed eight patterns -- PC-YYMM-###, SC-YYMM-### and so
-- on -- as read-only text, while the prefixes themselves lived in a constant in
-- the API. A business that wants its crop purchases numbered CP rather than PC
-- had no way to say so.
--
-- The counter stays in `document_sequences`, which is per period and must not
-- be edited by hand; the format is separate because it is the part an operator
-- decides. Changing a prefix affects documents numbered from then on and leaves
-- everything already issued alone.
CREATE TABLE document_number_formats (
  id         bigserial PRIMARY KEY,
  org_id     bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doc_type   text        NOT NULL,
  prefix     text        NOT NULL,
  padding    integer     NOT NULL DEFAULT 3,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, doc_type),
  CHECK (prefix ~ '^[A-Z][A-Z0-9]{0,5}$'),
  CHECK (padding BETWEEN 1 AND 10)
);

CREATE TRIGGER document_number_formats_touch BEFORE UPDATE ON document_number_formats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The defaults the API has always used, so an existing database keeps numbering
-- documents exactly as it did before this migration ran.
INSERT INTO document_number_formats (org_id, doc_type, prefix, padding)
SELECT o.id, d.doc_type, d.prefix, d.padding
  FROM organizations o
  CROSS JOIN (VALUES
    ('crop_purchase',   'PC',  3),
    ('crop_sale',       'SC',  3),
    ('dealer_purchase', 'DP',  3),
    ('dealer_sale',     'DS',  3),
    ('crop_batch',      'BC',  3),
    ('receipt',         'RC',  3),
    ('payment',         'PY',  3),
    ('expense',         'EXP', 3),
    ('adjustment',      'ADJ', 3),
    ('transfer',        'TRF', 3),
    ('movement',        'MOV', 3),
    ('approval',        'AP',  4)
  ) AS d(doc_type, prefix, padding)
ON CONFLICT (org_id, doc_type) DO NOTHING;

-- ---------------------------------------------------------- unit conversion

-- `factor` was populated but `base_unit_id` never was, so the conversions the
-- Settings screen printed ("1 MT = 1,000 kg") were a sentence in the frontend
-- rather than something the row could state. Pointing the crop units at MT lets
-- the conversion be derived from the two columns that describe it.
UPDATE units
   SET base_unit_id = (SELECT id FROM units WHERE code = 'MT')
 WHERE code IN ('Maund', 'Kg', 'Bag')
   AND base_unit_id IS NULL
   AND EXISTS (SELECT 1 FROM units WHERE code = 'MT');

-- ------------------------------------------------------- closed year locking

-- The financial year panel says, and has always said, that "closing a year
-- locks its transactions". Nothing enforced it: a year could be marked closed
-- and a purchase still be posted into it the next morning, which is the one
-- thing a close is for.
--
-- Enforced in the database rather than in each service, because there are eight
-- tables that carry a transaction date and a rule spread over eight services is
-- a rule with seven places to forget it.
CREATE OR REPLACE FUNCTION guard_closed_fiscal_year() RETURNS trigger AS $$
DECLARE
  v_year text;
BEGIN
  SELECT code INTO v_year
    FROM fiscal_years
   WHERE org_id = NEW.org_id
     AND is_closed
     AND NEW.txn_date BETWEEN starts_on AND ends_on;

  IF v_year IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('%s is closed. Reopen it before dating a document %s.',
                       v_year, to_char(NEW.txn_date, 'DD Mon YYYY'));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crop_purchases_period_open BEFORE INSERT OR UPDATE OF txn_date
  ON crop_purchases FOR EACH ROW EXECUTE FUNCTION guard_closed_fiscal_year();
CREATE TRIGGER crop_sales_period_open BEFORE INSERT OR UPDATE OF txn_date
  ON crop_sales FOR EACH ROW EXECUTE FUNCTION guard_closed_fiscal_year();
CREATE TRIGGER dealer_purchases_period_open BEFORE INSERT OR UPDATE OF txn_date
  ON dealer_purchases FOR EACH ROW EXECUTE FUNCTION guard_closed_fiscal_year();
CREATE TRIGGER dealer_sales_period_open BEFORE INSERT OR UPDATE OF txn_date
  ON dealer_sales FOR EACH ROW EXECUTE FUNCTION guard_closed_fiscal_year();
CREATE TRIGGER payments_period_open BEFORE INSERT OR UPDATE OF txn_date
  ON payments FOR EACH ROW EXECUTE FUNCTION guard_closed_fiscal_year();
CREATE TRIGGER expenses_period_open BEFORE INSERT OR UPDATE OF txn_date
  ON expenses FOR EACH ROW EXECUTE FUNCTION guard_closed_fiscal_year();
CREATE TRIGGER stock_adjustments_period_open BEFORE INSERT OR UPDATE OF txn_date
  ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION guard_closed_fiscal_year();
CREATE TRIGGER stock_transfers_period_open BEFORE INSERT OR UPDATE OF txn_date
  ON stock_transfers FOR EACH ROW EXECUTE FUNCTION guard_closed_fiscal_year();

-- ---------------------------------------------------------- unit maintenance

-- Adding a unit is settings work, but it is master data in shape, so it gets
-- the same create/edit/retire permissions every other master carries.
INSERT INTO permissions (code, description) VALUES
  ('unit.create', 'Create units of measure'),
  ('unit.edit',   'Edit and restore units of measure'),
  ('unit.delete', 'Retire units of measure')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Admin'
ON CONFLICT DO NOTHING;
