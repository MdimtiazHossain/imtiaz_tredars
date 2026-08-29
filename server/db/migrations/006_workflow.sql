-- 006_workflow.sql — approval engine, audit trail and document numbering.

-- --------------------------------------------------------------- approvals

-- Configurable thresholds. `entity_type` names the document, `condition_type`
-- names what is compared, and `threshold` is the limit above which approval is
-- required. Rules are data, so limits change without a deployment.
CREATE TABLE approval_rules (
  id             bigserial PRIMARY KEY,
  org_id         bigint      NOT NULL REFERENCES organizations(id),
  code           text        NOT NULL,
  name           text        NOT NULL,
  entity_type    text        NOT NULL,
  business_type  business_type,
  condition_type text        NOT NULL,
  threshold      numeric(18,4),
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CHECK (condition_type IN ('AMOUNT_ABOVE', 'DISCOUNT_PCT_ABOVE', 'ALWAYS')),
  CHECK (condition_type = 'ALWAYS' OR threshold IS NOT NULL)
);

CREATE TABLE approvals (
  id            bigserial PRIMARY KEY,
  org_id        bigint      NOT NULL REFERENCES organizations(id),
  request_no    text        NOT NULL,
  entity_type   text        NOT NULL,
  entity_id     bigint      NOT NULL,
  business_type business_type,
  rule_id       bigint      REFERENCES approval_rules(id),
  reference_no  text,
  party_name    text,
  amount        numeric(18,2),
  reason        text        NOT NULL,
  status        approval_status NOT NULL DEFAULT 'PENDING',
  requested_by  bigint      NOT NULL REFERENCES users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    bigint      REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, request_no)
);

-- One open request per document: two users cannot race the same approval.
CREATE UNIQUE INDEX approvals_one_pending_per_entity
  ON approvals (entity_type, entity_id) WHERE status = 'PENDING';

CREATE INDEX approvals_pending ON approvals (org_id, requested_at)
  WHERE status = 'PENDING';

CREATE TABLE approval_actions (
  id              bigserial PRIMARY KEY,
  approval_id     bigint      NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  user_id         bigint      NOT NULL REFERENCES users(id),
  action          text        NOT NULL,
  comment         text,
  previous_status approval_status NOT NULL,
  new_status      approval_status NOT NULL,
  acted_at        timestamptz NOT NULL DEFAULT now(),
  ip              inet,
  user_agent      text,
  CHECK (action IN ('SUBMIT', 'APPROVE', 'REJECT', 'CANCEL', 'COMMENT'))
);

CREATE INDEX approval_actions_approval ON approval_actions (approval_id, acted_at);

-- --------------------------------------------------------------- audit trail

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  org_id      bigint      NOT NULL REFERENCES organizations(id),
  user_id     bigint      REFERENCES users(id),
  entity_type text        NOT NULL,
  entity_id   bigint,
  action      text        NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  -- Human-readable summary so the audit screen does not have to diff jsonb.
  summary     text,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_entity ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_user   ON audit_logs (user_id, created_at DESC);
CREATE INDEX audit_logs_recent ON audit_logs (org_id, created_at DESC);

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_append_only();
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION guard_ledger_append_only();

-- --------------------------------------------------------- document numbers

-- Gapless per-period counters. Callers take the number with a single
-- UPDATE ... RETURNING inside their transaction, which serialises concurrent
-- allocations on the row lock and makes duplicate numbers impossible.
CREATE TABLE document_sequences (
  id        bigserial PRIMARY KEY,
  org_id    bigint  NOT NULL REFERENCES organizations(id),
  doc_type  text    NOT NULL,
  prefix    text    NOT NULL,
  period    text    NOT NULL,
  next_value integer NOT NULL DEFAULT 1,
  padding   integer NOT NULL DEFAULT 3,
  UNIQUE (org_id, doc_type, period),
  CHECK (next_value > 0),
  CHECK (padding BETWEEN 1 AND 10)
);

-- Returns the next document number, e.g. PC-2608-014, and advances the counter.
CREATE OR REPLACE FUNCTION next_document_no(
  p_org_id   bigint,
  p_doc_type text,
  p_prefix   text,
  p_period   text,
  p_padding  integer DEFAULT 3
) RETURNS text AS $$
DECLARE
  v_value integer;
BEGIN
  INSERT INTO document_sequences (org_id, doc_type, prefix, period, next_value, padding)
  VALUES (p_org_id, p_doc_type, p_prefix, p_period, 1, p_padding)
  ON CONFLICT (org_id, doc_type, period) DO NOTHING;

  UPDATE document_sequences
     SET next_value = next_value + 1
   WHERE org_id = p_org_id AND doc_type = p_doc_type AND period = p_period
  RETURNING next_value - 1 INTO v_value;

  RETURN p_prefix || '-' || p_period || '-' || lpad(v_value::text, p_padding, '0');
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_rules_touch BEFORE UPDATE ON approval_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER approvals_touch BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
