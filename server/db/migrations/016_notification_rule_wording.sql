-- 016_notification_rule_wording.sql — say where the number goes.
--
-- The descriptions written in 015 assumed the threshold would be printed in
-- front of them, which reads for one rule and not for the next: "2 days before
-- the due date" is a sentence, "60 crop batch older than this many days" is
-- not. Marking the place the value belongs lets each rule read properly with
-- whatever figure it is currently set to.

UPDATE notification_rules SET description = 'fires {value} days before the due date'
 WHERE code = 'SUPPLIER_DUE';

UPDATE notification_rules SET description = 'a crop batch still held after {value} days'
 WHERE code = 'DEAD_STOCK';

UPDATE notification_rules SET description = 'any single transaction above {value}'
 WHERE code = 'LARGE_TRANSACTION';

UPDATE notification_rules SET description = 'an expense above {value}'
 WHERE code = 'EXPENSE_THRESHOLD';
