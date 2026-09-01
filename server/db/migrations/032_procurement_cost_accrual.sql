-- 032_procurement_cost_accrual.sql — stop crediting the farmer with the freight.
--
-- A crop purchase carries the goods and the cost of bringing them in: transport,
-- loading, unloading and whatever else the truckload cost. All of it is landed
-- cost, and all of it belongs in the value of the batch -- that part was right.
--
-- What was wrong is who the whole of it was owed to. The payable was raised for
-- the landed total against the farmer, so a farmer who sold 100 MT for
-- 30,00,000 was shown as owed 30,70,000. Pay them what they are actually due
-- and 70,000 stays open against their name for ever, on their statement, in the
-- payables ageing, and in every total built on it.
--
-- The goods are owed to the farmer. The carriage is owed to whoever carried it,
-- and until they bill for it that is an accrual rather than anybody's account.
-- The two are now credited separately; inventory is unchanged, because what the
-- crop cost the business has not changed.

INSERT INTO chart_of_accounts (org_id, code, name, account_class, is_group, is_system)
SELECT o.id, '2300', 'Accrued procurement costs', 'LIABILITY', false, true
  FROM organizations o
ON CONFLICT (org_id, code) DO NOTHING;

-- Sit it under Liabilities, the way installChartOfAccounts does.
UPDATE chart_of_accounts child
   SET parent_id = parent.id
  FROM chart_of_accounts parent
 WHERE parent.org_id = child.org_id
   AND parent.is_group
   AND parent.code = '2000'
   AND child.code = '2300'
   AND child.parent_id IS NULL;
