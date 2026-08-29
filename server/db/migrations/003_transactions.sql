-- 003_transactions.sql — dealer and bulk crop trading documents.
--
-- Every financial document carries the same header contract: a unique
-- transaction number, a date, a business type, a status and full authorship.
-- A posted document is immutable; correction happens through cancellation and
-- a fresh document, never through an in-place edit or a delete.

-- Blocks edits to a posted document. The only permitted transition out of
-- POSTED is to CANCELLED, which must also record who cancelled it and why.
-- Column-agnostic so it can guard any document table: it diffs the whole row
-- as jsonb and permits only the cancellation and audit columns to move.
CREATE OR REPLACE FUNCTION guard_posted_immutable() RETURNS trigger AS $$
DECLARE
  mutable_cols text[] := ARRAY[
    'status', 'cancelled_at', 'cancelled_by', 'cancellation_reason',
    'updated_by', 'updated_at'
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

-- Refuses a hard delete of anything that ever reached POSTED.
CREATE OR REPLACE FUNCTION guard_no_delete_posted() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'POSTED_TRANSACTION_CANNOT_BE_DELETED'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------- dealer purchases

CREATE TABLE dealer_purchases (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  business_type       business_type NOT NULL DEFAULT 'DEALER',
  company_id          bigint      NOT NULL REFERENCES companies(id),
  supplier_invoice_no text,
  warehouse_id        bigint      NOT NULL REFERENCES warehouses(id),
  payment_terms       text,
  transport_cost      numeric(18,2) NOT NULL DEFAULT 0,
  other_cost          numeric(18,2) NOT NULL DEFAULT 0,
  gross_amount        numeric(18,2) NOT NULL DEFAULT 0,
  discount_amount     numeric(18,2) NOT NULL DEFAULT 0,
  net_amount          numeric(18,2) NOT NULL DEFAULT 0,
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
  CHECK (transport_cost >= 0 AND other_cost >= 0),
  CHECK (gross_amount >= 0 AND discount_amount >= 0 AND net_amount >= 0)
);

-- A principal's own invoice number may not be recorded twice for one company.
CREATE UNIQUE INDEX dealer_purchases_company_invoice
  ON dealer_purchases (company_id, supplier_invoice_no)
  WHERE supplier_invoice_no IS NOT NULL AND status <> 'CANCELLED';

CREATE TABLE dealer_purchase_items (
  id            bigserial PRIMARY KEY,
  purchase_id   bigint      NOT NULL REFERENCES dealer_purchases(id) ON DELETE CASCADE,
  line_no       integer     NOT NULL,
  product_id    bigint      NOT NULL REFERENCES products(id),
  quantity      numeric(18,3) NOT NULL,
  free_quantity numeric(18,3) NOT NULL DEFAULT 0,
  rate          numeric(18,2) NOT NULL,
  discount_pct  numeric(9,4)  NOT NULL DEFAULT 0,
  line_net      numeric(18,2) NOT NULL,
  UNIQUE (purchase_id, line_no),
  CHECK (quantity > 0),
  CHECK (free_quantity >= 0),
  CHECK (rate >= 0),
  CHECK (discount_pct >= 0 AND discount_pct <= 100)
);

-- -------------------------------------------------------------- dealer sales

CREATE TABLE dealer_sales (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  business_type       business_type NOT NULL DEFAULT 'DEALER',
  customer_id         bigint      NOT NULL REFERENCES customers(id),
  warehouse_id        bigint      NOT NULL REFERENCES warehouses(id),
  salesperson_id      bigint      REFERENCES employees(id),
  payment_terms       text,
  gross_amount        numeric(18,2) NOT NULL DEFAULT 0,
  discount_amount     numeric(18,2) NOT NULL DEFAULT 0,
  net_amount          numeric(18,2) NOT NULL DEFAULT 0,
  cost_amount         numeric(18,2) NOT NULL DEFAULT 0,
  profit_amount       numeric(18,2) NOT NULL DEFAULT 0,
  paid_amount         numeric(18,2) NOT NULL DEFAULT 0,
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
  CHECK (gross_amount >= 0 AND discount_amount >= 0 AND net_amount >= 0),
  CHECK (paid_amount >= 0)
);

CREATE TABLE dealer_sale_items (
  id           bigserial PRIMARY KEY,
  sale_id      bigint      NOT NULL REFERENCES dealer_sales(id) ON DELETE CASCADE,
  line_no      integer     NOT NULL,
  product_id   bigint      NOT NULL REFERENCES products(id),
  quantity     numeric(18,3) NOT NULL,
  bonus_quantity numeric(18,3) NOT NULL DEFAULT 0,
  rate         numeric(18,2) NOT NULL,
  discount_pct numeric(9,4)  NOT NULL DEFAULT 0,
  line_net     numeric(18,2) NOT NULL,
  unit_cost    numeric(18,4) NOT NULL DEFAULT 0,
  line_cost    numeric(18,2) NOT NULL DEFAULT 0,
  UNIQUE (sale_id, line_no),
  CHECK (quantity > 0),
  CHECK (bonus_quantity >= 0),
  CHECK (rate >= 0),
  CHECK (discount_pct >= 0 AND discount_pct <= 100)
);

-- ------------------------------------------------------------ crop purchases

CREATE TABLE crop_purchases (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  business_type       business_type NOT NULL DEFAULT 'BULK_CROP',
  supplier_id         bigint      NOT NULL REFERENCES suppliers(id),
  warehouse_id        bigint      NOT NULL REFERENCES warehouses(id),
  -- Incidental cost is captured on the header and pushed down into each line's
  -- landed cost in proportion to line value.
  transport_cost      numeric(18,2) NOT NULL DEFAULT 0,
  loading_cost        numeric(18,2) NOT NULL DEFAULT 0,
  unloading_cost      numeric(18,2) NOT NULL DEFAULT 0,
  other_cost          numeric(18,2) NOT NULL DEFAULT 0,
  purchase_value      numeric(18,2) NOT NULL DEFAULT 0,
  net_amount          numeric(18,2) NOT NULL DEFAULT 0,
  advance_paid        numeric(18,2) NOT NULL DEFAULT 0,
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
  CHECK (transport_cost >= 0 AND loading_cost >= 0
         AND unloading_cost >= 0 AND other_cost >= 0),
  CHECK (advance_paid >= 0)
);

CREATE TABLE crop_purchase_items (
  id               bigserial PRIMARY KEY,
  purchase_id      bigint      NOT NULL REFERENCES crop_purchases(id) ON DELETE CASCADE,
  line_no          integer     NOT NULL,
  crop_id          bigint      NOT NULL REFERENCES crops(id),
  grade_id         bigint      REFERENCES crop_grades(id),
  unit_id          bigint      NOT NULL REFERENCES units(id),
  gross_quantity   numeric(18,3) NOT NULL,
  moisture_pct     numeric(9,4)  NOT NULL DEFAULT 0,
  deduction_qty    numeric(18,3) NOT NULL DEFAULT 0,
  net_quantity     numeric(18,3) NOT NULL,
  rate             numeric(18,2) NOT NULL,
  line_value       numeric(18,2) NOT NULL,
  allocated_cost   numeric(18,2) NOT NULL DEFAULT 0,
  landed_cost      numeric(18,2) NOT NULL DEFAULT 0,
  cost_per_unit    numeric(18,4) NOT NULL DEFAULT 0,
  UNIQUE (purchase_id, line_no),
  CHECK (gross_quantity > 0),
  CHECK (net_quantity > 0),
  CHECK (net_quantity <= gross_quantity),
  CHECK (moisture_pct >= 0 AND moisture_pct < 100),
  CHECK (rate >= 0)
);

-- --------------------------------------------------------------- crop sales

CREATE TABLE crop_sales (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  business_type       business_type NOT NULL DEFAULT 'BULK_CROP',
  buyer_company_id    bigint      NOT NULL REFERENCES companies(id),
  warehouse_id        bigint      REFERENCES warehouses(id),
  valuation_method    text        NOT NULL DEFAULT 'FIFO',
  transport_cost      numeric(18,2) NOT NULL DEFAULT 0,
  other_cost          numeric(18,2) NOT NULL DEFAULT 0,
  gross_amount        numeric(18,2) NOT NULL DEFAULT 0,
  net_amount          numeric(18,2) NOT NULL DEFAULT 0,
  cogs_amount         numeric(18,2) NOT NULL DEFAULT 0,
  profit_amount       numeric(18,2) NOT NULL DEFAULT 0,
  paid_amount         numeric(18,2) NOT NULL DEFAULT 0,
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
  CHECK (valuation_method IN ('FIFO', 'WEIGHTED_AVERAGE')),
  CHECK (transport_cost >= 0 AND other_cost >= 0)
);

CREATE TABLE crop_sale_items (
  id         bigserial PRIMARY KEY,
  sale_id    bigint      NOT NULL REFERENCES crop_sales(id) ON DELETE CASCADE,
  line_no    integer     NOT NULL,
  crop_id    bigint      NOT NULL REFERENCES crops(id),
  unit_id    bigint      NOT NULL REFERENCES units(id),
  quantity   numeric(18,3) NOT NULL,
  rate       numeric(18,2) NOT NULL,
  line_value numeric(18,2) NOT NULL,
  line_cogs  numeric(18,2) NOT NULL DEFAULT 0,
  UNIQUE (sale_id, line_no),
  CHECK (quantity > 0),
  CHECK (rate >= 0)
);

CREATE TRIGGER dealer_purchases_touch BEFORE UPDATE ON dealer_purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER dealer_sales_touch BEFORE UPDATE ON dealer_sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crop_purchases_touch BEFORE UPDATE ON crop_purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crop_sales_touch BEFORE UPDATE ON crop_sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER dealer_purchases_immutable BEFORE UPDATE ON dealer_purchases
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();
CREATE TRIGGER dealer_sales_immutable BEFORE UPDATE ON dealer_sales
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();
CREATE TRIGGER crop_purchases_immutable BEFORE UPDATE ON crop_purchases
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();
CREATE TRIGGER crop_sales_immutable BEFORE UPDATE ON crop_sales
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();

CREATE TRIGGER dealer_purchases_no_delete BEFORE DELETE ON dealer_purchases
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete_posted();
CREATE TRIGGER dealer_sales_no_delete BEFORE DELETE ON dealer_sales
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete_posted();
CREATE TRIGGER crop_purchases_no_delete BEFORE DELETE ON crop_purchases
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete_posted();
CREATE TRIGGER crop_sales_no_delete BEFORE DELETE ON crop_sales
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete_posted();
