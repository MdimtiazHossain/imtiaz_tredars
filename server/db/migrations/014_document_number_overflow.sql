-- Document numbering wrapped after 999 in a period.
--
-- `lpad` does not only pad: it truncates when the value is longer than the
-- target width. With a padding of 3, the 1000th document of a type in a month
-- became lpad('1000', 3, '0') = '100' -- the number the 100th document already
-- carries. The unique constraint then rejected the insert, so posting failed
-- with a raw constraint violation and the business simply could not record a
-- thousandth movement, sale or receipt that month.
--
-- 999 is not a distant ceiling. Every purchase and sale line writes stock
-- movements, so a month of ordinary trading reaches it.
--
-- Padding is a minimum width from here on, never a maximum: numbers keep their
-- leading zeros up to the padding and simply grow past it.
--   MOV-2608-001 … MOV-2608-999, MOV-2608-1000, MOV-2608-1001, …

CREATE OR REPLACE FUNCTION next_document_no(
  p_org_id  bigint,
  p_doc_type text,
  p_prefix  text,
  p_period  text,
  p_padding integer DEFAULT 3
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_value integer;
BEGIN
  INSERT INTO document_sequences (org_id, doc_type, prefix, period, next_value, padding)
  VALUES (p_org_id, p_doc_type, p_prefix, p_period, 1, p_padding)
  ON CONFLICT (org_id, doc_type, period) DO NOTHING;

  UPDATE document_sequences
     SET next_value = next_value + 1
   WHERE org_id = p_org_id AND doc_type = p_doc_type AND period = p_period
  RETURNING next_value - 1 INTO v_value;

  RETURN p_prefix || '-' || p_period || '-' ||
         lpad(v_value::text, greatest(p_padding, length(v_value::text)), '0');
END;
$$;
