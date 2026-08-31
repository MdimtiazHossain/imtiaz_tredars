-- 017_closed_year_message.sql — say which year is closed, and when the document was dated.
--
-- The guard added in 015 raised its own sentence as the exception message. The
-- API translates database errors through a table keyed on a code, so anything
-- it does not recognise becomes "One of the values entered is not allowed." --
-- true, and useless to the clerk who has just dated a purchase into last year.
--
-- The convention in this schema is to raise a code and let the API own the
-- wording. The detail the operator needs -- which year, which date -- travels
-- in DETAIL, which the API appends when it is there.

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
    RAISE EXCEPTION 'FISCAL_YEAR_CLOSED'
      USING ERRCODE = 'check_violation',
            DETAIL = format('%s is closed, so nothing can be dated %s. Reopen the year first.',
                            v_year, to_char(NEW.txn_date, 'DD Mon YYYY'));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
