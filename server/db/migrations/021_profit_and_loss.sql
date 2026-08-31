-- 021_profit_and_loss.sql — a profit and loss the books can actually produce.
--
-- 020 gave every journal entry an account. What it could not yet give was a
-- profit and loss, because selling stock was only half journalled: income was
-- recorded and the cost of the goods that earned it was not. A statement built
-- on that would have shown the whole sale value as profit.
--
-- The posting services now write the other half — Dr cost of goods sold, Cr
-- inventory, for the batches a sale actually consumed — so the ledger holds
-- both sides and a statement can be derived rather than asserted. The P&L on
-- the Accounts screen has been a hard-coded fixture since the design was
-- imported; this is what replaces it.

-- Income and expense, by account and by day, which is the grain every
-- statement below is grouped from. Business type travels with the entry so
-- dealer and bulk crop can be reported apart, as they are everywhere else.
CREATE VIEW v_profit_and_loss AS
SELECT l.org_id,
       l.entry_date,
       l.business_type,
       c.id            AS coa_id,
       c.code,
       c.name,
       c.account_class,
       -- Income is credit-natured and expense debit-natured, so each is
       -- signed so that "more of it" is a positive number in its own row.
       CASE WHEN c.account_class = 'INCOME'
            THEN SUM(l.credit) - SUM(l.debit)
            ELSE SUM(l.debit) - SUM(l.credit)
       END             AS amount
  FROM ledger_entries l
  JOIN chart_of_accounts c ON c.id = l.coa_id
 WHERE c.account_class IN ('INCOME', 'EXPENSE')
 GROUP BY l.org_id, l.entry_date, l.business_type, c.id, c.code, c.name, c.account_class;

COMMENT ON VIEW v_profit_and_loss IS
  'Income and expense per account per day, signed by account nature. Group by '
  'date range and business type for a statement; revenue less cost of sales is '
  'gross profit, less operating expense is net profit.';

-- The balance sheet's other half, for completeness: assets, liabilities and
-- equity carry balances rather than movements, so they are summed over all
-- time rather than a period.
CREATE VIEW v_balance_sheet AS
SELECT c.org_id,
       c.id            AS coa_id,
       c.code,
       c.name,
       c.account_class,
       CASE WHEN c.account_class = 'ASSET'
            THEN COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0)
            ELSE COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0)
       END             AS balance
  FROM chart_of_accounts c
  LEFT JOIN ledger_entries l ON l.coa_id = c.id
 WHERE NOT c.is_group
   AND c.account_class IN ('ASSET', 'LIABILITY', 'EQUITY')
 GROUP BY c.org_id, c.id, c.code, c.name, c.account_class;
