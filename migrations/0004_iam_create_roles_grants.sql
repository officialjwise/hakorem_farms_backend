-- 0004_iam_create_roles_grants
-- Roles, the permissions they contain, amount limits, grants by branch and location, and approval policies
-- (docs/data-model/iam.md, ADR-0017). Seeds the ten roles of the shared brief with no permissions: permissions are
-- granted to roles by a later migration, never implicitly.
-- Data category: INTERNAL.

-- migrate:up
CREATE TABLE iam.role (
  id            uuid PRIMARY KEY,
  code          text NOT NULL CONSTRAINT ck_role_code CHECK (code ~ '^[A-Z][A-Z_]{1,39}$'),
  name          text NOT NULL,
  is_system     boolean NOT NULL DEFAULT false,
  requires_totp boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_role_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_role_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_role_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_role_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT ck_role_system_not_deleted CHECK (NOT (is_system AND deleted_at IS NOT NULL))
);
COMMENT ON TABLE iam.role IS 'class=MASTER';
CREATE UNIQUE INDEX uq_role_code ON iam.role (code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_role_version BEFORE UPDATE ON iam.role
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

INSERT INTO iam.role (id, code, name, is_system, requires_totp, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000101', 'OWNER', 'Owner', true, true, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000102', 'MANAGER', 'Manager', true, true, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000103', 'ACCOUNTANT', 'Accountant', true, true, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000104', 'STOREKEEPER', 'Storekeeper', true, false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000105', 'CASHIER', 'Cashier', true, false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000106', 'SALES', 'Sales', true, false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000107', 'FARM_HAND', 'Vet or farm hand', true, false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000108', 'DRIVER', 'Driver', true, false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000109', 'INVESTOR', 'Investor', true, false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000110', 'CUSTOMER', 'Customer', true, false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- Removal of a link is a hard delete, with the before state in the audit log (docs/data-model/iam.md).
CREATE TABLE iam.role_permission (
  role_id         uuid NOT NULL CONSTRAINT fk_role_permission_role REFERENCES iam.role (id) ON DELETE RESTRICT,
  permission_code text NOT NULL CONSTRAINT fk_role_permission_permission REFERENCES iam.permission (code) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL CONSTRAINT fk_role_permission_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_role_permission PRIMARY KEY (role_id, permission_code)
);
COMMENT ON TABLE iam.role_permission IS 'class=MASTER';

CREATE TABLE iam.role_limit (
  role_id        uuid NOT NULL CONSTRAINT fk_role_limit_role REFERENCES iam.role (id) ON DELETE RESTRICT,
  limit_kind     text NOT NULL CONSTRAINT ck_role_limit_kind CHECK (limit_kind IN (
                   'PRICE_OVERRIDE_PER_LINE', 'PRICE_OVERRIDE_PER_SHIFT', 'REFUND_WITHOUT_APPROVAL',
                   'PURCHASE_ORDER_APPROVAL', 'STOCK_ADJUSTMENT_WITHOUT_APPROVAL')),
  amount_pesewas platform.pesewas NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL CONSTRAINT fk_role_limit_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid NOT NULL CONSTRAINT fk_role_limit_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at     timestamptz NULL,
  deleted_by     uuid NULL CONSTRAINT fk_role_limit_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason  text NULL,
  CONSTRAINT pk_role_limit PRIMARY KEY (role_id, limit_kind),
  CONSTRAINT ck_role_limit_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE iam.role_limit IS 'class=MASTER';
CREATE TRIGGER trg_role_limit_version BEFORE UPDATE ON iam.role_limit
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE iam.role_grant (
  id            uuid PRIMARY KEY,
  principal_id  uuid NOT NULL CONSTRAINT fk_role_grant_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  role_id       uuid NOT NULL CONSTRAINT fk_role_grant_role REFERENCES iam.role (id) ON DELETE RESTRICT,
  branch_id     uuid NOT NULL CONSTRAINT fk_role_grant_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  location_id   uuid NULL CONSTRAINT fk_role_grant_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_role_grant_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_role_grant_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_role_grant_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_role_grant_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- No one grants a role to themselves (A-053); seeded grants are made by a SYSTEM principal.
  CONSTRAINT ck_role_grant_not_self CHECK (created_by <> principal_id),
  CONSTRAINT ck_role_grant_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE iam.role_grant IS 'class=MASTER';
CREATE UNIQUE INDEX uq_role_grant_scope ON iam.role_grant (principal_id, role_id, branch_id, location_id) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL;
CREATE INDEX ix_role_grant_principal ON iam.role_grant (principal_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_role_grant_version BEFORE UPDATE ON iam.role_grant
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE iam.approval_policy (
  id                  uuid PRIMARY KEY,
  kind                text NOT NULL CONSTRAINT ck_approval_policy_kind CHECK (kind ~ '^[A-Z][A-Z_]{2,39}$'),
  branch_id           uuid NULL CONSTRAINT fk_approval_policy_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  threshold_pesewas   platform.pesewas NULL,
  approver_permission text NOT NULL CONSTRAINT fk_approval_policy_permission REFERENCES iam.permission (code) ON DELETE RESTRICT,
  requires_evidence   boolean NOT NULL DEFAULT false,
  requires_step_up    boolean NOT NULL DEFAULT false,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_approval_policy_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_approval_policy_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at          timestamptz NULL,
  deleted_by          uuid NULL CONSTRAINT fk_approval_policy_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason       text NULL,
  CONSTRAINT ck_approval_policy_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE iam.approval_policy IS 'class=MASTER';
CREATE UNIQUE INDEX uq_approval_policy_kind_branch ON iam.approval_policy (kind, branch_id) NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE TRIGGER trg_approval_policy_version BEFORE UPDATE ON iam.approval_policy
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

REVOKE ALL ON iam.role, iam.role_permission, iam.role_limit, iam.role_grant, iam.approval_policy FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON iam.role, iam.role_permission, iam.role_limit, iam.role_grant, iam.approval_policy TO hk_app, hk_worker;

-- migrate:down
DROP TABLE iam.approval_policy;
DROP TABLE iam.role_grant;
DROP TABLE iam.role_limit;
DROP TABLE iam.role_permission;
DROP TABLE iam.role;
