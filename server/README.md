# Business Suite API

REST API and PostgreSQL data layer behind the Business Suite frontend. Node 20+,
Express, raw SQL via `pg` — no ORM, so every query and every transaction
boundary is visible in the code.

## First run

**1. Create the role and databases** (once, as a PostgreSQL superuser). Edit the
password in the file first:

```bash
"C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -f server/db/setup.sql
```

**2. Configure the environment.** Copy `.env.example` to `.env` and fill it in.
`.env` is gitignored and must never be committed.

```bash
cp server/.env.example server/.env
```

Generate a signing secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**3. Create the schema and demo data:**

```bash
cd server && npm install && npm run db:setup
```

`db:setup` resets the schema, applies every migration and seeds demo data. It
prints the usernames it created; every account starts with the same password
(`ChangeMe!2026` unless `SEED_PASSWORD` says otherwise) and is flagged
`must_change_pw`.

**4. Run it:**

```bash
cd server && npm run dev
```

Point the frontend at it by setting `VITE_API_URL=http://localhost:5310/api`
in a `.env` at the repository root, then `npm run dev` there. With no
`VITE_API_URL` the frontend runs on its bundled seed data exactly as before.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | API with file watching |
| `npm start` | API, production mode |
| `npm run db:migrate` | apply pending migrations |
| `npm run db:reset` | drop the schema and re-apply everything **(destroys data)** |
| `npm run db:seed` | load demo data |
| `npm run db:setup` | reset then seed |
| `npm test` | unit tests; integration and security tests need a database |
| `npm run lint` | ESLint |

## Architecture

```
db/
  migrations/     numbered SQL, applied in order, checksummed
  seed/seed.mjs   demo data, posted through the real services
  migrate.mjs     migration runner
src/
  lib/            config, pool + transaction helper, errors, validation, audit,
                  document numbering
  middleware/     authentication, permission checks, error envelope
  services/       business logic: inventory, FIFO, finance, approvals,
                  crop/dealer posting, workspace assembly
  routes/         HTTP surface, one file per resource group
```

**Everything that writes runs inside `withTransaction`.** Posting a document
creates the document, moves stock, raises the receivable or payable, writes the
journal rows and records the audit entry as one unit. If any step fails, none
of it happened.

### Invariants worth knowing

- **Stock only moves through `recordMovement`.** There is deliberately no
  function that changes the `stock` table on its own, so the running balance can
  always be rebuilt from `stock_movements`. `v_stock_reconciliation` returns rows
  only when the two disagree; it should always be empty.
- **Posted documents are immutable.** A database trigger diffs the row and
  rejects any change except a cancellation carrying a reason. A second trigger
  refuses to delete anything that reached POSTED. Corrections are cancellations
  plus a new document.
- **FIFO is protected by row locks.** `lockBatchPool` takes `SELECT … FOR UPDATE`
  in a fixed order before reading any quantity, so two simultaneous sales
  serialise instead of both seeing the same availability. The
  `quantity_remaining >= 0` check constraint is the backstop.
- **Document numbers cannot collide.** `next_document_no` takes the counter with
  a single `UPDATE … RETURNING` inside the caller's transaction.
- **Permissions are read per request**, never trusted from the token, so
  revoking a role takes effect immediately.

## API

All responses use one envelope: `{ "data": … }` on success, `{ "error": { code,
message, details? } }` on failure. Lists add `{ "meta": { page, pageSize, total,
totalPages, hasNext, hasPrev } }`.

| Group | Endpoints |
| --- | --- |
| `/api/auth` | `POST /login`, `POST /refresh`, `POST /logout`, `GET /me`, `POST /change-password` |
| `/api/workspace` | `GET /` — the whole working set the frontend boots from |
| Masters | `GET/POST/PATCH /api/customers`, `GET /api/suppliers`, `/api/companies`, `/api/products`, `/api/warehouses`, `/api/employees`, `GET /api/search`, `GET /api/reference/context` |
| Dealer | `GET/POST /api/dealer/purchases`, `POST /api/dealer/purchases/preview`, `POST /api/dealer/purchases/:id/post`, `.../cancel`, same shape for `/api/dealer/sales` |
| Bulk crop | `GET/POST /api/crops/purchases`, `POST /api/crops/purchases/preview`, `.../:id/post`, `.../cancel`, same for `/api/crops/sales` plus `POST /api/crops/sales/preview` (FIFO preview), `GET /api/crops/batches` |
| Inventory | `GET /api/inventory`, `GET /api/inventory/movements`, `POST /api/inventory/adjustments`, `GET /api/inventory/reconciliation` |
| Finance | `GET /api/accounts`, `/api/payment-methods`, `/api/receivables`, `/api/payables`, `GET/POST /api/payments`, `GET/POST /api/expenses` |
| Approvals | `GET /api/approvals`, `GET /api/approvals/:id/history`, `POST /api/approvals/:id/decide`, `GET /api/approvals/rules` |
| Reports | `GET /api/dashboard/dashboard`, `GET /api/reports/catalogue`, `GET /api/reports/:reportId` |
| Audit | `GET /api/audit` |

Every list endpoint accepts `page`, `pageSize`, `sort`, `dir`, `q`, `from`, `to`
and `businessType` (`DEALER` | `BULK_CROP` | `ALL`). Sorting maps a key onto an
allow-list of columns; a column name is never taken from the client.

### Roles

`Admin`, `Management`, `Sales`, `Purchase`, `Accounts`, `Warehouse`. Roles grant
permission codes (`dealer.sale.post`, `report.profit`, `approval.decide`, …) and
every route declares what it needs. Profit figures are stripped from responses
for roles without `report.profit` rather than merely hidden in the UI.

## Operations

### Backup

Nightly logical backup, kept 30 days:

```bash
pg_dump --format=custom --file=/backups/business_suite_$(date +%F).dump business_suite
```

Weekly full backup including globals (roles, grants):

```bash
pg_dumpall --globals-only --file=/backups/globals_$(date +%F).sql
```

Base backups for point-in-time recovery need `wal_level = replica`, an
`archive_command` copying WAL to durable storage, and `pg_basebackup` weekly.
Without WAL archiving the recovery point is the last nightly dump.

### Restore

```bash
createdb business_suite_restore
pg_restore --dbname=business_suite_restore --clean --if-exists /backups/business_suite_2026-08-29.dump
```

Restore into a **new** database first and check it before pointing the app at
it. Verify with:

```sql
SELECT COUNT(*) FROM stock_movements;
SELECT * FROM v_stock_reconciliation WHERE difference <> 0;   -- must be empty
```

Test the restore monthly. A backup that has never been restored is not a backup.

### Migration and rollback

Migrations are numbered SQL applied in filename order, each in its own
transaction, recorded with a checksum. Editing an applied migration is detected
and refused — add a new one instead.

```bash
npm run db:migrate      # apply pending
node db/migrate.mjs status
```

There are no down-migrations by design: rolling a schema change back on a live
financial database loses data more often than it helps. To roll back, restore
the pre-deployment backup, or write a forward migration that reverses the
change. Always take a dump immediately before migrating production.

### Deployment checklist

- `NODE_ENV=production`, a real `JWT_SECRET`, `BCRYPT_ROUNDS` at 12 or more.
- `CORS_ORIGINS` set to the frontend's actual origin — not a wildcard.
- TLS terminated in front of the API; `trust proxy` is already enabled.
- Run as a non-superuser database role (`setup.sql` creates one).
- Change every seeded password; the accounts ship flagged `must_change_pw`.
- Point a scheduled job at `purgeExpiredSessions()` to clear stale sessions.
- Watch `GET /health` — it fails when the database is unreachable.
