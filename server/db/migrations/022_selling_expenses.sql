-- 022_selling_expenses.sql — put the cost of selling into the books.
--
-- A crop sale carries transport and other costs. They are not inventoriable:
-- the batch's landed cost was settled when it was bought, and these are what it
-- costs to get it to the buyer. They reduce profit, the sale row records them,
-- and the profit-and-loss report has always subtracted them — but they were
-- never journalled.
--
-- While the P&L was computed from transaction tables that went unnoticed. It
-- stops being invisible the moment the statement is derived from the ledger:
-- the two would report different net profits for the same month, and the one
-- built on the books would be the optimistic one.
--
-- They are accrued rather than paid: the sale is posted when the goods go, and
-- the transporter is paid separately, so the credit is a payable.

INSERT INTO chart_of_accounts (org_id, code, name, account_class, is_group, is_system)
SELECT o.id, '5300', 'Selling expenses', 'EXPENSE', false, true
  FROM organizations o
ON CONFLICT (org_id, code) DO NOTHING;

UPDATE chart_of_accounts child
   SET parent_id = parent.id
  FROM chart_of_accounts parent
 WHERE parent.org_id = child.org_id
   AND parent.is_group
   AND parent.code = '5000'
   AND child.code = '5300'
   AND child.parent_id IS NULL;

-- Backfill the sales already posted, so the statement does not change meaning
-- at an arbitrary date. Each is dated to its own sale and references it, the
-- way the entry would have been written at the time.
ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_update;

INSERT INTO ledger_entries
  (org_id, entry_date, business_type, coa_id, narration, debit, credit,
   reference_type, reference_id, created_by)
SELECT s.org_id, s.txn_date, 'BULK_CROP', expense.id,
       'Selling expense on ' || s.txn_no,
       s.transport_cost + s.other_cost, 0,
       'crop_sales', s.id, s.created_by
  FROM crop_sales s
  JOIN chart_of_accounts expense ON expense.org_id = s.org_id AND expense.code = '5300'
 WHERE s.status = 'POSTED'
   AND s.transport_cost + s.other_cost > 0
   AND NOT EXISTS (
     SELECT 1 FROM ledger_entries l
      WHERE l.reference_type = 'crop_sales' AND l.reference_id = s.id
        AND l.coa_id = expense.id
   );

INSERT INTO ledger_entries
  (org_id, entry_date, business_type, coa_id, narration, debit, credit,
   reference_type, reference_id, created_by)
SELECT s.org_id, s.txn_date, 'BULK_CROP', payable.id,
       'Accrued selling cost on ' || s.txn_no,
       0, s.transport_cost + s.other_cost,
       'crop_sales', s.id, s.created_by
  FROM crop_sales s
  JOIN chart_of_accounts payable ON payable.org_id = s.org_id AND payable.code = '2100'
  JOIN chart_of_accounts expense ON expense.org_id = s.org_id AND expense.code = '5300'
 WHERE s.status = 'POSTED'
   AND s.transport_cost + s.other_cost > 0
   AND NOT EXISTS (
     SELECT 1 FROM ledger_entries l
      WHERE l.reference_type = 'crop_sales' AND l.reference_id = s.id
        AND l.narration LIKE 'Accrued selling cost%'
   );

ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_update;
