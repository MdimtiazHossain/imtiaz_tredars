-- setup.sql — run ONCE as a PostgreSQL superuser to create the role and
-- databases the application uses. Nothing here is run by the app itself.
--
-- On Windows, from an elevated prompt:
--   "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -f server/db/setup.sql
--
-- Replace the password below before running, then put the same value into
-- server/.env. The application never runs as a superuser.

CREATE ROLE business_suite WITH LOGIN PASSWORD 'change-this-password';

CREATE DATABASE business_suite      OWNER business_suite;
CREATE DATABASE business_suite_test OWNER business_suite;

-- The app owns its own schema, so migrations can create and drop objects.
\connect business_suite
GRANT ALL ON SCHEMA public TO business_suite;
ALTER SCHEMA public OWNER TO business_suite;

\connect business_suite_test
GRANT ALL ON SCHEMA public TO business_suite;
ALTER SCHEMA public OWNER TO business_suite;
