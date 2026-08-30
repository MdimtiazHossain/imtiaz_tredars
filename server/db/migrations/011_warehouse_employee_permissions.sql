-- Warehouses and employees were the last two masters that could only be read.
-- A godown could not be opened or closed without an INSERT by hand, and the
-- employee directory was a fixed list in the frontend rather than the table it
-- claimed to show.
--
-- Warehouses keep `inventory.view` for reading -- anyone who can see stock can
-- see the godowns holding it -- and gain their own codes for changing it.

INSERT INTO permissions (code, description) VALUES
  ('warehouse.create', 'Create warehouses'),
  ('warehouse.edit',   'Edit warehouses'),
  ('warehouse.delete', 'Deactivate warehouses'),
  ('employee.create',  'Create employees'),
  ('employee.edit',    'Edit employees'),
  ('employee.delete',  'Deactivate employees')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Admin'
ON CONFLICT DO NOTHING;

-- Opening a godown or hiring someone is a management decision rather than a
-- warehouse-floor or desk-level one, so Management maintains both.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Management'
   AND p.code IN ('warehouse.create', 'warehouse.edit', 'employee.create', 'employee.edit')
ON CONFLICT DO NOTHING;

-- Deactivation stays with Admin, as it does for the other masters: closing a
-- godown or retiring an employee changes what every other screen offers.
