-- 028_pricing_basis_per_side.sql — quote one way, buy another.
--
-- Whether a rate includes VAT was one flag for the whole organisation, which
-- assumed both sides of the trade quote the same way. They do not. This
-- business sells to dealers at a price that already contains the tax -- what
-- the dealer hands over is what is on the invoice -- and buys from principals
-- at a price before it, with the VAT added on their challanpatra.
--
-- Under one flag that is unresolvable: set it and every supplier invoice is
-- read as 13% cheaper than it is, clear it and every sale under-charges. The
-- basis is a property of the side, so it becomes two.
--
-- The existing value carries over to the sales side, because that is what it
-- was set for, and the purchase side starts where it always effectively was:
-- prices before tax, VAT added on top.

ALTER TABLE organizations RENAME COLUMN prices_include_tax TO sale_prices_include_tax;

ALTER TABLE organizations
  ADD COLUMN purchase_prices_include_tax boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.sale_prices_include_tax IS
  'Whether a rate on a sale is what the customer pays, tax inside it. '
  'Ordinary in Bangladeshi retail.';
COMMENT ON COLUMN organizations.purchase_prices_include_tax IS
  'Whether a rate on a purchase already contains the supplier''s VAT. '
  'Between businesses it usually does not; the challanpatra adds it.';
