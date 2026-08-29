# Meghna Agro Enterprise — Business Suite

Business management app for a Bangladeshi agri-trading company that runs two
distinct business models side by side:

- **Bulk crop trading** — buy from farmers and aratdars, hold batch stock, sell
  to buyer companies. Profit depends on landed cost per MT, so every incidental
  expense is absorbed into the batch cost.
- **Dealer business** — buy from principal companies, sell to dealers,
  retailers and corporates on credit, against a credit limit and aging.

Implemented from the imported Claude Design project (`design/`).

## Two ways to run

The frontend talks to a **repository**, never to a database. Which
implementation it gets is decided by one environment variable:

| `VITE_API_URL` | Repository | Data |
| --- | --- | --- |
| unset | `InMemoryRepository` | bundled seed data, no backend needed |
| set | `ApiRepository` | live PostgreSQL through the REST API in `server/` |

No screen knows the difference. See [server/README.md](server/README.md) for the
backend, its schema and its operational runbook.

To run against the real backend, set up the server first, then create a `.env`
at this level:

```
VITE_API_URL=http://localhost:5310/api
```

## Running it

```bash
npm install
```

```bash
npm run dev
```

Then open the printed URL. Other scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` over JSDoc-annotated JS |
| `npm run lint` | ESLint |
| `npm test` | Vitest suite |
| `npm run verify` | All four of the above, in order |

The role, profit visibility and approval limit that the design exposes as
tweakable inputs are readable from the query string, which is handy for
checking permission-based navigation:

```
http://localhost:5173/?role=Sales&showProfit=false&approvalLimit=1000000
```

Roles: `Admin`, `Management`, `Sales`, `Purchase`, `Accounts`, `Warehouse`.

## How it is put together

```
index.html
src/
  main.js               entry point: load data, mount the app
  runtime/
    template.js         template engine for the design's .dc.html dialect
    component.js        base component: state, setState, batched render
  data/
    repository.js       the contract + implementation choice
    inMemoryRepository.js  seed-backed implementation
    apiRepository.js    REST implementation
    apiClient.js        HTTP, tokens, error envelope
    seed.js             master and transaction records (generated)
    analytics.js        dashboard, P&L and report figures (generated)
    reference.js        employees, permissions, settings, phone specs (generated)
  domain/
    format.js           BDT money and lakh/crore number formatting
    calculations.js     landed cost, FIFO allocation, invoice totals
  components/
    dataTable.js        reusable table model builders
  app/
    logic.js            per-screen view-model assembly (generated, then edited)
  templates/
    app.html            the design's markup, verbatim
    dataTable.html      the DataTable component's markup
  styles/
    design-base.css     base rules from the design
    app.css             responsive and boot-state additions
    tokens.js           colour tokens for use from JavaScript
design/                 the imported Claude Design project, unmodified
tools/                  one-shot extraction scripts (see below)
tests/                  Vitest suites
```

### The template runtime

The design is written in a small template dialect that Claude Design renders
with React. Rather than hand-translate 1,400 lines of markup, this project
reuses that markup verbatim and implements the dialect directly. The whole
dialect is seven features:

| Directive | Meaning |
| --- | --- |
| `{{ path }}` | interpolate, in text or an attribute |
| `<sc-for list as>` | repeat children under a scoped alias |
| `<sc-if value>` | render children when truthy |
| `<dc-import name t>` | render a child component with props |
| `style-hover` | hover-only style overlay |
| `onClick` / `onChange` | event handler resolved from scope |
| `value` / `checked` | form-control binding |

Every expression in the design is a plain property path, so the runtime
resolves paths rather than evaluating code — there is no `eval` anywhere.

Two things are worth knowing if you edit `template.js`:

- Templates are parsed as **XML**, not HTML. `<sc-for>` appears inside `<tr>`
  and `<tbody>`, where the HTML parser would foster-parent an unknown element
  out of the table and wreck the structure.
- Patching compares tag names **case-insensitively**. HTML elements report an
  uppercase `tagName` while the XML-parsed template preserves source casing;
  comparing them directly replaces every element on every render, which loses
  focus and caret position while typing.

### Data flow

Screens never import `seed.js`, and never know where data comes from. They
receive a working set from whichever repository is configured, and send writes
back through the same object:

```
                    +-- InMemoryRepository --> seed / analytics / reference
BusinessApp.data <--+
                    +-- ApiRepository ------> REST API --> PostgreSQL
```

Both implement the same contract, documented in `data/repository.js`. Writes
take an *intent* — what the user did — rather than a finished row, so the server
can own document numbering, costing and the ledger while the in-memory version
computes the same thing locally.

`InMemoryRepository` has a small artificial latency so loading states are
exercised in development; pass `{ latency: 0 }` in tests.

### The DataTable

`components/dataTable.js` builds the model; `templates/dataTable.html` renders
it. It is driven entirely by the object `table()` returns, so no screen is
coupled to it. Sticky headers, sortable columns, the empty state and the footer
summary are always on. Row selection, pagination and compact density are
opt-in and stay dormant unless a caller asks for them, so the screens that
mirror the design render exactly as designed.

```js
table(
  [column('Item'), column('Value', 'right', { onClick: sortByValue, sortMark: '  ↓' })],
  rows.map((r) => ({ cells: [cell(r.name), cell(money(r.value), { align: 'right', mono: true })] })),
  { footNote: '12 lines', footTotal: 'Total ৳1,26,78,420', maxH: '520px' }
)
```

## The `tools/` scripts

The seed data, the analytics and reference datasets, and the screen logic were
transferred out of the design file mechanically rather than retyped, so the
figures and the arithmetic are the design's own. The scripts are one-shot and
already applied; they are kept because they document exactly where each piece
came from. `tools/rewire-logic.mjs` in particular is **not** idempotent — it
has already run, and `logic.js` has been edited since. Re-running any of them
against the current tree will not reproduce it.

## Testing

92 frontend tests across four suites (`npm test`), plus the server's own suite
(`cd server && npm test`):

- `calculations.test.js` — the business arithmetic, including the worked
  example the crop purchase screen opens on.
- `template.test.js` — the runtime: interpolation, loops, conditionals, child
  components, and that patching preserves element identity.
- `dataTable.test.js` — the table model, including the opt-in features.
- `app.test.js` — mounts the real templates against the real logic and walks
  all 16 screens, navigation, roles, search, sorting, approvals and posting.
