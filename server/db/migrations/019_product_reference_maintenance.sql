-- 019_product_reference_maintenance.sql — product categories and brands become maintainable.
--
-- A product carries a category and a brand, and the form offers whichever ones
-- the catalogue already uses. That works on a database with products in it and
-- is a dead end on one without: the first product has no category to choose,
-- so no product ever gets one, so the list stays empty for good. Neither table
-- had a maintenance route, and the resolver deliberately refuses to invent a
-- brand from a typo -- correctly, but that left nothing able to create one.
--
-- These are the last two reference tables with no way to maintain them.

-- --------------------------------------------------------------------- codes

-- Every other master in this schema carries a business-visible code, and the
-- generated CRUD, the audit trail and the error messages all name records by
-- it. Adding it here is what lets these two go through the same path as
-- expense categories rather than a second implementation beside it.
ALTER TABLE product_categories ADD COLUMN code text;
ALTER TABLE brands            ADD COLUMN code text;

-- Backfill from the name: 'Agrochemical' -> 'AGROCHEMICAL', 'Square' ->
-- 'SQUARE'. Truncated to something that reads on a report, and de-duplicated
-- with the row id where two names shorten to the same thing.
UPDATE product_categories
   SET code = left(regexp_replace(upper(name), '[^A-Z0-9]+', '_', 'g'), 24)
 WHERE code IS NULL;

UPDATE brands
   SET code = left(regexp_replace(upper(name), '[^A-Z0-9]+', '_', 'g'), 24)
 WHERE code IS NULL;

UPDATE product_categories a SET code = a.code || '_' || a.id
 WHERE EXISTS (SELECT 1 FROM product_categories b WHERE b.code = a.code AND b.id < a.id);

UPDATE brands a SET code = a.code || '_' || a.id
 WHERE EXISTS (SELECT 1 FROM brands b WHERE b.code = a.code AND b.id < a.id);

ALTER TABLE product_categories ALTER COLUMN code SET NOT NULL;
ALTER TABLE brands            ALTER COLUMN code SET NOT NULL;

ALTER TABLE product_categories ADD CONSTRAINT product_categories_code_key UNIQUE (code);
ALTER TABLE brands            ADD CONSTRAINT brands_code_key            UNIQUE (code);

-- --------------------------------------------------------------- permissions

INSERT INTO permissions (code, description) VALUES
  ('product.category.create', 'Create product categories'),
  ('product.category.edit',   'Edit and restore product categories'),
  ('product.category.delete', 'Retire product categories'),
  ('brand.create',            'Create brands'),
  ('brand.edit',              'Edit and restore brands'),
  ('brand.delete',            'Retire brands')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Admin'
ON CONFLICT DO NOTHING;

-- Whoever maintains the product catalogue maintains what it is classified by;
-- retiring one stays with Admin, as it does for every other master.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code = 'Purchase'
   AND p.code IN ('product.category.create', 'product.category.edit',
                  'brand.create', 'brand.edit')
ON CONFLICT DO NOTHING;
