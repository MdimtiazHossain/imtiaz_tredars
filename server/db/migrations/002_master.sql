-- 002_master.sql — master data: parties, products, crops and finance lookups.

-- ------------------------------------------------------------------ lookups

CREATE TABLE units (
  id           bigserial PRIMARY KEY,
  code         text        NOT NULL UNIQUE,
  name         text        NOT NULL,
  base_unit_id bigint      REFERENCES units(id),
  -- How many base units one of this unit represents (1 MT = 1000 kg).
  factor       numeric(18,6) NOT NULL DEFAULT 1,
  is_active    boolean     NOT NULL DEFAULT true,
  CHECK (factor > 0),
  CHECK (base_unit_id IS NULL OR base_unit_id <> id)
);

CREATE TABLE product_categories (
  id        bigserial PRIMARY KEY,
  name      text    NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE brands (
  id        bigserial PRIMARY KEY,
  name      text    NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE crop_grades (
  id        bigserial PRIMARY KEY,
  code      text    NOT NULL UNIQUE,
  name      text    NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE expense_categories (
  id        bigserial PRIMARY KEY,
  code      text    NOT NULL UNIQUE,
  name      text    NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

-- ----------------------------------------------------------------- products

CREATE TABLE products (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  code           text        NOT NULL,
  name           text        NOT NULL,
  category_id    bigint      REFERENCES product_categories(id),
  brand_id       bigint      REFERENCES brands(id),
  unit_id        bigint      NOT NULL REFERENCES units(id),
  purchase_rate  numeric(18,2) NOT NULL DEFAULT 0,
  sale_rate      numeric(18,2) NOT NULL DEFAULT 0,
  min_stock      numeric(18,3) NOT NULL DEFAULT 0,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (purchase_rate >= 0 AND sale_rate >= 0 AND min_stock >= 0)
);

CREATE TABLE crops (
  id              bigserial PRIMARY KEY,
  org_id          bigint      NOT NULL REFERENCES organizations(id),
  code            text        NOT NULL,
  name            text        NOT NULL,
  default_unit_id bigint      NOT NULL REFERENCES units(id),
  -- Last known market rate, used to flag a purchase priced above the market.
  last_rate       numeric(18,2) NOT NULL DEFAULT 0,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (last_rate >= 0)
);

-- ------------------------------------------------------------------ parties

CREATE TABLE customers (
  id              bigserial PRIMARY KEY,
  org_id          bigint      NOT NULL REFERENCES organizations(id),
  code            text        NOT NULL,
  name            text        NOT NULL,
  name_bn         text,
  customer_type   text        NOT NULL DEFAULT 'Dealer',
  contact_person  text,
  mobile          text        NOT NULL,
  district        text,
  upazila         text,
  credit_limit    numeric(18,2) NOT NULL DEFAULT 0,
  credit_days     integer     NOT NULL DEFAULT 0,
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  is_active       boolean     NOT NULL DEFAULT true,
  created_by      bigint      REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint      REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (credit_limit >= 0 AND credit_days >= 0)
);

-- One mobile number identifies one active customer; prevents duplicate masters.
CREATE UNIQUE INDEX customers_org_mobile_active
  ON customers (org_id, mobile) WHERE is_active;

CREATE TABLE suppliers (
  id              bigserial PRIMARY KEY,
  org_id          bigint      NOT NULL REFERENCES organizations(id),
  code            text        NOT NULL,
  name            text        NOT NULL,
  name_bn         text,
  supplier_type   text        NOT NULL DEFAULT 'Farmer',
  mobile          text        NOT NULL,
  district        text,
  upazila         text,
  bank_account    text,
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  is_active       boolean     NOT NULL DEFAULT true,
  created_by      bigint      REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint      REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE UNIQUE INDEX suppliers_org_mobile_active
  ON suppliers (org_id, mobile) WHERE is_active;

-- Counterparty companies: principals we buy dealer stock from, and buyer
-- companies we sell bulk crop to. One company may act as both.
CREATE TABLE companies (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  code           text        NOT NULL,
  name           text        NOT NULL,
  role           company_role NOT NULL,
  contact_person text,
  mobile         text,
  district       text,
  credit_limit   numeric(18,2) NOT NULL DEFAULT 0,
  credit_days    integer     NOT NULL DEFAULT 0,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (credit_limit >= 0 AND credit_days >= 0)
);

-- ------------------------------------------------------------------ finance

CREATE TABLE accounts (
  id              bigserial PRIMARY KEY,
  org_id          bigint      NOT NULL REFERENCES organizations(id),
  code            text        NOT NULL,
  name            text        NOT NULL,
  account_type    account_type NOT NULL,
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE payment_methods (
  id         bigserial PRIMARY KEY,
  org_id     bigint  NOT NULL REFERENCES organizations(id),
  code       text    NOT NULL,
  name       text    NOT NULL,
  account_id bigint  REFERENCES accounts(id),
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, code)
);

CREATE TRIGGER products_touch BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER crops_touch BEFORE UPDATE ON crops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
