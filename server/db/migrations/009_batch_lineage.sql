-- Transferring part of a crop batch splits it: the source keeps what stayed
-- behind and a child batch is created at the destination. Nothing recorded
-- that relationship, so cancelling a transfer could reverse the stock ledger
-- but had no way to find the child batch and undo the split. The result was a
-- pair of phantoms — a child batch claiming stock its warehouse did not hold,
-- which FIFO would happily offer for sale, and a source batch permanently
-- short of the quantity that had come back to it.
--
-- `parent_batch_id` makes the lineage explicit, so a cancellation can put the
-- quantity back where it came from and retire the child.

ALTER TABLE crop_batches
  ADD COLUMN IF NOT EXISTS parent_batch_id bigint REFERENCES crop_batches (id);

COMMENT ON COLUMN crop_batches.parent_batch_id IS
  'Set when this batch was split off another by a stock transfer; null for a batch created by a purchase.';

CREATE INDEX IF NOT EXISTS idx_crop_batches_parent ON crop_batches (parent_batch_id)
  WHERE parent_batch_id IS NOT NULL;

-- `v_stock_reconciliation` compares the running `stock` balance against the
-- movement ledger, which is why this drift went unnoticed: both of those
-- agreed. What disagreed was `crop_batches.quantity_remaining`, the figure
-- FIFO actually allocates from. This view checks that third number against the
-- stock the batch's own warehouse holds, so a batch can never offer for sale
-- what is not there.
CREATE OR REPLACE VIEW v_batch_reconciliation AS
SELECT
  b.id                AS batch_id,
  b.org_id,
  b.batch_no,
  b.warehouse_id,
  b.quantity_remaining,
  COALESCE(s.quantity, 0) AS stock_quantity,
  b.quantity_remaining - COALESCE(s.quantity, 0) AS difference
FROM crop_batches b
LEFT JOIN stock s
  ON s.batch_id = b.id
 AND s.warehouse_id = b.warehouse_id
 AND s.item_type = 'CROP_BATCH'
WHERE b.is_active;

COMMENT ON VIEW v_batch_reconciliation IS
  'Every active crop batch whose remaining quantity should equal the stock its warehouse holds; a non-zero difference means FIFO can allocate stock that does not exist.';
