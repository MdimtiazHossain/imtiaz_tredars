-- 033_unapplied_credit_in_balances.sql — money received is money received.
--
-- A payment can be tied to particular invoices, and whatever is left over stays
-- on account: the payment screen says so, and a clerk taking 10,000 from a
-- customer who has not said which invoice it settles produces exactly that.
--
-- Only the allocated part ever reached these views. The general ledger was
-- always right -- the receipt credits Accounts receivable whether or not it was
-- matched to an invoice -- but everything built on the `receivables` and
-- `payables` subledgers ignored the rest. One receipt of 10,000 against a
-- 26,000 invoice therefore produced a customer who owed 16,000 on their own
-- ledger statement and 26,000 everywhere else: on the customers list, in the
-- ageing, on the collect-from list, and on the dashboard, which then disagreed
-- with the general ledger by the same amount.
--
-- So the unapplied part is netted here, once, and every reader inherits it.
--
-- Against individual invoices the credit is applied oldest due first, which is
-- what a clerk would do with it and what makes the ageing read as the debt that
-- is genuinely still outstanding rather than the debt before the money arrived.
-- A credit larger than everything open simply clears the lot; the party then
-- has a credit balance, which the outstanding views report as a negative and
-- the ageing correctly shows nothing for.

-- Money in hand that has not been matched to an invoice. A receipt reduces what
-- a party owes us; a payment reduces what we owe them. Cancelled payments are
-- not money.
--
-- The business line is carried through because the dashboard slices by it, and
-- All has to be the sum of Dealer and Bulk Crop. Subtracting the whole credit
-- from each slice would make the two lines come to less than the total.
CREATE VIEW v_unapplied_payments AS
SELECT org_id,
       party_type,
       party_id,
       direction,
       business_type,
       SUM(unallocated_amount) AS amount
  FROM payments
 WHERE status = 'POSTED'
   AND unallocated_amount > 0
 GROUP BY org_id, party_type, party_id, direction, business_type;

-- The same money rolled up per party, for the readers that ask what one
-- customer owes rather than what one business line is owed. Joining the sliced
-- view directly would return a party twice when they have paid on account in
-- both lines, and double every balance built on it.
CREATE VIEW v_unapplied_by_party AS
SELECT org_id, party_type, party_id, direction, SUM(amount) AS amount
  FROM v_unapplied_payments
 GROUP BY org_id, party_type, party_id, direction;

/* ------------------------------------------------------------- balances */

DROP VIEW v_customer_outstanding;

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
  -- What the customer has actually paid, matched or not.
  COALESCE(r.collected, 0) + COALESCE(u.amount, 0) AS collected_amount,
  c.opening_balance + COALESCE(r.balance, 0) - COALESCE(u.amount, 0) AS outstanding
FROM customers c
LEFT JOIN (
  SELECT party_id,
         SUM(invoice_amount) AS invoiced,
         SUM(paid_amount)    AS collected,
         SUM(balance)        AS balance
  FROM receivables
  WHERE party_type = 'CUSTOMER'
  GROUP BY party_id
) r ON r.party_id = c.id
LEFT JOIN v_unapplied_by_party u
       ON u.party_type = 'CUSTOMER' AND u.party_id = c.id
      AND u.direction = 'RECEIPT' AND u.org_id = c.org_id;

DROP VIEW v_supplier_outstanding;

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
  COALESCE(p.paid, 0) + COALESCE(u.amount, 0) AS paid_amount,
  s.opening_balance + COALESCE(p.balance, 0) - COALESCE(u.amount, 0) AS outstanding
FROM suppliers s
LEFT JOIN (
  SELECT party_id,
         SUM(invoice_amount) AS billed,
         SUM(paid_amount)    AS paid,
         SUM(balance)        AS balance
  FROM payables
  WHERE party_type = 'SUPPLIER'
  GROUP BY party_id
) p ON p.party_id = s.id
LEFT JOIN v_unapplied_by_party u
       ON u.party_type = 'SUPPLIER' AND u.party_id = s.id
      AND u.direction = 'PAYMENT' AND u.org_id = s.org_id;

/* --------------------------------------------------------------- ageing */

DROP VIEW v_receivable_aging;

CREATE VIEW v_receivable_aging AS
WITH open_invoices AS (
  SELECT r.*,
         -- Everything owed by this party up to and including this invoice,
         -- oldest first: the point at which an on-account credit runs out.
         SUM(r.balance) OVER (
           PARTITION BY r.org_id, r.party_type, r.party_id
           ORDER BY r.due_date, r.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS running_balance
    FROM receivables r
   WHERE NOT r.is_settled AND r.balance > 0
),
applied AS (
  SELECT o.*,
         GREATEST(0, LEAST(o.balance, o.running_balance - COALESCE(u.amount, 0)))
           AS net_balance
    FROM open_invoices o
    LEFT JOIN v_unapplied_by_party u
           ON u.org_id = o.org_id AND u.party_type = o.party_type
          AND u.party_id = o.party_id AND u.direction = 'RECEIPT'
)
SELECT
  a.org_id,
  a.party_type,
  a.party_id,
  a.business_type,
  a.invoice_type,
  a.invoice_id,
  a.invoice_no,
  a.invoice_date,
  a.due_date,
  a.invoice_amount,
  a.paid_amount,
  a.net_balance AS balance,
  GREATEST(0, (CURRENT_DATE - a.due_date))::int AS days_overdue,
  CASE
    WHEN CURRENT_DATE - a.due_date <=  30 THEN '0-30'
    WHEN CURRENT_DATE - a.due_date <=  60 THEN '31-60'
    WHEN CURRENT_DATE - a.due_date <=  90 THEN '61-90'
    WHEN CURRENT_DATE - a.due_date <= 120 THEN '91-120'
    ELSE '120+'
  END AS aging_bucket
FROM applied a
WHERE a.net_balance > 0;

DROP VIEW v_payable_aging;

CREATE VIEW v_payable_aging AS
WITH open_bills AS (
  SELECT p.*,
         SUM(p.balance) OVER (
           PARTITION BY p.org_id, p.party_type, p.party_id
           ORDER BY p.due_date, p.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS running_balance
    FROM payables p
   WHERE NOT p.is_settled AND p.balance > 0
),
applied AS (
  SELECT o.*,
         GREATEST(0, LEAST(o.balance, o.running_balance - COALESCE(u.amount, 0)))
           AS net_balance
    FROM open_bills o
    LEFT JOIN v_unapplied_by_party u
           ON u.org_id = o.org_id AND u.party_type = o.party_type
          AND u.party_id = o.party_id AND u.direction = 'PAYMENT'
)
SELECT
  a.org_id,
  a.party_type,
  a.party_id,
  a.business_type,
  a.invoice_type,
  a.invoice_id,
  a.invoice_no,
  a.invoice_date,
  a.due_date,
  a.invoice_amount,
  a.paid_amount,
  a.net_balance AS balance,
  GREATEST(0, (CURRENT_DATE - a.due_date))::int AS days_overdue,
  CASE
    WHEN CURRENT_DATE - a.due_date <=  30 THEN '0-30'
    WHEN CURRENT_DATE - a.due_date <=  60 THEN '31-60'
    WHEN CURRENT_DATE - a.due_date <=  90 THEN '61-90'
    WHEN CURRENT_DATE - a.due_date <= 120 THEN '91-120'
    ELSE '120+'
  END AS aging_bucket
FROM applied a
WHERE a.net_balance > 0;

/* ------------------------------------------------------ party totals */

-- What each party owes or is owed, netting unapplied money, for the readers
-- that work party by party rather than invoice by invoice. Companies sit on
-- both sides of the ledger, so both are reported.
CREATE VIEW v_party_balance AS
SELECT
  b.org_id,
  b.party_type,
  b.party_id,
  SUM(b.receivable) AS receivable,
  SUM(b.payable)    AS payable
FROM (
  SELECT r.org_id, r.party_type, r.party_id, SUM(r.balance) AS receivable, 0 AS payable
    FROM receivables r WHERE NOT r.is_settled GROUP BY 1, 2, 3
  UNION ALL
  SELECT p.org_id, p.party_type, p.party_id, 0, SUM(p.balance)
    FROM payables p WHERE NOT p.is_settled GROUP BY 1, 2, 3
  UNION ALL
  SELECT u.org_id, u.party_type, u.party_id,
         CASE WHEN u.direction = 'RECEIPT' THEN -u.amount ELSE 0 END,
         CASE WHEN u.direction = 'PAYMENT' THEN -u.amount ELSE 0 END
    FROM v_unapplied_by_party u
) b
GROUP BY b.org_id, b.party_type, b.party_id;
