-- 024_trading_views_net_of_returns.sql — stop reporting sales that came back.
--
-- `v_sales_by_business` and `v_purchases_by_business` read the posted document
-- tables, which is everything the business did until returns existed. A return
-- does not change the invoice it came from -- that is the whole point of it,
-- and why it is a document of its own -- so a dashboard built on those views
-- would keep reporting revenue and profit the business has since given back.
--
-- The profit and loss reads the journal and already nets returns off, so the
-- two would disagree by exactly the value of every return ever posted. Fixing
-- it in the views rather than at each caller means the dashboard, the monthly
-- trend and every report over these views become correct together.
--
-- Returns carry a negative sign here rather than a document count: a return is
-- not a sale, and counting it as one would make "42 invoices this month" mean
-- something nobody asked for.

DROP VIEW v_sales_by_business;
DROP VIEW v_purchases_by_business;

CREATE VIEW v_sales_by_business AS
SELECT org_id, business_type, txn_date,
       SUM(net_amount)   AS sales_amount,
       SUM(cost_amount)  AS cost_amount,
       SUM(profit_amount) AS profit_amount,
       COUNT(*)::bigint  AS document_count
FROM dealer_sales
WHERE status = 'POSTED'
GROUP BY org_id, business_type, txn_date
UNION ALL
SELECT org_id, business_type, txn_date,
       SUM(net_amount)   AS sales_amount,
       SUM(cogs_amount)  AS cost_amount,
       SUM(profit_amount) AS profit_amount,
       COUNT(*)::bigint  AS document_count
FROM crop_sales
WHERE status = 'POSTED'
GROUP BY org_id, business_type, txn_date
UNION ALL
-- Goods that came back: the revenue is reversed and so is the cost, so the
-- profit given up is the difference between them.
SELECT org_id, business_type, txn_date,
       -SUM(net_amount)                 AS sales_amount,
       -SUM(cost_amount)                AS cost_amount,
       -SUM(net_amount - cost_amount)   AS profit_amount,
       0::bigint                        AS document_count
FROM returns
WHERE status = 'POSTED'
  AND source_type IN ('dealer_sales', 'crop_sales')
GROUP BY org_id, business_type, txn_date
UNION ALL
-- Notes with no goods behind them. A credit note is revenue given up with no
-- cost coming back, so all of it is profit forgone; a debit note from a
-- supplier is cost given back, so all of it is profit recovered.
SELECT org_id, business_type, note_date AS txn_date,
       -SUM(amount) FILTER (WHERE note_type = 'CREDIT')  AS sales_amount,
       -SUM(amount) FILTER (WHERE note_type = 'DEBIT')   AS cost_amount,
       -COALESCE(SUM(amount) FILTER (WHERE note_type = 'CREDIT'), 0)
       + COALESCE(SUM(amount) FILTER (WHERE note_type = 'DEBIT'), 0) AS profit_amount,
       0::bigint AS document_count
FROM credit_notes
WHERE status = 'POSTED' AND return_id IS NULL
GROUP BY org_id, business_type, note_date;

COMMENT ON VIEW v_sales_by_business IS
  'Trading result per business line per day: invoices posted, less what came '
  'back on a return and less any note raised without goods. Reconciles with '
  'the profit and loss, which reads the same events from the journal.';

CREATE VIEW v_purchases_by_business AS
SELECT org_id, business_type, txn_date,
       SUM(net_amount) AS purchase_amount,
       COUNT(*)::bigint AS document_count
FROM dealer_purchases
WHERE status = 'POSTED'
GROUP BY org_id, business_type, txn_date
UNION ALL
SELECT org_id, business_type, txn_date,
       SUM(net_amount) AS purchase_amount,
       COUNT(*)::bigint AS document_count
FROM crop_purchases
WHERE status = 'POSTED'
GROUP BY org_id, business_type, txn_date
UNION ALL
SELECT org_id, business_type, txn_date,
       -SUM(net_amount) AS purchase_amount,
       0::bigint        AS document_count
FROM returns
WHERE status = 'POSTED'
  AND source_type IN ('dealer_purchases', 'crop_purchases')
GROUP BY org_id, business_type, txn_date;

COMMENT ON VIEW v_purchases_by_business IS
  'What was bought per business line per day, less what was sent back.';
