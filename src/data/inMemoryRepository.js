import * as seed from './seed.js';
import { ACCOUNTS, PAYMENT_METHOD_OPTIONS, EXPENSE_CATEGORIES } from './financeLookups.js';
import { EMPLOYEES } from './reference.js';

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
      account: 'accounts', category: 'expenseCategories',
    };
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
    found.status = 'Retired';
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

