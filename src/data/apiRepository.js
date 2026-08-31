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
/**
 * Master data lives at the root of the API, one path per entity. The crop
 * master shares `/crops` with crop trading, which sits under `/crops/purchases`
 * and `/crops/sales`, so the two do not collide.
 */
const MASTER_PATHS = {
  crop: '/crops',
  product: '/products',
  warehouse: '/warehouses',
  employee: '/employees',
  account: '/accounts',
  category: '/expense-categories',
  method: '/payment-methods',
  unit: '/units',
  productCategory: '/product-categories',
  brand: '/brands',
  customer: '/customers',
  supplier: '/suppliers',
  company: '/companies',
};

/** Which code -> id map a saved record belongs in, where one is kept. */
const MASTER_ID_MAPS = {
  crop: 'crops',
  product: 'products',
  warehouse: 'warehouses',
  customer: 'customers',
};

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

  /**
   * Who this installation belongs to, before anyone has signed in.
   *
   * The sign-in card names the business, and it cannot read the workspace to
   * find out -- that needs a token. `GET /auth/context` is the one endpoint
   * answering without one, and it carries nothing that is not already on the
   * company's own invoices. A failure resolves to null rather than rejecting:
   * not knowing the name is no reason to refuse to draw the form.
   */
  context() {
    return this.client.get('/auth/context').then(
      (payload) => payload.data,
      () => null
    );
  }

  restore() {
    return this.client.restore();
  }

  logout() {
    return this.client.logout();
  }

  /**
   * Change the signed-in user's own password.
   *
   * The current one is required by the server, so knowing a session is not
   * enough to take an account over. Every seeded and freshly installed account
   * is flagged to force this on first sign-in.
   */
  changePassword(currentPassword, newPassword) {
    return this.client
      .post('/auth/change-password', { currentPassword, newPassword })
      .then((payload) => payload.data);
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
      // Name-to-id maps the forms need when posting: the screens select a
      // warehouse by name, the API wants its id.
      warehouseIds: context?.data?.warehouseIds || {},
      cropIds: context?.data?.cropIds || {},
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

  /**
   * Master data.
   *
   * All four entities sit behind the same three routes, so one method each
   * covers crops, customers, suppliers and companies. Nothing is deleted --
   * `retireMaster` deactivates, and the server refuses even that while the
   * party still owes money or the crop is still in stock.
   */
  async listMaster(kind, params = {}) {
    const payload = await this.client.get(MASTER_PATHS[kind], params);
    return payload.data;
  }

  async createMaster(kind, body) {
    const saved = (await this.client.post(MASTER_PATHS[kind], body)).data;
    // Keep the code -> id map current, so a write naming this record by code
    // can still resolve the id the server expects.
    const map = this._ids[MASTER_ID_MAPS[kind]];
    if (map && saved.code) map.set(saved.code, saved.id);
    return saved;
  }

  async updateMaster(kind, id, body) {
    return (await this.client.patch(`${MASTER_PATHS[kind]}/${id}`, body)).data;
  }

  async retireMaster(kind, id) {
    return (await this.client.delete(`${MASTER_PATHS[kind]}/${id}`)).data;
  }

  /** Put a retired record back. */
  async restoreMaster(kind, id) {
    return (await this.client.post(`${MASTER_PATHS[kind]}/${id}/restore`)).data;
  }

  /** Record a receipt or a payment, with its invoice allocations. */
  async createPayment(payment) {
    const data = (await this.client.post('/payments', payment)).data;
    return data;
  }

  /**
   * Posted expense vouchers.
   *
   * The screen used to show a bundled list whatever the business had actually
   * spent, which is how the Expense tab came to total Tk 3,84,100 against a
   * single Tk 12,500 voucher.
   */
  async expenses(params = {}) {
    const payload = await this.client.get('/expenses', params);
    return { rows: payload.data, total: payload.meta?.totalAmount ?? null };
  }

  /** Record an expense voucher. */
  async createExpense(expense) {
    return (await this.client.post('/expenses', expense)).data;
  }

  /** Move stock between warehouses. */
  async createStockTransfer(transfer) {
    return (await this.client.post('/inventory/transfers', transfer)).data;
  }

  /** Record a stock adjustment; the server routes it for approval. */
  async createStockAdjustment(adjustment) {
    return (await this.client.post('/inventory/adjustments', adjustment)).data;
  }

  /**
   * Open invoices for one party, so a payment can be allocated against them.
   *
   * Filtered server-side: fetching every open invoice and narrowing in the
   * browser would grow with the business rather than with the party.
   */
  async openInvoices(direction, partyType, partyId) {
    const path = direction === 'RECEIPT' ? '/receivables' : '/payables';
    const payload = await this.client.get(path, {
      partyType,
      partyId,
      pageSize: 100,
    });
    return payload.data;
  }

  /** Cash, bank and MFS accounts a payment can move through. */
  async accounts() {
    return (await this.client.get('/accounts')).data;
  }

  /** Configured payment methods. */
  async paymentMethods() {
    return (await this.client.get('/payment-methods')).data;
  }

  /* --------------------------------------------------------------- settings */

  /**
   * Everything the Settings screen shows, in one call.
   *
   * The company profile, the financial years, the numbering formats, the units,
   * the approval and notification rules and the permission matrix are all rows
   * in the database; this is the read side of the panels that maintain them.
   */
  async settings() {
    return (await this.client.get('/settings')).data;
  }

  /** Edit the company profile, or the costing method it trades under. */
  async updateOrganization(changes) {
    return (await this.client.patch('/settings/organization', changes)).data;
  }

  async createFiscalYear(year) {
    return (await this.client.post('/settings/fiscal-years', year)).data;
  }

  /** Close, reopen, or make a financial year the current one. */
  async updateFiscalYear(id, changes) {
    return (await this.client.patch(`/settings/fiscal-years/${id}`, changes)).data;
  }

  /** Change the prefix or width a document type is numbered with. */
  async updateNumbering(docType, format) {
    return (await this.client.patch(`/settings/numbering/${docType}`, format)).data;
  }

  /** Move an approval limit, or switch the rule off. */
  async updateApprovalRule(id, changes) {
    return (await this.client.patch(`/settings/approval-rules/${id}`, changes)).data;
  }

  async updateNotificationRule(id, changes) {
    return (await this.client.patch(`/settings/notification-rules/${id}`, changes)).data;
  }

  /* ------------------------------------------------------ roles and logins */

  /**
   * The permission matrix, the roles behind it and the catalogue of codes.
   *
   * Every write below answers with the whole matrix again rather than with the
   * row it changed: a grant moved on one role changes what the table says for
   * that role in every module it touches, and re-reading the lot is one round
   * trip against a table with a few dozen rows.
   */
  async roles() {
    return (await this.client.get('/roles')).data;
  }

  async createRole(role) {
    return (await this.client.post('/roles', role)).data.permissions;
  }

  /** Rename a role, or change the sentence describing what it is for. */
  async updateRole(id, changes) {
    return (await this.client.patch(`/roles/${id}`, changes)).data;
  }

  async deleteRole(id) {
    return (await this.client.delete(`/roles/${id}`)).data;
  }

  /**
   * Grant and revoke inside one module.
   *
   * `scope` is the set of codes being decided and `permissions` the ones that
   * should end up granted; anything outside the scope is left as it was.
   */
  async setRolePermissions(id, scope, permissions) {
    return (await this.client.put(`/roles/${id}/permissions`, { scope, permissions })).data;
  }

  /** The logins, who they belong to and the roles they hold. */
  async userAccounts() {
    return (await this.client.get('/users')).data;
  }

  async createUserAccount(account) {
    return (await this.client.post('/users', account)).data.accounts;
  }

  /** Change the roles on a login, its address, or whether it works at all. */
  async updateUserAccount(id, changes) {
    return (await this.client.patch(`/users/${id}`, changes)).data;
  }

  /** Set a temporary password and sign the account out everywhere. */
  async resetUserPassword(id, password) {
    return (await this.client.post(`/users/${id}/password`, { password })).data;
  }

  /* ------------------------------------------------------------- statements */

  /**
   * The profit and loss, as the journal reports it.
   *
   * The screen used to render a fixture, and the report computed its own
   * totals from the documents. Both read this now, so they cannot disagree
   * about the same month.
   */
  async profitAndLoss(filters = {}) {
    return (await this.client.get('/profit-and-loss', filters)).data;
  }

  /* --------------------------------------------------------------- invoices */

  /** Posted and draft dealer invoices, newest first. */
  async invoices(params = {}) {
    const payload = await this.client.get('/dealer/sales', params);
    return { rows: payload.data, meta: payload.meta };
  }

  /** One invoice in full, with its lines and both parties, for print. */
  async invoice(id) {
    return (await this.client.get(`/dealer/sales/${id}`)).data;
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
    const get = (params) => this.client.get('/reports/dashboard', params);

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

  /**
   * Download a report as a file.
   * @param {'xlsx'|'pdf'} format
   * @returns {Promise<string>} the saved filename
   */
  exportReport(reportId, format, filters = {}) {
    return this.client.download(`/reports/${reportId}/export`, { ...filters, format });
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
