-- Payment methods were the last reference table with no way to maintain them.
-- The Settings screen has shown them with an on/off switch since the design was
-- imported, but the switch was a picture: the list was hard-coded in the
-- frontend and nothing behind it could be changed.
--
-- Reading stays under payment.view, which already covers the accounts these
-- methods pay into.

INSERT INTO permissions (code, description) VALUES
  ('payment.method.create', 'Create payment methods'),
  ('payment.method.edit',   'Edit and restore payment methods'),
  ('payment.method.delete', 'Retire payment methods')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Admin'
ON CONFLICT DO NOTHING;

-- Accounts maintains the cash and bank accounts these methods pay into, so it
-- maintains the methods too. Retiring one stays with Admin.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Accounts'
   AND p.code IN ('payment.method.create', 'payment.method.edit')
ON CONFLICT DO NOTHING;
