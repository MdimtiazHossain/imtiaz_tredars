import * as seed from './seed.js';

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
      units: clone(seed.UNITS),
      grades: clone(seed.GRADES),
      buyers: clone(seed.BUYERS),
      lastRate: clone(seed.LAST_RATE),
      batches: clone(seed.BATCHES),
      approvals: clone(seed.APPROVALS),
      cropLog: clone(seed.CROP_LOG),
      saleLog: clone(seed.SALE_LOG),
      notifications: clone(seed.NOTIFICATIONS),
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

