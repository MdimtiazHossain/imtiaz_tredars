-- 001_core.sql — extensions, enumerated types, organisation and access control.
--
-- Naming: every table carries a surrogate `id`, a business-visible `code` where
-- users refer to the record, and created/updated stamps. Money is numeric(18,2)
-- and quantity numeric(18,3); never float, which cannot represent taka exactly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- enumerations

CREATE TYPE business_type AS ENUM ('DEALER', 'BULK_CROP');

CREATE TYPE transaction_status AS ENUM (
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'POSTED',
  'CANCELLED'
);

CREATE TYPE movement_type AS ENUM (
  'PURCHASE',
  'SALE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'RETURN_IN',
  'RETURN_OUT'
);

CREATE TYPE stock_item_type AS ENUM ('PRODUCT', 'CROP_BATCH');
CREATE TYPE party_type      AS ENUM ('CUSTOMER', 'SUPPLIER', 'COMPANY');
CREATE TYPE payment_direction AS ENUM ('RECEIPT', 'PAYMENT');
CREATE TYPE account_type    AS ENUM ('CASH', 'BANK', 'MFS');
CREATE TYPE approval_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE company_role    AS ENUM ('PRINCIPAL', 'SUPPLIER', 'BUYER', 'SUPPLIER_AND_BUYER');

-- Shared trigger: keep `updated_at` honest without trusting the application.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------- organisation

-- The operating business itself. Single row in practice, but modelled as a
-- table so a second trading entity does not require a schema change.
CREATE TABLE organizations (
  id              bigserial PRIMARY KEY,
  code            text        NOT NULL UNIQUE,
  name            text        NOT NULL,
  system_name     text        NOT NULL DEFAULT 'Business Suite',
  trade_licence_no text,
  bin_no          text,
  head_office     text,
  mobile          text,
  email           text,
  currency_code   text        NOT NULL DEFAULT 'BDT',
  default_district text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fiscal_years (
  id          bigserial PRIMARY KEY,
  org_id      bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code        text        NOT NULL,
  starts_on   date        NOT NULL,
  ends_on     date        NOT NULL,
  is_current  boolean     NOT NULL DEFAULT false,
  is_closed   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (ends_on > starts_on)
);

-- Only one fiscal year may be current per organisation.
CREATE UNIQUE INDEX fiscal_years_one_current
  ON fiscal_years (org_id) WHERE is_current;

-- Reference table so business type is joinable and labelled, while the enum
-- keeps transactional columns compact and constrained.
CREATE TABLE business_types (
  code        business_type PRIMARY KEY,
  name        text        NOT NULL,
  description text
);

CREATE TABLE warehouses (
  id         bigserial PRIMARY KEY,
  org_id     bigint      NOT NULL REFERENCES organizations(id),
  code       text        NOT NULL,
  name       text        NOT NULL,
  district   text,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE departments (
  id     bigserial PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES organizations(id),
  name   text   NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE employees (
  id            bigserial PRIMARY KEY,
  org_id        bigint      NOT NULL REFERENCES organizations(id),
  code          text        NOT NULL,
  name          text        NOT NULL,
  designation   text,
  department_id bigint      REFERENCES departments(id),
  mobile        text,
  joined_on     date,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

-- ------------------------------------------------------------- access control

CREATE TABLE roles (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text
);

CREATE TABLE permissions (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  description text
);

CREATE TABLE role_permissions (
  role_id       bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id bigint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  employee_id    bigint      REFERENCES employees(id),
  username       text        NOT NULL UNIQUE,
  email          text        UNIQUE,
  password_hash  text        NOT NULL,
  is_active      boolean     NOT NULL DEFAULT true,
  must_change_pw boolean     NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (length(password_hash) > 20)
);

CREATE TABLE user_roles (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Refresh/session tokens are stored hashed so a database leak cannot be
-- replayed against the API.
CREATE TABLE user_sessions (
  id            bigserial PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text        NOT NULL UNIQUE,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text
);

CREATE INDEX user_sessions_user ON user_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER warehouses_touch BEFORE UPDATE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
