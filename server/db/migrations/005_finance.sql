-- 005_finance.sql — payments, allocations, expenses, receivables and payables.
--
-- Receivables and payables are maintained rows rather than views: a customer
-- balance is read on nearly every screen, and the aging buckets need an
-- indexable due date. Posting writes them; payment allocation updates them.

CREATE TABLE payments (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  business_type       business_type NOT NULL,
  direction           payment_direction NOT NULL,
  party_type          party_type  NOT NULL,
  party_id            bigint      NOT NULL,
  account_id          bigint      NOT NULL REFERENCES accounts(id),
  payment_method_id   bigint      REFERENCES payment_methods(id),
  amount              numeric(18,2) NOT NULL,
  -- Amount not yet tied to a specific invoice; an on-account balance.
  unallocated_amount  numeric(18,2) NOT NULL DEFAULT 0,
  reference_no        text,
  note                text,
  status              transaction_status NOT NULL DEFAULT 'DRAFT',
  posted_at           timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        bigint      REFERENCES users(id),
  cancellation_reason text,
  created_by          bigint      NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint      REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, txn_no),
  CHECK (amount > 0),
  CHECK (unallocated_amount >= 0 AND unallocated_amount <= amount)
);

CREATE INDEX payments_party ON payments (party_type, party_id, txn_date);

CREATE TABLE payment_allocations (
  id           bigserial PRIMARY KEY,
  payment_id   bigint      NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  -- Which document is being settled, e.g. 'dealer_sales' or 'crop_purchases'.
  invoice_type text        NOT NULL,
  invoice_id   bigint      NOT NULL,
  amount       numeric(18,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (amount > 0),
  UNIQUE (payment_id, invoice_type, invoice_id)
);

CREATE INDEX payment_allocations_invoice
  ON payment_allocations (invoice_type, invoice_id);

CREATE TABLE expenses (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  -- NULL means the expense is shared across both business lines.
  business_type       business_type,
  category_id         bigint      NOT NULL REFERENCES expense_categories(id),
  account_id          bigint      REFERENCES accounts(id),
  warehouse_id        bigint      REFERENCES warehouses(id),
  amount              numeric(18,2) NOT NULL,
  note                text,
  status              transaction_status NOT NULL DEFAULT 'DRAFT',
  posted_at           timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        bigint      REFERENCES users(id),
  cancellation_reason text,
  created_by          bigint      NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint      REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, txn_no),
  CHECK (amount > 0)
);

CREATE INDEX expenses_date ON expenses (txn_date, business_type);

-- ------------------------------------------------------- receivable/payable

CREATE TABLE receivables (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  -- Dealer invoices are owed by a customer; bulk crop invoices by a buyer
  -- company. Both are receivable, so the party is typed rather than assumed.
  party_type     party_type  NOT NULL,
  party_id       bigint      NOT NULL,
  business_type  business_type NOT NULL,
  invoice_type   text        NOT NULL,
  invoice_id     bigint      NOT NULL,
  invoice_no     text        NOT NULL,
  invoice_date   date        NOT NULL,
  due_date       date        NOT NULL,
  invoice_amount numeric(18,2) NOT NULL,
  paid_amount    numeric(18,2) NOT NULL DEFAULT 0,
  -- Maintained by the application inside the same transaction as allocation.
  balance        numeric(18,2) NOT NULL,
  is_settled     boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_type, invoice_id),
  CHECK (invoice_amount >= 0),
  CHECK (paid_amount >= 0 AND paid_amount <= invoice_amount),
  CHECK (balance = invoice_amount - paid_amount)
);

CREATE INDEX receivables_party ON receivables (party_type, party_id) WHERE NOT is_settled;
CREATE INDEX receivables_aging    ON receivables (due_date)    WHERE NOT is_settled;

CREATE TABLE payables (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  party_type     party_type  NOT NULL,
  party_id       bigint      NOT NULL,
  business_type  business_type NOT NULL,
  invoice_type   text        NOT NULL,
  invoice_id     bigint      NOT NULL,
  invoice_no     text        NOT NULL,
  invoice_date   date        NOT NULL,
  due_date       date        NOT NULL,
  invoice_amount numeric(18,2) NOT NULL,
  paid_amount    numeric(18,2) NOT NULL DEFAULT 0,
  balance        numeric(18,2) NOT NULL,
  is_settled     boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_type, invoice_id),
  CHECK (invoice_amount >= 0),
  CHECK (paid_amount >= 0 AND paid_amount <= invoice_amount),
  CHECK (balance = invoice_amount - paid_amount)
);

CREATE INDEX payables_party ON payables (party_type, party_id) WHERE NOT is_settled;
CREATE INDEX payables_aging ON payables (due_date)             WHERE NOT is_settled;

-- ---------------------------------------------------------- financial ledger

-- Double-entry style journal. Posting any document writes balanced pairs here,
-- so cash, bank and party balances can always be re-derived independently of
-- the maintained running totals.
CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  entry_date     date        NOT NULL,
  business_type  business_type,
  account_id     bigint      REFERENCES accounts(id),
  party_type     party_type,
  party_id       bigint,
  narration      text        NOT NULL,
  debit          numeric(18,2) NOT NULL DEFAULT 0,
  credit         numeric(18,2) NOT NULL DEFAULT 0,
  reference_type text        NOT NULL,
  reference_id   bigint      NOT NULL,
  created_by     bigint      NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit > 0) <> (credit > 0))
);

CREATE INDEX ledger_entries_reference ON ledger_entries (reference_type, reference_id);
CREATE INDEX ledger_entries_account   ON ledger_entries (account_id, entry_date);
CREATE INDEX ledger_entries_party     ON ledger_entries (party_type, party_id, entry_date);

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_append_only();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_append_only();

CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER expenses_touch BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER receivables_touch BEFORE UPDATE ON receivables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payables_touch BEFORE UPDATE ON payables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_immutable BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();
CREATE TRIGGER expenses_immutable BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();
