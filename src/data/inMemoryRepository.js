import * as seed from './seed.js';
import { ACCOUNTS, PAYMENT_METHOD_OPTIONS, EXPENSE_CATEGORIES } from './financeLookups.js';
import {
  EMPLOYEES,
  EXPENSE_VOUCHERS,
  SETTINGS,
  AUDIT_LOG,
  ROLES,
  permissionMatrix,
} from './reference.js';
import { PROFIT_AND_LOSS } from './analytics.js';

/**
 * In-memory implementation of the repository contract.
 *
 * Resolves against the bundled seed dataset. This is what the app runs on with
 * no backend configured, and what the test suite uses, so screens and domain
 * logic can be exercised without a database.
 *
 * `ApiRepository` implements the same contract against the REST API; see
 * `repository.js` for the contract itself and how one is chosen.
 */

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** Simulated latency so loading states are exercised in development. */
const LATENCY_MS = 180;

function settle(value, latency) {
  if (!latency) return Promise.resolve(value);
  return new Promise((res) => setTimeout(() => res(value), latency));
}

export class InMemoryRepository {
  /**
   * @param {object} [options]
   * @param {number} [options.latency] artificial delay in ms, 0 in tests
   */
  constructor(options = {}) {
    this.latency = options.latency === undefined ? LATENCY_MS : options.latency;
    this._store = null;
  }

  /** Load the full working set the app boots from. */
  async load() {
    this._store = {
      company: clone(seed.COMPANY),
      nav: clone(seed.NAV),
      titles: clone(seed.TITLES),
      customers: clone(seed.CUSTOMERS),
      suppliers: clone(seed.SUPPLIERS),
      companies: clone(seed.COMPANIES),
      products: clone(seed.PRODUCTS),
      crops: clone(seed.CROPS),
      warehouses: clone(seed.WAREHOUSES),
      employees: clone(EMPLOYEES),
      units: clone(seed.UNITS),
      grades: clone(seed.GRADES),
      buyers: clone(seed.BUYERS),
      lastRate: clone(seed.LAST_RATE),
      batches: clone(seed.BATCHES),
      approvals: clone(seed.APPROVALS),
      cropLog: clone(seed.CROP_LOG),
      saleLog: clone(seed.SALE_LOG),
      notifications: clone(seed.NOTIFICATIONS),
      accounts: clone(ACCOUNTS),
      paymentMethods: clone(PAYMENT_METHOD_OPTIONS),
      expenseCategories: clone(EXPENSE_CATEGORIES),
    };
    // Settings are configuration rather than working data, so they sit beside
    // the store rather than in the payload the screens boot from.
    this._settings = clone(SETTINGS);
    return settle(clone(this._store), this.latency);
  }

  /**
   * Persist a new customer.
   * @returns {Promise<object>} the stored record
   */
  async createCustomer(record) {
    if (this._store) this._store.customers.push(clone(record));
    return settle(clone(record), this.latency);
  }

  /**
   * Master data, without a server.
   *
   * The in-memory store is a fixture, not a database: there is no code
   * sequence, no audit trail and no `is_active` column. These do the least
   * that keeps the screens honest -- the record really is added, changed or
   * retired, and what comes back has the shape the API returns.
   *
   * Crops are the odd one out. Every screen that offers a crop reads
   * `data.crops`, which is a list of names, so the master list is derived from
   * those names and the batches holding them rather than stored twice.
   */
  _collection(kind) {
    const named = {
      product: 'products', customer: 'customers', supplier: 'suppliers',
      company: 'companies', employee: 'employees',
      account: 'accounts', category: 'expenseCategories', method: 'paymentMethods',
    };
    // Units live with the settings rather than the working set, but they are
    // maintained through the same master routes.
    if (kind === 'productCategory' || kind === 'brand') {
      if (!this._settings) this._settings = clone(SETTINGS);
      const key = kind === 'brand' ? 'brands' : 'categories';
      if (!this._settings[key]) this._settings[key] = [];
      return this._settings[key];
    }
    if (kind === 'unit') {
      if (!this._settings) this._settings = clone(SETTINGS);
      return this._settings.units;
    }
    const key = named[kind];
    if (!key) throw new Error(`Unknown master kind: ${kind}`);
    if (!this._store[key]) this._store[key] = [];
    return this._store[key];
  }

  /** Build the warehouse master from the names and the stock each one holds. */
  _warehouseRecords() {
    const batches = this._store.batches || [];
    return (this._store.warehouses || []).map((name, i) => {
      const held = batches.filter((b) => b.wh === name);
      return {
        id: i + 1,
        code: `WH-${String(i + 1).padStart(2, '0')}`,
        name,
        district: name.split(' ')[0],
        lines: held.length,
        quantity: held.reduce((t, b) => t + (Number(b.rem) || 0), 0),
        value: held.reduce((t, b) => t + (Number(b.rem) || 0) * (Number(b.cost) || 0), 0),
        status: 'Active',
      };
    });
  }

  /** Build the crop master from the crop names and the stock behind them. */
  _cropRecords() {
    const batches = this._store.batches || [];
    return (this._store.crops || []).map((name, i) => {
      const held = batches.filter((b) => b.crop === name);
      const quantity = held.reduce((t, b) => t + (Number(b.rem) || 0), 0);
      return {
        id: i + 1,
        code: `CROP-${String(i + 1).padStart(2, '0')}`,
        name,
        unit: (this._store.units || ['MT'])[0],
        rate: held.length ? Number(held[0].cost) || 0 : 0,
        quantity,
        value: held.reduce((t, b) => t + (Number(b.rem) || 0) * (Number(b.cost) || 0), 0),
        last: held.length ? held[0].date || '' : '',
        status: 'Active',
      };
    });
  }

  _rowsFor(kind) {
    if (kind === 'crop') return this._cropRecords();
    if (kind === 'warehouse') return this._warehouseRecords();
    return this._collection(kind);
  }

  /** Posted expense vouchers; the bundled ones, with no ledger behind them. */
  async expenses() {
    const rows = clone(EXPENSE_VOUCHERS);
    return settle({ rows, total: rows.reduce((t, r) => t + r.amount, 0) }, this.latency);
  }

  /** One page of a master list, filtered by name or code as the server does. */
  async listMaster(kind, params = {}) {
    const rows = this._rowsFor(kind);
    const q = String(params.q || '').toLowerCase();
    const matched = q
      ? rows.filter((r) => `${r.name} ${r.code}`.toLowerCase().indexOf(q) > -1)
      : rows;
    return settle(clone(matched), this.latency);
  }

  async createMaster(kind, body) {
    if (kind === 'crop') {
      if (!this._store.crops) this._store.crops = [];
      this._store.crops.push(body.name);
      return settle(clone(this._cropRecords().slice(-1)[0]), this.latency);
    }

    const rows = this._collection(kind);
    const prefix = {
      product: 'P', customer: 'CUS', supplier: 'SUP', company: 'CMP',
      employee: 'EMP', account: 'ACC', category: 'EXP',
    }[kind];
    const width = kind === 'product' ? 4 : kind === 'customer' || kind === 'supplier' ? 3 : 2;
    // Where the operator chose a code, keep it.
    if (body.code) {
      const record = { ...clone(body), id: rows.length + 1, status: 'Active' };
      rows.push(record);
      return settle(clone(record), this.latency);
    }
    const code = `${prefix}-${String(rows.length + 1).padStart(width, '0')}`;
    const record = { ...clone(body), id: rows.length + 1, code, status: 'Active' };
    rows.push(record);
    return settle(clone(record), this.latency);
  }

  async updateMaster(kind, id, body) {
    if (kind === 'crop') {
      const index = this._cropRecords().findIndex((c) => c.id === id || c.code === id);
      if (index < 0) throw new Error('Crop not found');
      this._store.crops[index] = body.name;
      return settle(clone(this._cropRecords()[index]), this.latency);
    }

    const found = this._collection(kind).filter((r) => r.id === id || r.code === id)[0];
    if (!found) throw new Error('Record not found');
    Object.assign(found, clone(body));
    return settle(clone(found), this.latency);
  }

  async restoreMaster(kind, id) {
    const found = this._rowsFor(kind).filter((r) => r.id === id || r.code === id)[0];
    if (!found) throw new Error('Record not found');
    found.status = 'Active';
    found.active = true;
    return settle(clone(found), this.latency);
  }

  async retireMaster(kind, id) {
    if (kind === 'crop') {
      const records = this._cropRecords();
      const index = records.findIndex((c) => c.id === id || c.code === id);
      if (index < 0) throw new Error('Crop not found');
      if (records[index].quantity > 0) {
        throw new Error(
          `${records[index].quantity} is still in stock for this crop. ` +
            'Sell or write the batches off before retiring it.'
        );
      }
      // No is_active column here, so the name leaves the list of crops on
      // offer -- which is what retiring it means to every other screen.
      this._store.crops.splice(index, 1);
      return settle({ ...records[index], status: 'Retired' }, this.latency);
    }

    const found = this._collection(kind).filter((r) => r.id === id || r.code === id)[0];
    if (!found) throw new Error('Record not found');
    // Retired, never removed: the fixture's transactions still point at it.
    // Both flags, because some screens read the status and some the boolean.
    found.status = 'Retired';
    found.active = false;
    return settle(clone(found), this.latency);
  }

  /**
   * Persist a bulk crop purchase together with the batch it creates.
   * @returns {Promise<{logRow: object, batch: object}>}
   */
  async postCropPurchase({ logRow, batch }) {
    if (this._store) {
      this._store.cropLog.unshift(clone(logRow));
      this._store.batches.unshift(clone(batch));
    }
    return settle({ logRow: clone(logRow), batch: clone(batch) }, this.latency);
  }

  /**
   * Persist a bulk crop sale and the stock it consumes.
   * @returns {Promise<{logRow: object, allocations: Record<string, number>}>}
   */
  async postCropSale({ logRow, allocations }) {
    if (this._store) this._store.saleLog.unshift(clone(logRow));
    return settle({ logRow: clone(logRow), allocations: clone(allocations) }, this.latency);
  }

  /** Persist a dealer sales invoice. */
  async postDealerSale(invoice) {
    return settle(clone(invoice), this.latency);
  }

  /** Persist a dealer purchase bill. */
  async postDealerPurchase(bill) {
    return settle(clone(bill), this.latency);
  }

  /**
   * Record a receipt or a payment.
   *
   * The in-memory store has no ledger, so this returns what a server would
   * have created. It exists so the payment screen works without a backend and
   * the tests can exercise the flow.
   */
  async createPayment(payment) {
    const prefix = payment.direction === 'RECEIPT' ? 'RC' : 'PY';
    const allocated = (payment.allocations || []).reduce((t, a) => t + Number(a.amount || 0), 0);
    return settle(
      {
        ...clone(payment),
        txnNo: `${prefix}-2608-${String(300 + this._counter('payment')).padStart(3, '0')}`,
        allocated,
        unallocated: Number(payment.amount || 0) - allocated,
      },
      this.latency
    );
  }

  /** Record an expense voucher. */
  async createExpense(expense) {
    return settle(
      {
        ...clone(expense),
        txnNo: `EXP-2608-${String(120 + this._counter('expense')).padStart(3, '0')}`,
        status: 'POSTED',
      },
      this.latency
    );
  }

  /** Move stock between warehouses. */
  async createStockTransfer(transfer) {
    return settle(
      {
        ...clone(transfer),
        txnNo: `TRF-2608-${String(10 + this._counter('transfer')).padStart(3, '0')}`,
        status: 'POSTED',
      },
      this.latency
    );
  }

  /** Record a stock adjustment. */
  async createStockAdjustment(adjustment) {
    return settle(
      {
        ...clone(adjustment),
        txnNo: `ADJ-2608-${String(30 + this._counter('adjustment')).padStart(3, '0')}`,
        // Adjustments always require approval, matching the seeded rule.
        status: 'PENDING_APPROVAL',
      },
      this.latency
    );
  }

  /**
   * Open invoices a payment could settle.
   *
   * The seed dataset has no invoice ledger, so there is nothing to allocate
   * against and a payment recorded here simply sits on account. Answering with
   * an empty list is honest; omitting the method would leave the form waiting.
   */
  async openInvoices() {
    return settle([], this.latency);
  }

  /** Monotonic per-kind counter, so numbers do not repeat within a session. */
  _counter(kind) {
    if (!this._counters) this._counters = {};
    this._counters[kind] = (this._counters[kind] || 0) + 1;
    return this._counters[kind];
  }

  /**
   * The audit trail, without a backend.
   *
   * A fixture rather than a record of this session: nothing here writes to a
   * ledger, so there is no history to report. It exists so the screen can be
   * seen working, and matches the shape `GET /audit` returns.
   */
  async audit() {
    const rows = clone(AUDIT_LOG);
    return settle({ rows, total: rows.length }, this.latency);
  }

  /**
   * Who this installation belongs to, before anyone has signed in.
   *
   * Nothing signs in without a backend, so this is never reached by the sign-in
   * card. It is here because both implementations answer the same contract, and
   * a method one of them is missing is one a screen can trip over later.
   */
  async context() {
    const org = this._settingsStore().organization;
    return settle({ name: org.name, systemName: org.systemName }, this.latency);
  }

  /* ------------------------------------------------------------- statements */

  /**
   * Without a server there is no journal to derive a statement from, so the
   * bundled figures stand in — which is what they were always for.
   */
  async profitAndLoss() {
    const lines = clone(PROFIT_AND_LOSS).map((x) => ({
      label: x.k, amount: x.v, bold: !!x.bold, good: !!x.good, big: !!x.big,
    }));
    const find = (re) => (lines.find((l) => re.test(l.label)) || {}).amount || 0;
    const revenue = find(/total revenue/i);
    const netProfit = find(/net profit/i);
    return settle(
      {
        lines,
        totals: {
          revenue,
          costOfSales: 0,
          grossProfit: find(/gross profit/i),
          operatingExpense: 0,
          netProfit,
          marginPct: revenue ? (netProfit / revenue) * 100 : 0,
        },
        // The demo figures are a specimen month, and the heading says which.
        period: { from: '2026-08-01', to: '2026-08-31', businessType: null },
        isEmpty: false,
      },
      this.latency
    );
  }

  /* --------------------------------------------------------------- invoices */

  /**
   * Dealer invoices, without a server.
   *
   * The bundled dataset posts no dealer sales, so there is nothing to list and
   * nothing to print. Answering with an empty page is honest, and keeps the
   * screen working rather than leaving it waiting on a method that is not there.
   */
  async invoices() {
    return settle({ rows: [], meta: { total: 0 } }, this.latency);
  }

  async invoice() {
    throw new Error('Invoices can only be opened with a server behind the app.');
  }

  /* --------------------------------------------------------------- settings */

  /** The Settings screen's working set, in the shape the API returns. */
  async settings() {
    if (!this._settings) this._settings = clone(SETTINGS);
    return settle(clone(this._settings), this.latency);
  }

  _settingsStore() {
    if (!this._settings) this._settings = clone(SETTINGS);
    return this._settings;
  }

  async updateOrganization(changes) {
    const org = this._settingsStore().organization;
    Object.assign(org, clone(changes));
    return settle(clone(org), this.latency);
  }

  async createFiscalYear(year) {
    const years = this._settingsStore().fiscalYears;
    const record = {
      ...clone(year),
      id: Math.max(0, ...years.map((y) => y.id)) + 1,
      span: `${year.startsOn} – ${year.endsOn}`,
      current: !!year.current,
      closed: false,
      status: year.current ? 'Current' : 'Open',
    };
    if (record.current) years.forEach((y) => { y.current = false; y.status = y.closed ? 'Closed' : 'Open'; });
    years.unshift(record);
    return settle(clone(record), this.latency);
  }

  async updateFiscalYear(id, changes) {
    const years = this._settingsStore().fiscalYears;
    const found = years.filter((y) => y.id === id)[0];
    if (!found) throw new Error('Financial year not found');
    if (changes.closed === true && found.current) {
      // The same refusal the server makes: something has to stay open.
      throw new Error(
        `${found.code} is the current financial year. Make another year current before closing it.`
      );
    }
    if (changes.closed !== undefined) found.closed = changes.closed;
    if (changes.current) {
      years.forEach((y) => { y.current = false; });
      found.current = true;
    }
    years.forEach((y) => { y.status = y.current ? 'Current' : y.closed ? 'Closed' : 'Open'; });
    return settle(clone(found), this.latency);
  }

  async updateNumbering(docType, format) {
    const row = this._settingsStore().numbering.filter((n) => n.docType === docType)[0];
    if (!row) throw new Error('Unknown document type');
    Object.assign(row, clone(format));
    row.pattern = `${row.prefix}-YYMM-${'#'.repeat(row.padding)}`;
    return settle(clone(row), this.latency);
  }

  async updateApprovalRule(id, changes) {
    const rule = this._settingsStore().approvalRules.filter((r) => r.id === id)[0];
    if (!rule) throw new Error('Approval rule not found');
    if (changes.threshold !== undefined && rule.condition === 'ALWAYS') {
      throw new Error(
        `${rule.entityLabel} always requires approval, so there is no limit to set on it.`
      );
    }
    Object.assign(rule, clone(changes));
    return settle(clone(rule), this.latency);
  }

  async updateNotificationRule(id, changes) {
    const rule = this._settingsStore().notificationRules.filter((r) => r.id === id)[0];
    if (!rule) throw new Error('Notification rule not found');
    if (changes.threshold !== undefined && rule.threshold === null) {
      throw new Error(`${rule.name} fires on a condition rather than an amount.`);
    }
    Object.assign(rule, clone(changes));
    return settle(clone(rule), this.latency);
  }

  /* ------------------------------------------------------ roles and logins */

  /**
   * Roles and their grants, without a server.
   *
   * The same shape the API answers with, and the same rules over it: a role
   * the business is set up around cannot be deleted, one somebody holds
   * cannot be either, and nothing may leave the roles with nobody able to
   * change them back. The demo can cut its own permissions and see the
   * sidebar change; nothing outlives the page, which is what "no backend"
   * means.
   */
  _roleStore() {
    if (!this._roles) this._roles = clone(ROLES);
    return this._roles;
  }

  _matrix() {
    const team = this._store ? this._store.employees : EMPLOYEES;
    const matrix = permissionMatrix(this._roleStore(), team);
    // The settings working set carries the matrix too, so a grant moved here
    // is the one the Settings screen reads back.
    if (this._settings) this._settings.permissions = matrix;
    return matrix;
  }

  /**
   * Apply a change to roles or logins, and undo it if it closes the door.
   *
   * The server does this with a transaction: the guard runs inside it and a
   * refusal rolls the whole thing back. There is no transaction here, so the
   * mutable state is snapshotted first and put back on refusal -- otherwise a
   * refused change stays half-applied and the demo drifts away from what the
   * screen just told the user had not happened.
   */
  _guarded(change) {
    const team = this._store ? this._store.employees : EMPLOYEES;
    const before = {
      roles: clone(this._roleStore()),
      team: team.map((e) => ({ role: e.role, status: e.status })),
    };

    try {
      const result = change();
      this._assertStillAdministrable();
      return result;
    } catch (err) {
      this._roles = before.roles;
      before.team.forEach((snapshot, i) => Object.assign(team[i], snapshot));
      throw err;
    }
  }

  /** Refuse a change that would leave nobody able to undo it. */
  _assertStillAdministrable() {
    const team = this._store ? this._store.employees : EMPLOYEES;
    const held = new Set(
      this._roleStore()
        .filter((r) => team.some((e) => e.role === r.code && e.status !== 'Retired'))
        .flatMap((r) => r.granted)
    );
    for (const [code, what] of [
      ['role.edit', 'change roles and permissions'],
      ['settings.edit', 'change the system settings'],
    ]) {
      if (!held.has(code)) {
        throw new Error(
          `That would leave no active user able to ${what}. Give the permission to ` +
            'another role, or another role to another user, first.'
        );
      }
    }
  }

  async roles() {
    return settle(clone(this._matrix()), this.latency);
  }

  async createRole(role) {
    const roles = this._roleStore();
    if (roles.some((r) => r.code.toLowerCase() === String(role.code).toLowerCase())) {
      throw new Error(`A role called ${role.code} already exists.`);
    }
    roles.push({
      id: Math.max(0, ...roles.map((r) => r.id)) + 1,
      code: role.code,
      name: role.name,
      description: role.description || '',
      system: false,
      granted: clone(role.permissions || []),
    });
    return settle(clone(this._matrix()), this.latency);
  }

  async updateRole(id, changes) {
    const role = this._roleStore().filter((r) => r.id === id)[0];
    if (!role) throw new Error('Role not found');
    if (changes.name !== undefined) role.name = changes.name;
    if (changes.description !== undefined) role.description = changes.description;
    return settle(clone(this._matrix()), this.latency);
  }

  async deleteRole(id) {
    const roles = this._roleStore();
    const role = roles.filter((r) => r.id === id)[0];
    if (!role) throw new Error('Role not found');
    if (role.system) {
      throw new Error(
        `${role.name} is one of the roles the system is set up around, so it cannot be ` +
          'deleted. Change what it may do instead, or move its users to another role.'
      );
    }
    const team = this._store ? this._store.employees : EMPLOYEES;
    const holders = team.filter((e) => e.role === role.code).length;
    if (holders) {
      throw new Error(
        `${role.name} is held by ${holders} ${holders === 1 ? 'user' : 'users'}. ` +
          'Move them to another role first.'
      );
    }
    this._guarded(() => {
      this._roles = roles.filter((r) => r.id !== id);
    });
    return settle(clone(this._matrix()), this.latency);
  }

  async setRolePermissions(id, scope, permissions) {
    if (!this._roleStore().some((r) => r.id === id)) throw new Error('Role not found');
    this._guarded(() => {
      const role = this._roleStore().filter((r) => r.id === id)[0];
      const wanted = new Set(permissions);
      role.granted = role.granted
        .filter((code) => !scope.includes(code))
        .concat(scope.filter((code) => wanted.has(code)))
        .sort();
    });
    return settle(clone(this._matrix()), this.latency);
  }

  /**
   * The logins, derived from the team directory.
   *
   * Without a server there is no `users` table; the demo's accounts are the
   * employees, each holding the role the directory records, which is what the
   * Employees screen has always shown.
   */
  async userAccounts() {
    const team = this._store ? this._store.employees : EMPLOYEES;
    return settle(
      team.map((e, i) => ({
        id: e.id ?? i + 1,
        username: e.name.split(' ')[0].toLowerCase() + String(e.code || '').slice(-2),
        email: '',
        active: e.status !== 'Retired',
        mustChangePassword: false,
        lastLogin: '',
        employeeId: e.id ?? i + 1,
        employeeCode: e.code,
        name: e.name,
        designation: e.designation,
        employeeActive: e.status !== 'Retired',
        roles: e.role && e.role !== '\u2014' ? [e.role] : [],
        role: e.role,
        status: e.status === 'Retired' ? 'Disabled' : 'Active',
      })),
      this.latency
    );
  }

  async updateUserAccount(id, changes) {
    const team = this._store ? this._store.employees : EMPLOYEES;
    const member = team.filter((e) => (e.id ?? 0) === id)[0];
    if (!member) throw new Error('User account not found');

    this._guarded(() => {
      if (changes.roles) [member.role] = changes.roles;
      if (changes.active !== undefined) {
        member.status = changes.active ? 'Active' : 'Retired';
      }
    });
    return this.userAccounts();
  }

  /**
   * Creating a login and resetting a password need somewhere to keep a
   * password, and the demo deliberately has nowhere. Both refuse rather than
   * pretending to have done something.
   */
  async createUserAccount() {
    throw new Error('Logins need the server: there is nowhere to keep a password without one.');
  }

  async resetUserPassword() {
    throw new Error('Passwords need the server: there is nowhere to keep one without it.');
  }

  /** Record an approve/reject decision against a pending request. */
  async decideApproval(id, approved, history) {
    if (this._store) {
      this._store.approvals = this._store.approvals.map((a) =>
        a.id === id ? { ...a, status: approved ? 'approved' : 'rejected', hist: history } : a
      );
    }
    return settle({ id, approved, history }, this.latency);
  }
}

