-- Cash and bank accounts and expense categories were the remaining reference
-- data that could only be read. Opening a new bank account or adding a spending
-- category meant an INSERT by hand.
--
-- Both are read under permissions that already exist -- payment.view for
-- accounts, expense.view for categories -- so only the write codes are new.

INSERT INTO permissions (code, description) VALUES
  ('account.create',          'Create cash and bank accounts'),
  ('account.edit',            'Edit cash and bank accounts'),
  ('account.delete',          'Close cash and bank accounts'),
  ('expense.category.create', 'Create expense categories'),
  ('expense.category.edit',   'Edit expense categories'),
  ('expense.category.delete', 'Retire expense categories')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Admin'
ON CONFLICT DO NOTHING;

-- Accounts already records the payments and expenses that move through these,
-- so it maintains them. Closing an account stays with Admin, in line with the
-- other masters.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Accounts'
   AND p.code IN ('account.create', 'account.edit',
                  'expense.category.create', 'expense.category.edit')
ON CONFLICT DO NOTHING;
