-- 023_returns_and_credit_notes.sql — goods coming back, and the money with them.
--
-- Until now a posted document could only be cancelled in full. A dealer who
-- takes fifty bags and sends six back damaged had no representation at all:
-- cancelling the invoice would have unwound the forty-four they kept, so the
-- practice was to leave the invoice standing and settle the difference by
-- agreement. The stock was wrong, the receivable was wrong, and the profit on
-- that invoice was wrong.
--
-- A return is its own document. It references the original, moves only the
-- quantity actually coming back, and raises the note that adjusts the party's
-- balance: a credit note to a customer whose goods came back to us, a debit
-- note to a principal whose goods went back to them.
--
-- Notes exist without goods as well. A price agreed after invoicing, or an
-- allowance for damage the customer keeps, is a credit note with no return
-- behind it -- which is why `credit_notes.return_id` is nullable rather than
-- the return owning the note.

-- 'CREDIT' reduces what a customer owes us; 'DEBIT' reduces what we owe a
-- supplier. The direction of the money, not who wrote the paper.
CREATE TYPE credit_note_type AS ENUM ('CREDIT', 'DEBIT');

/* ------------------------------------------------------------------ returns */

-- One table rather than four. A return is the same document whichever way it
-- points -- a source document, the party, the goods and a reason -- and the
-- codebase already types its cross-cutting tables this way: `stock_movements`,
-- `receivables` and `ledger_entries` all carry a reference type beside an id.
CREATE TABLE returns (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  business_type       business_type NOT NULL,
  -- Which document is coming back, e.g. 'dealer_sales' or 'crop_purchases'.
  source_type         text        NOT NULL,
  source_id           bigint      NOT NULL,
  -- Denormalised so a return still names its origin after the fact.
  source_no           text        NOT NULL,
  party_type          party_type  NOT NULL,
  party_id            bigint      NOT NULL,
  warehouse_id        bigint      NOT NULL REFERENCES warehouses(id),
  reason              text        NOT NULL,
  gross_amount        numeric(18,2) NOT NULL DEFAULT 0,
  discount_amount     numeric(18,2) NOT NULL DEFAULT 0,
  net_amount          numeric(18,2) NOT NULL DEFAULT 0,
  -- What the returned goods cost us, so the cost side can be unwound too.
  cost_amount         numeric(18,2) NOT NULL DEFAULT 0,
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
  CHECK (source_type IN ('dealer_sales', 'dealer_purchases', 'crop_sales', 'crop_purchases')),
  CHECK (gross_amount >= 0 AND discount_amount >= 0 AND net_amount >= 0),
  CHECK (cost_amount >= 0),
  CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX returns_source ON returns (source_type, source_id);
CREATE INDEX returns_party  ON returns (party_type, party_id, txn_date);
CREATE INDEX returns_date   ON returns (org_id, txn_date);

CREATE TABLE return_items (
  id             bigserial PRIMARY KEY,
  return_id      bigint      NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  line_no        integer     NOT NULL,
  -- The line of the original document being returned. Nullable only because a
  -- crop sale returns against batch allocations rather than against one line.
  source_item_id bigint,
  item_type      stock_item_type NOT NULL,
  product_id     bigint      REFERENCES products(id),
  batch_id       bigint      REFERENCES crop_batches(id),
  quantity       numeric(18,3) NOT NULL,
  rate           numeric(18,2) NOT NULL,
  discount_pct   numeric(9,4)  NOT NULL DEFAULT 0,
  line_net       numeric(18,2) NOT NULL,
  unit_cost      numeric(18,4) NOT NULL DEFAULT 0,
  line_cost      numeric(18,2) NOT NULL DEFAULT 0,
  UNIQUE (return_id, line_no),
  CHECK (quantity > 0),
  CHECK (rate >= 0),
  CHECK (discount_pct >= 0 AND discount_pct <= 100),
  -- A product line names a product and a batch line names a batch; never both,
  -- and never neither, which is what makes the stock movement unambiguous.
  CHECK ((item_type = 'PRODUCT'    AND product_id IS NOT NULL AND batch_id IS NULL)
      OR (item_type = 'CROP_BATCH' AND batch_id   IS NOT NULL AND product_id IS NULL))
);

CREATE INDEX return_items_source ON return_items (source_item_id);

/* ------------------------------------------------------------- credit notes */

CREATE TABLE credit_notes (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  note_no             text        NOT NULL,
  note_date           date        NOT NULL,
  note_type           credit_note_type NOT NULL,
  business_type       business_type NOT NULL,
  party_type          party_type  NOT NULL,
  party_id            bigint      NOT NULL,
  -- The return that raised it, where goods came back. A note issued for a
  -- price adjustment or an allowance has none.
  return_id           bigint      REFERENCES returns(id),
  -- The document the note adjusts, where it names one.
  source_type         text,
  source_id           bigint,
  source_no           text,
  reason              text        NOT NULL,
  amount              numeric(18,2) NOT NULL,
  -- How much of it has been set against invoices. The remainder sits on
  -- account for the party, exactly as an unallocated payment does.
  applied_amount      numeric(18,2) NOT NULL DEFAULT 0,
  status              transaction_status NOT NULL DEFAULT 'DRAFT',
  posted_at           timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        bigint      REFERENCES users(id),
  cancellation_reason text,
  created_by          bigint      NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint      REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, note_no),
  CHECK (amount > 0),
  CHECK (applied_amount >= 0 AND applied_amount <= amount),
  CHECK (length(btrim(reason)) > 0),
  CHECK ((source_type IS NULL) = (source_id IS NULL))
);

CREATE INDEX credit_notes_party  ON credit_notes (party_type, party_id, note_date);
CREATE INDEX credit_notes_source ON credit_notes (source_type, source_id);
CREATE INDEX credit_notes_open   ON credit_notes (org_id) WHERE applied_amount < amount;

-- Which invoices a note was set against, mirroring `payment_allocations`.
CREATE TABLE credit_note_allocations (
  id           bigserial PRIMARY KEY,
  note_id      bigint      NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  invoice_type text        NOT NULL,
  invoice_id   bigint      NOT NULL,
  amount       numeric(18,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (amount > 0),
  UNIQUE (note_id, invoice_type, invoice_id)
);

CREATE INDEX credit_note_allocations_invoice
  ON credit_note_allocations (invoice_type, invoice_id);

/* ------------------------------------------------------------------ triggers */

CREATE TRIGGER returns_touch BEFORE UPDATE ON returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER credit_notes_touch BEFORE UPDATE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER returns_posted_guard BEFORE UPDATE ON returns
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();

-- `applied_amount` is a running balance, like `payments.unallocated_amount`
-- before it: a posted note keeps its face value frozen while the part of it
-- still on account moves as invoices are settled with it.
CREATE OR REPLACE FUNCTION guard_posted_immutable() RETURNS trigger AS $$
DECLARE
  mutable_cols text[] := ARRAY[
    'status', 'cancelled_at', 'cancelled_by', 'cancellation_reason',
    'updated_by', 'updated_at', 'unallocated_amount', 'applied_amount'
  ];
BEGIN
  IF OLD.status <> 'POSTED' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'CANCELLED' THEN
    IF NEW.cancelled_by IS NULL OR NEW.cancellation_reason IS NULL THEN
      RAISE EXCEPTION 'CANCEL_REQUIRES_REASON'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status <> 'POSTED' THEN
    RAISE EXCEPTION 'POSTED_TRANSACTION_IMMUTABLE'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (to_jsonb(OLD) - mutable_cols) <> (to_jsonb(NEW) - mutable_cols) THEN
    RAISE EXCEPTION 'POSTED_TRANSACTION_IMMUTABLE'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_notes_posted_guard BEFORE UPDATE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();

/* ------------------------------------------------------------------ accounts */

-- Returns are not negative sales. Netting them against the revenue account
-- would hide them: a month with heavy returns would read as a quiet month
-- rather than a bad one. They get their own account, which the profit and loss
-- shows as a deduction because income is signed credit-less-debit.
INSERT INTO chart_of_accounts (org_id, code, name, account_class, is_group, is_system)
SELECT o.id, '4900', 'Sales returns and allowances', 'INCOME', false, true
  FROM organizations o
ON CONFLICT (org_id, code) DO NOTHING;

UPDATE chart_of_accounts child
   SET parent_id = parent.id
  FROM chart_of_accounts parent
 WHERE parent.org_id = child.org_id
   AND parent.is_group
   AND parent.code = '4000'
   AND child.code = '4900'
   AND child.parent_id IS NULL;

/* -------------------------------------------------------------- numbering */

INSERT INTO document_number_formats (org_id, doc_type, prefix, padding)
SELECT o.id, d.doc_type, d.prefix, d.padding
  FROM organizations o
  CROSS JOIN (VALUES
    ('sale_return',     'SR',  3),
    ('purchase_return', 'PR',  3),
    ('credit_note',     'CN',  3),
    ('debit_note',      'DN',  3)
  ) AS d(doc_type, prefix, padding)
ON CONFLICT (org_id, doc_type) DO NOTHING;

/* ------------------------------------------------------------- permissions */

INSERT INTO permissions (code, description) VALUES
  ('return.view',   'View returns and credit notes'),
  ('return.create', 'Record a return'),
  ('return.post',   'Post a return'),
  ('return.cancel', 'Cancel a posted return'),
  ('credit.note.create', 'Issue a credit or debit note without a return')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Admin'
   AND p.code IN ('return.view', 'return.create', 'return.post', 'return.cancel',
                  'credit.note.create')
ON CONFLICT DO NOTHING;

-- Sales raises the return a customer brings in and posts it, the same standing
-- they have for the invoice it comes from. Purchase records a return to a
-- principal but does not post it, mirroring how they raise purchases.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE (r.code = 'Sales'    AND p.code IN ('return.view', 'return.create', 'return.post'))
    OR (r.code = 'Purchase' AND p.code IN ('return.view', 'return.create'))
    OR (r.code = 'Warehouse' AND p.code IN ('return.view'))
    OR (r.code = 'Management' AND p.code IN ('return.view'))
    -- A credit note moves money without goods, so it sits with Accounts along
    -- with the payments and the ledger it lands in.
    OR (r.code = 'Accounts' AND p.code IN ('return.view', 'return.create', 'return.post',
                                           'credit.note.create'))
ON CONFLICT DO NOTHING;

/* ------------------------------------------------------------------- views */

-- What a party is owed or owes once notes on account are taken off. A credit
-- note that has not been applied is money the customer does not have to pay,
-- and an outstanding figure that ignores it overstates the debt.
CREATE VIEW v_credit_note_balance AS
SELECT n.org_id,
       n.party_type,
       n.party_id,
       n.note_type,
       SUM(n.amount - n.applied_amount) AS on_account
  FROM credit_notes n
 WHERE n.status = 'POSTED'
   AND n.applied_amount < n.amount
 GROUP BY n.org_id, n.party_type, n.party_id, n.note_type;

COMMENT ON VIEW v_credit_note_balance IS
  'Posted credit and debit notes not yet set against an invoice, by party. '
  'Subtract from receivable for CREDIT and from payable for DEBIT.';

-- How much of each posted document has come back, so a second return cannot
-- take more than was sold and a list can show what is left.
CREATE VIEW v_returned_quantities AS
SELECT i.source_item_id,
       r.source_type,
       r.source_id,
       SUM(i.quantity)  AS quantity_returned,
       SUM(i.line_net)  AS value_returned
  FROM return_items i
  JOIN returns r ON r.id = i.return_id
 WHERE r.status = 'POSTED'
 GROUP BY i.source_item_id, r.source_type, r.source_id;
