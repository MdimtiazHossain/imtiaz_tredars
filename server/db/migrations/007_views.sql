-- 007_views.sql — derived reads: ledger reconciliation, balances and aging.
--
-- These exist so the maintained running totals can always be checked against
-- the immutable ledgers, and so reporting does not re-implement the same
-- aggregation in a dozen places.

-- Stock rebuilt from the movement ledger alone. Any disagreement with the
-- `stock` table means a bug or a manual edit, and the reconciliation view
-- below surfaces it.
CREATE VIEW v_stock_from_ledger AS
SELECT
  warehouse_id,
  item_type,
  product_id,
  batch_id,
  SUM(quantity_in - quantity_out) AS quantity
FROM stock_movements
GROUP BY warehouse_id, item_type, product_id, batch_id;

CREATE VIEW v_stock_reconciliation AS
SELECT
  COALESCE(s.warehouse_id, l.warehouse_id)   AS warehouse_id,
  COALESCE(s.item_type, l.item_type)         AS item_type,
  COALESCE(s.product_id, l.product_id)       AS product_id,
  COALESCE(s.batch_id, l.batch_id)           AS batch_id,
  COALESCE(s.quantity, 0)                    AS stock_quantity,
  COALESCE(l.quantity, 0)                    AS ledger_quantity,
  COALESCE(s.quantity, 0) - COALESCE(l.quantity, 0) AS difference
FROM stock s
FULL OUTER JOIN v_stock_from_ledger l
  ON  s.warehouse_id = l.warehouse_id
  AND s.item_type    = l.item_type
  AND s.product_id   IS NOT DISTINCT FROM l.product_id
  AND s.batch_id     IS NOT DISTINCT FROM l.batch_id;

-- --------------------------------------------------------------- balances

CREATE VIEW v_customer_outstanding AS
SELECT
  c.id                                   AS customer_id,
  c.org_id,
  c.code,
  c.name,
  c.customer_type,
  c.district,
  c.credit_limit,
  c.credit_days,
  c.opening_balance,
  COALESCE(r.invoiced, 0)                AS invoiced_amount,
  COALESCE(r.collected, 0)               AS collected_amount,
  c.opening_balance + COALESCE(r.balance, 0) AS outstanding
FROM customers c
LEFT JOIN (
  SELECT party_id,
         SUM(invoice_amount) AS invoiced,
         SUM(paid_amount)    AS collected,
         SUM(balance)        AS balance
  FROM receivables
  WHERE party_type = 'CUSTOMER'
  GROUP BY party_id
) r ON r.party_id = c.id;

CREATE VIEW v_supplier_outstanding AS
SELECT
  s.id                                   AS supplier_id,
  s.org_id,
  s.code,
  s.name,
  s.supplier_type,
  s.district,
  s.opening_balance,
  COALESCE(p.billed, 0)                  AS billed_amount,
  COALESCE(p.paid, 0)                    AS paid_amount,
  s.opening_balance + COALESCE(p.balance, 0) AS outstanding
FROM suppliers s
LEFT JOIN (
  SELECT party_id,
         SUM(invoice_amount) AS billed,
         SUM(paid_amount)    AS paid,
         SUM(balance)        AS balance
  FROM payables
  WHERE party_type = 'SUPPLIER'
  GROUP BY party_id
) p ON p.party_id = s.id;

-- ------------------------------------------------------------------ aging

-- Buckets are measured from the due date as at the current date.
CREATE VIEW v_receivable_aging AS
SELECT
  r.org_id,
  r.party_type,
  r.party_id,
  r.business_type,
  r.invoice_type,
  r.invoice_id,
  r.invoice_no,
  r.invoice_date,
  r.due_date,
  r.balance,
  GREATEST(0, (CURRENT_DATE - r.due_date))::int AS days_overdue,
  CASE
    WHEN CURRENT_DATE - r.due_date <=  30 THEN '0-30'
    WHEN CURRENT_DATE - r.due_date <=  60 THEN '31-60'
    WHEN CURRENT_DATE - r.due_date <=  90 THEN '61-90'
    WHEN CURRENT_DATE - r.due_date <= 120 THEN '91-120'
    ELSE '120+'
  END AS aging_bucket
FROM receivables r
WHERE NOT r.is_settled AND r.balance > 0;

CREATE VIEW v_payable_aging AS
SELECT
  p.org_id,
  p.party_type,
  p.party_id,
  p.business_type,
  p.invoice_type,
  p.invoice_id,
  p.invoice_no,
  p.invoice_date,
  p.due_date,
  p.balance,
  GREATEST(0, (CURRENT_DATE - p.due_date))::int AS days_overdue,
  CASE
    WHEN CURRENT_DATE - p.due_date <=  30 THEN '0-30'
    WHEN CURRENT_DATE - p.due_date <=  60 THEN '31-60'
    WHEN CURRENT_DATE - p.due_date <=  90 THEN '61-90'
    WHEN CURRENT_DATE - p.due_date <= 120 THEN '91-120'
    ELSE '120+'
  END AS aging_bucket
FROM payables p
WHERE NOT p.is_settled AND p.balance > 0;

-- ------------------------------------------------- business-type reconciliation

-- One row per business line per day. The dashboard's "All / Dealer / Bulk Crop"
-- filter sums this, which is what makes the frontend and backend totals agree.
CREATE VIEW v_sales_by_business AS
SELECT org_id, business_type, txn_date,
       SUM(net_amount)   AS sales_amount,
       SUM(cost_amount)  AS cost_amount,
       SUM(profit_amount) AS profit_amount,
       COUNT(*)          AS document_count
FROM dealer_sales
WHERE status = 'POSTED'
GROUP BY org_id, business_type, txn_date
UNION ALL
SELECT org_id, business_type, txn_date,
       SUM(net_amount)   AS sales_amount,
       SUM(cogs_amount)  AS cost_amount,
       SUM(profit_amount) AS profit_amount,
       COUNT(*)          AS document_count
FROM crop_sales
WHERE status = 'POSTED'
GROUP BY org_id, business_type, txn_date;

CREATE VIEW v_purchases_by_business AS
SELECT org_id, business_type, txn_date,
       SUM(net_amount) AS purchase_amount,
       COUNT(*)        AS document_count
FROM dealer_purchases
WHERE status = 'POSTED'
GROUP BY org_id, business_type, txn_date
UNION ALL
SELECT org_id, business_type, txn_date,
       SUM(net_amount) AS purchase_amount,
       COUNT(*)        AS document_count
FROM crop_purchases
WHERE status = 'POSTED'
GROUP BY org_id, business_type, txn_date;

-- ---------------------------------------------------- supporting index set

CREATE INDEX dealer_sales_posted    ON dealer_sales (org_id, txn_date)
  WHERE status = 'POSTED';
CREATE INDEX dealer_purchases_posted ON dealer_purchases (org_id, txn_date)
  WHERE status = 'POSTED';
CREATE INDEX crop_sales_posted      ON crop_sales (org_id, txn_date)
  WHERE status = 'POSTED';
CREATE INDEX crop_purchases_posted  ON crop_purchases (org_id, txn_date)
  WHERE status = 'POSTED';

CREATE INDEX dealer_sales_customer  ON dealer_sales (customer_id, txn_date DESC);
CREATE INDEX dealer_purchases_company ON dealer_purchases (company_id, txn_date DESC);
CREATE INDEX crop_purchases_supplier ON crop_purchases (supplier_id, txn_date DESC);
CREATE INDEX crop_sales_buyer       ON crop_sales (buyer_company_id, txn_date DESC);

CREATE INDEX dealer_sale_items_product     ON dealer_sale_items (product_id);
CREATE INDEX dealer_purchase_items_product ON dealer_purchase_items (product_id);
CREATE INDEX crop_purchase_items_crop      ON crop_purchase_items (crop_id);
CREATE INDEX crop_sale_items_crop          ON crop_sale_items (crop_id);

-- Name search on the party masters, for the global search box.
CREATE INDEX customers_name_search ON customers USING gin (to_tsvector('simple', name));
CREATE INDEX suppliers_name_search ON suppliers USING gin (to_tsvector('simple', name));
CREATE INDEX products_name_search  ON products  USING gin (to_tsvector('simple', name));
