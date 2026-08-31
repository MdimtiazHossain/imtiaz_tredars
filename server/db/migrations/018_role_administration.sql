-- 018_role_administration.sql — roles stop being fixed at install time.
--
-- The permission model was real from the start: `roles`, `permissions`,
-- `role_permissions` and `user_roles` are joined on every request, so the API
-- has always refused what a role does not hold. What was missing was any way to
-- change it. The six roles and their grants were written once by the seed
-- script, and after that the only way to give the accounts officer the right to
-- record an expense was an INSERT by hand -- the same thing that was wrong with
-- the master data before it got its screens.
--
-- This migration adds what administration needs: a flag marking the roles the
-- system depends on, the two permissions that govern role and user-account
-- maintenance, and a record of when a role was last changed.

-- --------------------------------------------------------------- system roles

-- The seeded roles are referenced by the sign-in path and by every screen that
-- reads `user.role`, so they can be re-granted and described but not deleted.
-- Roles added afterwards are ordinary rows and can be removed once no user
-- holds them.
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS is_system  boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE roles SET is_system = true
 WHERE code IN ('Admin', 'Management', 'Sales', 'Purchase', 'Accounts', 'Warehouse');

CREATE TRIGGER roles_touch BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A role's name is what the Employees screen and the sign-in header print, so
-- two roles cannot share one.
CREATE UNIQUE INDEX IF NOT EXISTS roles_name_key ON roles (lower(name));

-- ----------------------------------------------------------- new permissions

-- Changing who may do what, and maintaining the logins that hold those roles,
-- are two distinct powers and neither belongs to everyone who can read the
-- Settings screen: `settings.view` is held by Management so a director can see
-- how the system is set up, and seeing it is not the same as re-cutting it.
INSERT INTO permissions (code, description) VALUES
  ('role.edit',   'Create roles and change what they may do'),
  ('user.manage', 'Create logins, assign roles and reset passwords')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Admin'
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------ user accounts

-- Who created a login, and when it was last touched, is the first question
-- asked when an account turns up that nobody remembers setting up.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES users(id);

-- One employee, one login. The employee retirement blocker already assumes
-- this -- it refuses while "the user account" is active, singular -- and two
-- logins for one person would make the role shown on the Employees screen a
-- coin toss between them.
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_key
  ON users (employee_id) WHERE employee_id IS NOT NULL;
