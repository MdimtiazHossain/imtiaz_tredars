-- Master data could be listed but barely maintained: customers could be created
-- and edited, suppliers only created, and companies and crops not managed at
-- all. Adding a crop meant an INSERT by hand, which is not a thing an operator
-- can be asked to do.
--
-- These are the permission codes the new master routes declare. Every route
-- checks one of them, so a role without the code is refused by the server and
-- not merely hidden in the UI.

INSERT INTO permissions (code, description) VALUES
  ('customer.delete', 'Deactivate customers'),
  ('supplier.edit',   'Edit suppliers'),
  ('supplier.delete', 'Deactivate suppliers'),
  ('company.create',  'Create companies'),
  ('company.edit',    'Edit companies'),
  ('company.delete',  'Deactivate companies'),
  ('crop.view',       'View crops'),
  ('crop.create',     'Create crops'),
  ('crop.edit',       'Edit crops'),
  ('crop.delete',     'Deactivate crops'),
  ('product.create',  'Create products'),
  ('product.edit',    'Edit products'),
  ('product.delete',  'Deactivate products')
ON CONFLICT (code) DO NOTHING;

-- Admin keeps every permission, as it does for all the others.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Admin'
ON CONFLICT DO NOTHING;

-- Everyone who can already see stock can see the crop list: a crop name is not
-- sensitive, and a warehouse hand reading a batch needs to know what it holds.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code IN ('Management', 'Sales', 'Purchase', 'Accounts', 'Warehouse')
   AND p.code = 'crop.view'
ON CONFLICT DO NOTHING;

-- Purchase already creates suppliers, so it maintains the rest of the
-- procurement master: editing a supplier, and the companies and crops that
-- purchases are booked against.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Purchase'
   AND p.code IN ('supplier.edit', 'company.create', 'company.edit',
                  'crop.create', 'crop.edit', 'product.create', 'product.edit')
ON CONFLICT DO NOTHING;

-- Deactivation stays with Admin. Retiring a party or a crop changes what every
-- other screen offers, and it is the one master-data action that is not
-- obviously reversible from the operator's seat.
