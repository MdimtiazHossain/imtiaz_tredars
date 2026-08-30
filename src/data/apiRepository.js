import { ApiClient } from './apiClient.js';
import { NAV, TITLES } from './seed.js';

/**
 * REST implementation of the repository contract.
 *
 * Method for method it matches `InMemoryRepository`, so a screen cannot tell
 * which one it is holding. The only asymmetry is deliberate: writes here send
 * an intent (what the user did) rather than a pre-built row, because the server
 * owns document numbering, costing and the ledger.
 *
 * Navigation and screen titles come from the bundled config rather than the
 * API: they describe the shell, not the business, and the role filtering
 * applied to them is presentation.
 */
export class ApiRepository {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {ApiClient} [options.client]
   */
  constructor(options = {}) {
    this.client = options.client || new ApiClient({ baseUrl: options.baseUrl });
    /** Ids the server assigned, keyed by the business code the UI works in. */
    this._ids = { customers: new Map(), suppliers: new Map(), companies: new Map(), products: new Map(), crops: new Map(), warehouses: new Map(), units: new Map(), grades: new Map() };
    this._context = null;
  }

  get isAuthenticated() {
    return this.client.isAuthenticated;
  }

  login(username, password) {
    return this.client.login(username, password);
  }

  restore() {
    return this.client.restore();
  }

  logout() {
    return this.client.logout();
  }

  /**
   * Remember the id behind each code so later writes can send ids without the
   * screens having to carry them.
   */
  _indexLookups(data, context) {
    this._context = context;
    for (const kind of Object.keys(this._ids)) this._ids[kind].clear();
    for (const c of data.customers || []) this._ids.customers.set(c.code, c.id);
    for (const s of data.suppliers || []) this._ids.suppliers.set(s.code, s.id);
    for (const c of data.companies || []) {
      this._ids.companies.set(c.code, c.id);
      // The crop sales screen selects a buyer by name, not code.
      this._ids.companies.set(c.name, c.id);
    }
    for (const p of data.products || []) this._ids.products.set(p.code, p.id);
    for (const [name, id] of Object.entries(context?.cropIds || {})) this._ids.crops.set(name, id);
    for (const [name, id] of Object.entries(context?.warehouseIds || {})) {
      this._ids.warehouses.set(name, id);
    }
    for (const [code, id] of Object.entries(context?.unitIds || {})) this._ids.units.set(code, id);
    for (const [name, id] of Object.entries(context?.gradeIds || {})) this._ids.grades.set(name, id);
  }

  /** Load the whole working set, in the shape the screens have always used. */
  async load() {
    const [workspace, context] = await Promise.all([
      this.client.get('/workspace'),
      this.client.get('/reference/context').catch(() => ({ data: null })),
    ]);

    const data = workspace.data;
    this._indexLookups(data, context?.data);

    return {
      ...data,
      nav: NAV,
      titles: TITLES,
    };
  }

  /* ------------------------------------------------------------------ writes */

  async createCustomer(record) {
    const payload = await this.client.post('/customers', {
      name: record.name,
      bn: record.bn,
      type: record.type,
      person: record.person,
      mobile: record.mobile,
      district: record.district,
      upazila: record.upazila,
      limit: record.limit,
      days: record.days,
      opening: record.out,
    });
    const saved = payload.data;
    this._ids.customers.set(saved.code, saved.id);
    return saved;
  }

  /**
   * Post a bulk crop purchase.
   *
   * The in-memory implementation was handed a finished row; the API is handed
   * the form's own values and returns what it actually created, because landed
   * cost, the document number and the batch number are the server's to decide.
   */
  async postCropPurchase({ intent }) {
    const payload = await this.client.post('/crops/purchases', {
      txnDate: intent.date,
      supplierId: this._ids.suppliers.get(intent.supplierCode),
      warehouseId: this._ids.warehouses.get(intent.warehouse),
      transportCost: intent.transport,
      loadingCost: intent.loading,
      unloadingCost: intent.unloading,
      otherCost: intent.other,
      advancePaid: intent.advance,
      note: intent.note,
      lines: [
        {
          cropId: this._ids.crops.get(intent.crop),
          gradeId: this._ids.grades.get(intent.grade),
          unitId: this._ids.units.get(intent.unit),
          grossQuantity: intent.quantity,
          moisturePct: intent.moisture,
          rate: intent.rate,
        },
      ],
      action: 'POST',
    });
    return payload.data;
  }

  async postCropSale({ intent }) {
    const payload = await this.client.post('/crops/sales', {
      txnDate: intent.date,
      buyerCompanyId: this._ids.companies.get(intent.buyerName ?? intent.buyerCode),
      valuationMethod: intent.valuation === 'FIFO' ? 'FIFO' : 'WEIGHTED_AVERAGE',
      transportCost: intent.transport,
      otherCost: intent.other,
      paidAmount: intent.paid || 0,
      lines: [
        {
          cropId: this._ids.crops.get(intent.crop),
          unitId: this._ids.units.get('MT'),
          quantity: intent.quantity,
          rate: intent.rate,
        },
      ],
      action: 'POST',
    });
    return payload.data;
  }

  async postDealerSale({ intent }) {
    const payload = await this.client.post('/dealer/sales', {
      txnDate: intent.date,
      customerId: this._ids.customers.get(intent.customerCode),
      warehouseId: this._ids.warehouses.get(intent.warehouse),
      paymentTerms: intent.terms,
      paidAmount: intent.paid,
      lines: intent.lines.map((l) => ({
        productId: this._ids.products.get(l.productCode),
        quantity: l.quantity,
        bonusQuantity: l.bonus,
        rate: l.rate,
        discountPct: l.discount,
      })),
      action: 'POST',
    });
    return payload.data;
  }

  async postDealerPurchase({ intent }) {
    const payload = await this.client.post('/dealer/purchases', {
      txnDate: intent.date,
      companyId: this._ids.companies.get(intent.companyCode),
      warehouseId: this._ids.warehouses.get(intent.warehouse),
      supplierInvoiceNo: intent.invoiceNo,
      paymentTerms: intent.terms,
      transportCost: intent.transport,
      otherCost: intent.other,
      lines: intent.lines.map((l) => ({
        productId: this._ids.products.get(l.productCode),
        quantity: l.quantity,
        freeQuantity: l.free,
        rate: l.rate,
        discountPct: l.discount,
      })),
      action: 'POST',
    });
    return payload.data;
  }

  async decideApproval(requestNo, approved, comment) {
    const list = await this.client.get('/approvals', { status: 'PENDING', pageSize: 200 });
    const match = list.data.find((a) => a.requestNo === requestNo);
    if (!match) throw new Error(`Approval ${requestNo} is no longer pending.`);

    const payload = await this.client.post(`/approvals/${match.id}/decide`, {
      approved,
      comment,
    });
    return payload.data;
  }

  /* ------------------------------------------------------------------ reads */

  /**
   * Dashboard aggregates, computed in SQL.
   *
   * Two calls: the running position, and the same figures narrowed to today,
   * because the design's first tile is "Today's Sales". Both are aggregates,
   * so this stays two small responses rather than a table of transactions.
   */
  async dashboard(businessType = 'ALL') {
    const today = new Date().toISOString().slice(0, 10);
    const get = (params) => this.client.get('/dashboard/dashboard', params);

    // Four small aggregates rather than one: the selected filter drives the
    // tiles, today drives the first tile, and the two business lines fill the
    // side-by-side panels, which always show both regardless of the filter.
    const [overall, todayOnly, dealer, crop] = await Promise.all([
      get({ businessType }),
      get({ businessType, from: today, to: today }),
      get({ businessType: 'DEALER' }),
      get({ businessType: 'BULK_CROP' }),
    ]);

    return {
      ...overall.data,
      today: todayOnly.data,
      byBusiness: { DEALER: dealer.data, BULK_CROP: crop.data },
    };
  }

  /** Which reports the server can actually serve, grouped for the sidebar. */
  async reportCatalogue() {
    const payload = await this.client.get('/reports/catalogue');
    return payload.data;
  }

  async report(reportId, filters = {}) {
    const payload = await this.client.get(`/reports/${reportId}`, filters);
    return { ...payload.data, meta: payload.meta };
  }

  async inventory(filters = {}) {
    const payload = await this.client.get('/inventory', filters);
    return { rows: payload.data, meta: payload.meta };
  }

  async audit(filters = {}) {
    const payload = await this.client.get('/audit', filters);
    return { rows: payload.data, meta: payload.meta };
  }

  async employees() {
    const payload = await this.client.get('/employees');
    return payload.data;
  }
}
