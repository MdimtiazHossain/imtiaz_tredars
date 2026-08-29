-- 004_inventory.sql — batches, the stock ledger, adjustments and transfers.
--
-- Stock is never edited silently. Every change writes a stock_movements row,
-- and the `stock` table is a maintained running total that must always agree
-- with the sum of the ledger (see the reconciliation view in 007).

-- ------------------------------------------------------------- crop batches

CREATE TABLE crop_batches (
  id                bigserial PRIMARY KEY,
  org_id            bigint      NOT NULL REFERENCES organizations(id),
  batch_no          text        NOT NULL,
  purchase_item_id  bigint      REFERENCES crop_purchase_items(id),
  crop_id           bigint      NOT NULL REFERENCES crops(id),
  grade_id          bigint      REFERENCES crop_grades(id),
  warehouse_id      bigint      NOT NULL REFERENCES warehouses(id),
  supplier_id       bigint      REFERENCES suppliers(id),
  unit_id           bigint      NOT NULL REFERENCES units(id),
  received_on       date        NOT NULL,
  quantity_received numeric(18,3) NOT NULL,
  -- The live figure FIFO allocation decrements. The check constraint is the
  -- last line of defence against overselling if application logic is bypassed.
  quantity_remaining numeric(18,3) NOT NULL,
  cost_per_unit     numeric(18,4) NOT NULL,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, batch_no),
  CHECK (quantity_received > 0),
  CHECK (quantity_remaining >= 0),
  CHECK (quantity_remaining <= quantity_received),
  CHECK (cost_per_unit >= 0)
);

-- FIFO consumes oldest first; this index makes the pool scan an index scan.
CREATE INDEX crop_batches_fifo
  ON crop_batches (crop_id, warehouse_id, received_on, id)
  WHERE quantity_remaining > 0;

CREATE TABLE crop_batch_allocations (
  id                bigserial PRIMARY KEY,
  sale_item_id      bigint      NOT NULL REFERENCES crop_sale_items(id) ON DELETE CASCADE,
  batch_id          bigint      NOT NULL REFERENCES crop_batches(id),
  quantity          numeric(18,3) NOT NULL,
  unit_cost         numeric(18,4) NOT NULL,
  cost_value        numeric(18,2) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity > 0),
  CHECK (unit_cost >= 0)
);

CREATE INDEX crop_batch_allocations_batch ON crop_batch_allocations (batch_id);
CREATE INDEX crop_batch_allocations_item  ON crop_batch_allocations (sale_item_id);

-- ---------------------------------------------------------------- stock ledger

-- Running balance per (warehouse, item). Products are tracked by product_id;
-- bulk crop is tracked per batch, because each batch carries its own cost.
CREATE TABLE stock (
  id           bigserial PRIMARY KEY,
  org_id       bigint      NOT NULL REFERENCES organizations(id),
  warehouse_id bigint      NOT NULL REFERENCES warehouses(id),
  item_type    stock_item_type NOT NULL,
  product_id   bigint      REFERENCES products(id),
  batch_id     bigint      REFERENCES crop_batches(id),
  quantity     numeric(18,3) NOT NULL DEFAULT 0,
  avg_cost     numeric(18,4) NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity >= 0),
  CHECK (
    (item_type = 'PRODUCT'    AND product_id IS NOT NULL AND batch_id IS NULL) OR
    (item_type = 'CROP_BATCH' AND batch_id   IS NOT NULL AND product_id IS NULL)
  )
);

CREATE UNIQUE INDEX stock_product_key
  ON stock (warehouse_id, product_id) WHERE item_type = 'PRODUCT';
CREATE UNIQUE INDEX stock_batch_key
  ON stock (warehouse_id, batch_id) WHERE item_type = 'CROP_BATCH';

-- The immutable ledger. Rows are append-only: corrections are new movements,
-- never edits, so stock history is always reconstructable.
CREATE TABLE stock_movements (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  movement_no    text        NOT NULL,
  moved_at       timestamptz NOT NULL DEFAULT now(),
  movement_date  date        NOT NULL,
  movement_type  movement_type NOT NULL,
  business_type  business_type NOT NULL,
  warehouse_id   bigint      NOT NULL REFERENCES warehouses(id),
  item_type      stock_item_type NOT NULL,
  product_id     bigint      REFERENCES products(id),
  batch_id       bigint      REFERENCES crop_batches(id),
  quantity_in    numeric(18,3) NOT NULL DEFAULT 0,
  quantity_out   numeric(18,3) NOT NULL DEFAULT 0,
  unit_cost      numeric(18,4) NOT NULL DEFAULT 0,
  -- What caused this movement, e.g. ('dealer_sales', 42).
  reference_type text        NOT NULL,
  reference_id   bigint      NOT NULL,
  note           text,
  created_by     bigint      NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, movement_no),
  CHECK (quantity_in >= 0 AND quantity_out >= 0),
  CHECK ((quantity_in > 0) <> (quantity_out > 0)),
  CHECK (
    (item_type = 'PRODUCT'    AND product_id IS NOT NULL AND batch_id IS NULL) OR
    (item_type = 'CROP_BATCH' AND batch_id   IS NOT NULL AND product_id IS NULL)
  )
);

CREATE INDEX stock_movements_reference ON stock_movements (reference_type, reference_id);
CREATE INDEX stock_movements_product   ON stock_movements (product_id, movement_date);
CREATE INDEX stock_movements_batch     ON stock_movements (batch_id, movement_date);
CREATE INDEX stock_movements_warehouse ON stock_movements (warehouse_id, movement_date);

-- The ledger is append-only.
CREATE OR REPLACE FUNCTION guard_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'STOCK_LEDGER_IS_APPEND_ONLY' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_append_only();
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_append_only();

-- ------------------------------------------------------- adjustments/transfers

CREATE TABLE stock_adjustments (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  business_type       business_type NOT NULL,
  warehouse_id        bigint      NOT NULL REFERENCES warehouses(id),
  reason              text        NOT NULL,
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
  UNIQUE (org_id, txn_no)
);

CREATE TABLE stock_adjustment_items (
  id            bigserial PRIMARY KEY,
  adjustment_id bigint      NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  line_no       integer     NOT NULL,
  item_type     stock_item_type NOT NULL,
  product_id    bigint      REFERENCES products(id),
  batch_id      bigint      REFERENCES crop_batches(id),
  -- Positive increases stock, negative decreases it.
  quantity_delta numeric(18,3) NOT NULL,
  unit_cost     numeric(18,4) NOT NULL DEFAULT 0,
  value_delta   numeric(18,2) NOT NULL DEFAULT 0,
  UNIQUE (adjustment_id, line_no),
  CHECK (quantity_delta <> 0)
);

CREATE TABLE stock_transfers (
  id                  bigserial PRIMARY KEY,
  org_id              bigint      NOT NULL REFERENCES organizations(id),
  txn_no              text        NOT NULL,
  txn_date            date        NOT NULL,
  business_type       business_type NOT NULL,
  from_warehouse_id   bigint      NOT NULL REFERENCES warehouses(id),
  to_warehouse_id     bigint      NOT NULL REFERENCES warehouses(id),
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
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE stock_transfer_items (
  id          bigserial PRIMARY KEY,
  transfer_id bigint      NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  line_no     integer     NOT NULL,
  item_type   stock_item_type NOT NULL,
  product_id  bigint      REFERENCES products(id),
  batch_id    bigint      REFERENCES crop_batches(id),
  quantity    numeric(18,3) NOT NULL,
  unit_cost   numeric(18,4) NOT NULL DEFAULT 0,
  UNIQUE (transfer_id, line_no),
  CHECK (quantity > 0)
);

CREATE TRIGGER crop_batches_touch BEFORE UPDATE ON crop_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_adjustments_touch BEFORE UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_transfers_touch BEFORE UPDATE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_adjustments_immutable BEFORE UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();
CREATE TRIGGER stock_transfers_immutable BEFORE UPDATE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION guard_posted_immutable();
