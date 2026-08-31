-- 020_chart_of_accounts.sql — give every journal entry an account to belong to.
--
-- `ledger_entries` has been a genuine double-entry journal from the start:
-- balanced pairs, a constraint refusing an entry that is both a debit and a
-- credit, and six services posting to it. What it has never had is anywhere to
-- classify an entry to. `accounts` models cash, bank and mobile money and
-- nothing else, so there is no income, expense, asset, liability or equity for
-- an entry to land in.
--
-- The consequence is exact: the system can produce a cash book and a party
-- ledger, and cannot produce a trial balance, a balance sheet, or a profit and
-- loss derived from the books. That is why the P&L on the Accounts screen is
-- still a hard-coded fixture -- there was nothing to compute it from.
--
-- This adds the classification layer over the journal that already exists. It
-- does not change how anything posts; it records what each posting means.

-- ------------------------------------------------------------------- classes

-- The five statement classes. Assets and expenses are debit-natured, the rest
-- credit-natured, which is what lets a trial balance be summed without a rule
-- per account.
CREATE TYPE account_class AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

CREATE TABLE chart_of_accounts (
  id            bigserial PRIMARY KEY,
  org_id        bigint        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code          text          NOT NULL,
  name          text          NOT NULL,
  account_class account_class NOT NULL,
  parent_id     bigint        REFERENCES chart_of_accounts(id),
  -- A heading groups its children and is never posted to directly, the way
  -- "Assets" is a total rather than somewhere money sits.
  is_group      boolean       NOT NULL DEFAULT false,
  -- The accounts the posting services resolve by name. Deleting one would
  -- leave a posting path with nowhere to write, so they cannot be removed.
  is_system     boolean       NOT NULL DEFAULT false,
  is_active     boolean       NOT NULL DEFAULT true,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX chart_of_accounts_org ON chart_of_accounts (org_id, account_class);

CREATE TRIGGER chart_of_accounts_touch BEFORE UPDATE ON chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A posting must land on a real account rather than on a heading.
CREATE OR REPLACE FUNCTION guard_postable_account() RETURNS trigger AS $$
BEGIN
  IF NEW.coa_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM chart_of_accounts WHERE id = NEW.coa_id AND is_group)
  THEN
    RAISE EXCEPTION 'LEDGER_ACCOUNT_IS_A_GROUP'
      USING ERRCODE = 'check_violation',
            DETAIL = 'That account is a heading. Post to one of the accounts under it.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------ standard chart

-- A trading business's chart, kept to what this system actually posts. Every
-- code here is resolved by name in the posting services, so the set is the
-- contract between the schema and those services rather than a suggestion.
INSERT INTO chart_of_accounts (org_id, code, name, account_class, is_group, is_system)
SELECT o.id, c.code, c.name, c.klass::account_class, c.grp, true
  FROM organizations o
  CROSS JOIN (VALUES
    ('1000', 'Assets',                    'ASSET',     true ),
    ('1100', 'Cash and bank',             'ASSET',     false),
    ('1200', 'Accounts receivable',       'ASSET',     false),
    ('1300', 'Inventory',                 'ASSET',     false),
    ('2000', 'Liabilities',               'LIABILITY', true ),
    ('2100', 'Accounts payable',          'LIABILITY', false),
    ('3000', 'Equity',                    'EQUITY',    true ),
    ('3100', 'Opening balance equity',    'EQUITY',    false),
    ('3200', 'Retained earnings',         'EQUITY',    false),
    ('4000', 'Income',                    'INCOME',    true ),
    ('4100', 'Dealer sales',              'INCOME',    false),
    ('4200', 'Crop sales',                'INCOME',    false),
    ('5000', 'Expenses',                  'EXPENSE',   true ),
    ('5100', 'Cost of goods sold',        'EXPENSE',   false),
    ('5200', 'Operating expenses',        'EXPENSE',   false)
  ) AS c(code, name, klass, grp)
ON CONFLICT (org_id, code) DO NOTHING;

-- Hang each account under its heading, so a statement can be grouped without
-- the grouping being hard-coded in a report.
UPDATE chart_of_accounts child
   SET parent_id = parent.id
  FROM chart_of_accounts parent
 WHERE parent.org_id = child.org_id
   AND parent.is_group
   AND parent.code = left(child.code, 1) || '000'
   AND child.code <> parent.code
   AND child.parent_id IS NULL;

-- ------------------------------------------------------------------- linkage

-- A cash, bank or MFS account is a sub-ledger of "Cash and bank" unless the
-- business points it somewhere more specific.
ALTER TABLE accounts ADD COLUMN coa_id bigint REFERENCES chart_of_accounts(id);

UPDATE accounts a
   SET coa_id = c.id
  FROM chart_of_accounts c
 WHERE c.org_id = a.org_id AND c.code = '1100' AND a.coa_id IS NULL;

-- An expense category says which expense account its vouchers land in.
-- Nullable: a category added before anyone chose an account still posts, to
-- Operating expenses, rather than refusing the voucher.
ALTER TABLE expense_categories ADD COLUMN coa_id bigint REFERENCES chart_of_accounts(id);

-- --------------------------------------------------------- classify the journal

ALTER TABLE ledger_entries ADD COLUMN coa_id bigint REFERENCES chart_of_accounts(id);

CREATE TRIGGER ledger_entries_postable BEFORE INSERT OR UPDATE OF coa_id
  ON ledger_entries FOR EACH ROW EXECUTE FUNCTION guard_postable_account();

-- The journal refuses UPDATE by trigger, which is exactly right and is also
-- what stops a classification being added to entries already written. The
-- guard is lifted for this statement alone, inside the migration's own
-- transaction, and restored before anything else can run.
ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update;

-- Backfill what is already on the books. Each posting path writes a known,
-- balanced pair, so what an existing entry meant is decidable from the
-- document it references and the side it sits on.
WITH coa AS (
  SELECT org_id, code, id FROM chart_of_accounts
)
UPDATE ledger_entries l
   SET coa_id = c.id
  FROM coa c
 WHERE c.org_id = l.org_id
   AND l.coa_id IS NULL
   AND c.code = CASE
     -- Buying: goods in against a payable to the seller.
     WHEN l.reference_type IN ('crop_purchases', 'dealer_purchases')
       THEN CASE WHEN l.debit > 0 THEN '1300' ELSE '2100' END
     -- Selling: a receivable from the buyer against income.
     WHEN l.reference_type = 'crop_sales'
       THEN CASE WHEN l.debit > 0 THEN '1200' ELSE '4200' END
     WHEN l.reference_type = 'dealer_sales'
       THEN CASE WHEN l.debit > 0 THEN '1200' ELSE '4100' END
     -- Money moving: the side carrying a cash account is the cash side; the
     -- other settles a receivable on a receipt or a payable on a payment.
     WHEN l.reference_type = 'payments'
       THEN CASE WHEN l.account_id IS NOT NULL THEN '1100'
                 WHEN l.debit > 0 THEN '2100'
                 ELSE '1200' END
     WHEN l.reference_type = 'expenses'
       THEN CASE WHEN l.account_id IS NOT NULL THEN '1100' ELSE '5200' END
   END;

ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_update;

-- Every entry now has an account. Refusing to complete otherwise is deliberate:
-- an unclassified journal row is a hole in the trial balance, and finding out
-- here is better than finding out from a statement that does not balance.
ALTER TABLE ledger_entries ALTER COLUMN coa_id SET NOT NULL;

CREATE INDEX ledger_entries_coa ON ledger_entries (coa_id, entry_date);

-- ----------------------------------------------------------- trial balance

-- Debits and credits per account. Assets and expenses carry a debit balance,
-- the rest a credit balance, so `balance` is signed by nature and the two
-- totals across the whole view are equal by construction.
CREATE VIEW v_trial_balance AS
SELECT c.org_id,
       c.id                AS coa_id,
       c.code,
       c.name,
       c.account_class,
       COALESCE(SUM(l.debit), 0)  AS total_debit,
       COALESCE(SUM(l.credit), 0) AS total_credit,
       CASE WHEN c.account_class IN ('ASSET', 'EXPENSE')
            THEN COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0)
            ELSE COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0)
       END                 AS balance,
       MIN(l.entry_date)   AS first_entry,
       MAX(l.entry_date)   AS last_entry
  FROM chart_of_accounts c
  LEFT JOIN ledger_entries l ON l.coa_id = c.id
 WHERE NOT c.is_group
 GROUP BY c.org_id, c.id, c.code, c.name, c.account_class;

-- ------------------------------------------------------------- permissions

INSERT INTO permissions (code, description) VALUES
  ('account.chart.view',   'View the chart of accounts'),
  ('account.chart.create', 'Create ledger accounts'),
  ('account.chart.edit',   'Edit and restore ledger accounts'),
  ('account.chart.delete', 'Retire ledger accounts')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'Admin'
ON CONFLICT DO NOTHING;

-- Accounts keeps the books, so Accounts maintains the chart; Management sees
-- it without changing it, as it sees the rest of the configuration.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'Accounts'
   AND p.code IN ('account.chart.view', 'account.chart.create', 'account.chart.edit')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code = 'Management' AND p.code = 'account.chart.view'
ON CONFLICT DO NOTHING;
