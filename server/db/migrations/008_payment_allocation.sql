-- Allocating a payment has to move `payments.unallocated_amount`, but the
-- posted-transaction guard froze every column except status and cancellation,
-- so allocating against a POSTED payment raised POSTED_TRANSACTION_IMMUTABLE
-- and no payment could ever be applied to an invoice.
--
-- `unallocated_amount` is a running balance by design — the column comment in
-- 005_finance.sql calls it "an on-account balance" — so it belongs in the
-- mutable set. Nothing that fixes the payment's financial identity moves:
-- `amount` stays frozen, and the CHECK constraint still holds
-- `0 <= unallocated_amount <= amount`. `payments` is the only table carrying
-- this column, so no other guarded table is loosened.

CREATE OR REPLACE FUNCTION guard_posted_immutable() RETURNS trigger AS $$
DECLARE
  mutable_cols text[] := ARRAY[
    'status', 'cancelled_at', 'cancelled_by', 'cancellation_reason',
    'updated_by', 'updated_at', 'unallocated_amount'
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
