/**
 * Screen logic for the Business Management App.
 *
 * Ported from the imported Claude Design project by `tools/extract-logic.mjs`.
 * Each method assembles the view-model for one screen; the templates in
 * `src/templates` consume it. Master data arrives from the repository as
 * `this.data`, and writes are sent back through the repository rather than
 * mutated in place only.
 */
import { Component } from '../runtime/component.js';
import { C } from '../styles/tokens.js';
import { money, int, dec2, lakh, shortDate, periodLabel } from '../domain/format.js';
import { cell, column, table } from '../components/dataTable.js';
import { field, formModal as formModalOf } from '../components/formModal.js';
import { openInvoice } from './invoicePrint.js';
import {
  buildModal,
  defaultsFor,
  validate as validateForm,
  payloadFor,
  autoAllocate,
} from './transactionForms.js';
import {
  defaultsFor as masterDefaults,
  validate as validateMaster,
  payloadFor as masterPayload,
  buildMasterModal,
  nounFor,
} from './masterForms.js';
import {
  DASHBOARD_KPIS,
  MONTHLY_SERIES,
  TOP_CUSTOMERS,
  TOP_COMPANIES,
  AGING_BUCKETS,
  REPORT_GROUPS,
} from '../data/analytics.js';
import {
  PHONE_SCREENS,
  PAYMENT_METHODS,
  EXPENSE_VOUCHERS,
  SETTINGS,
} from '../data/reference.js';
import { ACCOUNTS } from '../data/financeLookups.js';
import {
  defaultsFor as settingsDefaults,
  validate as validateSettings,
  payloadFor as settingsPayload,
  buildSettingsModal,
} from './settingsForms.js';

/**
 * What a screen shows when the record it works on does not exist yet.
 *
 * Several screens open on a selected party or product and reached for the
 * first record whenever nothing matched. On the day a business is installed
 * there is no first record, so that read returned `undefined` and the next
 * line asking it for a balance took down the whole app -- not the screen, the
 * app, because the view model is built in one pass.
 *
 * A blank record of the right shape renders as dashes and zeros instead, which
 * is what a business with no customers should see on its customers screen. It
 * carries no code, so nothing can be posted against it.
 */
const BLANK_PARTY = {
  code: '', name: '—', type: '', person: '', mobile: '', district: '', upazila: '',
  out: 0, pur: 0, limit: 0, days: 0, since: '', status: 'Active',
};

const BLANK_PRODUCT = {
  code: '', name: '—', cat: '', brand: '', unit: '', pur: 0, sale: 0, stock: 0, min: 0,
};

/** Currencies the app has words for; anything else reads as its own code. */
const CURRENCY_NAMES = { BDT: 'Bangladeshi Taka (৳)', USD: 'US Dollar ($)', INR: 'Indian Rupee (₹)', EUR: 'Euro (€)' };

const currencyName = (code) => CURRENCY_NAMES[code] || code || '—';

/**
 * What an approval rule does, in words, built from the rule itself.
 *
 * The seeded rules carry names like 'Purchase value above ৳5,00,000', which
 * stop being true the moment somebody moves the limit. Composing the sentence
 * from the entity and the condition means the panel cannot contradict the
 * figure printed beside it.
 */
function approvalRuleLabel(rule) {
  if (rule.condition === 'ALWAYS') return `${rule.entityLabel} always requires approval`;
  if (rule.condition === 'DISCOUNT_PCT_ABOVE') return `${rule.entityLabel} discount ceiling`;
  return `${rule.entityLabel} requiring approval above`;
}

/**
 * Columns the audit trail does not report on.
 *
 * Every update touches its own timestamps and the id of whoever made it, and
 * listing those alongside the change buries it: eight rows of "Updated at"
 * beside the one line saying the rate moved.
 */
const AUDIT_BOOKKEEPING = new Set([
  'updated_at', 'created_at', 'updatedAt', 'createdAt',
  'updated_by', 'created_by', 'updatedBy', 'createdBy', 'id', 'org_id',
]);

/**
 * Fields whose numbers are taka.
 *
 * A padding of 3, a credit term of 30 days and a line count of 1 are numbers
 * too, and printing every number as money turned them into amounts of taka.
 */
const AUDIT_MONEY_FIELD = /(amount|rate|cost|balance|limit|profit|cogs|price|paid|advance|opening|threshold|payable|receivable)/i;

/**
 * One field out of an audit entry's before/after snapshot, printed.
 *
 * PostgreSQL numerics arrive as strings, so a taka figure needs grouping to be
 * read at all; anything else numeric is grouped without the currency sign.
 */
function auditValue(snapshot, name) {
  const value = snapshot ? snapshot[name] : null;
  if (value === null || value === undefined || value === '') return '—';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  if (/^-?d+(.d+)?$/.test(String(value))) {
    return AUDIT_MONEY_FIELD.test(name) ? money(Number(value)) : int(Number(value));
  }
  return String(value);
}

/** A document's status, in the words the rest of the app already uses. */
const STATUS_LABELS = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  POSTED: 'Posted',
  CANCELLED: 'Cancelled',
};

/** Today, as a date input wants it. */
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * What a transaction form opens on.
 *
 * The imported design opened every form on a worked example -- customer
 * CUS-002, two named products, a warehouse in Bogura. That reads well against
 * the dataset it was drawn from and is nonsense against a real one, where none
 * of those records exist: the form cannot be posted, because the codes it is
 * holding resolve to nothing.
 *
 * The example is kept where the record it names is genuinely there, so the demo
 * is unchanged. Otherwise the first real record stands in, and with nothing to
 * stand in the field opens empty for the operator to choose.
 */
function opening(rows, preferred, key) {
  const list = rows || [];
  const valueOf = (row) => (key ? row && row[key] : row);
  if (list.some((row) => valueOf(row) === preferred)) return preferred;
  return list.length ? valueOf(list[0]) || '' : '';
}

/** Turn a snake_case column name into something a person reads. */
const humanField = (name) =>
  String(name || '')
    .split('_')
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());

export class BusinessApp extends Component {
  /**
   * @param {object} props  role, showProfit, approvalLimit, repository
   * @param {object} data   working set loaded by the repository
   */
  constructor(props, data) {
    super(props);
    this.data = data;
    this.repository = props.repository || null;
    this.state = {
      screen:'dashboard', biz:'all', q:'', qOpen:false, notifOpen:false, userOpen:false, toast:null,
      invTab:'all', invSort:'value', acctTab:'receivable', setSec:'company', repSel:'crop-batch-profit', repLoading:false,
      custSel:opening(data.customers, 'CUS-003', 'code'), custTab:'purchases',
      supSel:opening(data.suppliers, 'SUP-001', 'code'), supTab:'purchases',
      // The configured costing method, not a default the screen decides on.
      valuation:data.company && data.company.valuation === 'WEIGHTED_AVERAGE' ? 'Weighted Average' : 'FIFO',
      cp:{sup:opening(data.suppliers, 'SUP-001', 'code'), crop:opening(data.crops, 'Maize'),
        grade:opening(data.grades, 'A (Premium)'), wh:opening(data.warehouses, 'Naogaon Central Godown'),
        date:today(), qty:100, unit:opening(data.units, 'MT'), moist:1.5, rate:30000,
        transport:50000, loading:12000, unloading:8000, other:0, advance:1500000, note:''},
      extraCusts:[], custModal:false, master:null, masterRows:{},
      // Configuration, fetched when Settings is opened; the audit trail, when
      // its screen is. Neither belongs in the workspace every screen boots from.
      settings:null, settingsForm:null, auditRows:null,
      // Posted invoices, fetched when the dealer sales screen is opened.
      invoices:null, invoicesLoading:false,
      // Stock as the server holds it, per warehouse, fetched on the screen.
      // Which of the three it is matters: an empty inventory, one still
      // loading and one that failed to load read identically as a bare table,
      // and only one of them means the business has no stock.
      stock:null, stockLoading:false, stockError:'',
      // The profit and loss, as the journal reports it.
      statement:null, statementError:'',
      // The password form, open or not. Signing out needs no state of its own.
      password:null, expenses:null,
      roleMatrix:null, userAccounts:null,
      newCust:{name:'', bn:'', type:'Dealer', person:'', mobile:'',
        district:opening((data.customers || []).concat(data.suppliers || []), 'Bogura', 'district'),
        upazila:'', limit:500000, days:15, opening:0},
      cs:{buyer:opening(data.buyers, 'PRAN Agro Business Ltd.'), crop:opening(data.crops, 'Maize'),
        date:today(), rate:34500, transport:15000, other:5000, target:40, alloc:{}},
      ds:{cust:opening(data.customers, 'CUS-002', 'code'), date:today(),
        sp:opening(data.employees, 'Shamim Reza', 'name'), wh:opening(data.warehouses, 'Bogura Depot'),
        terms:'Credit 15 days', paid:0,
        lines:BusinessApp.openingLines(data.products, [
          {pid:'P-1001', qty:120, rate:295, disc:2, bonus:4},
          {pid:'P-1004', qty:60, rate:510, disc:0, bonus:0},
        ], p => ({pid:p.code, qty:'', rate:p.sale, disc:0, bonus:0}))},
      dp:{co:opening(data.companies, 'CMP-01', 'code'), inv:'', date:today(),
        wh:opening(data.warehouses, 'Bogura Depot'), terms:'Credit 30 days', transport:0, other:0,
        lines:BusinessApp.openingLines(data.products, [
          {pid:'P-1001', qty:600, free:24, rate:245, disc:3},
          {pid:'P-1003', qty:200, free:0, rate:180, disc:0},
        ], p => ({pid:p.code, qty:'', free:0, rate:p.pur, disc:0}))},
      batches: data.batches,
      approvals: data.approvals,
      cropLog: data.cropLog,
      saleLog: data.saleLog,
      notifs: data.notifications,
      // One transaction form is open at a time, or none.
      modal: null,
    };
  }

  go(id) {
    return () => {
      this.setState({screen:id, qOpen:false, notifOpen:false, userOpen:false, q:''});
      // The crop master is not part of the workspace payload, so it is
      // fetched when the screen is actually opened rather than on every load.
      if (id === 'crops') this.loadMasterList('crop');
      if (id === 'products') { this.loadMasterList('product'); this.loadSettings(); }
      if (id === 'warehouses') this.loadMasterList('warehouse');
      if (id === 'employees') this.loadMasterList('employee');
      if (id === 'accounts') {
        this.loadStatement();
        this.loadMasterList('account'); this.loadMasterList('category'); this.loadExpenses();
      }
      if (id === 'settings') { this.loadSettings(); this.loadMasterList('method'); this.loadAccessControl(); }
      if (id === 'employees') this.loadAccessControl();
      if (id === 'audit') this.loadAudit();
      if (id === 'dealer-sales') this.loadInvoices();
      if (id === 'inventory') this.loadInventory();
    };
  }
  h(g, k, num) { return e => { const v = num ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value; this.setState(s => { const o = Object.assign({}, s[g]); o[k] = v; return {[g]:o}; }); }; }
  hs(k, v) { return () => this.setState({[k]:v}); }
  tabify(arr, cur, key) { return arr.map(x => ({l:x.l, on:x.k === cur, bg:x.k === cur ? '#fff' : 'transparent',
    color:x.k === cur ? C.ink : C.mut, onClick:this.hs(key, x.k)})); }
  fire(msg, tone) { this.setState({toast:{msg:msg, tone:tone || 'ok'}}); clearTimeout(this._t); this._t = setTimeout(() => this.setState({toast:null}), 3600); }
  componentWillUnmount() { clearTimeout(this._t); }

  /* ------------------------------------------------------------ the account */

  /**
   * Sign out.
   *
   * The API is told first, so the refresh token is revoked server-side rather
   * than merely forgotten by this browser; the boot sequence then runs again
   * and lands on the sign-in card. Without a backend there is no session to
   * end, and the menu does not offer it.
   */
  signOut() {
    this.setState({ userOpen: false });
    if (typeof this.props.onSignOut === 'function') this.props.onSignOut();
  }

  /** Open the change-password form. */
  openPassword() {
    this.setState({
      userOpen: false,
      password: { form: { current: '', next: '', repeat: '' }, error: '', busy: false },
    });
  }

  closePassword() {
    this.setState({ password: null });
  }

  onPasswordField(key) {
    return e => {
      const value = e.target.value;
      this.setState(s =>
        s.password
          ? { password: { ...s.password, form: { ...s.password.form, [key]: value }, error: '' } }
          : null
      );
    };
  }

  /**
   * Change the signed-in user's own password.
   *
   * Every account this system creates is flagged to force this, and until now
   * there was nowhere to do it: the endpoint existed and no screen reached it,
   * so a one-time password stayed the password.
   */
  submitPassword() {
    const state = this.state.password;
    if (!state || state.busy) return;

    const { current, next, repeat } = state.form;
    const problem = !current
      ? 'Enter your current password.'
      : String(next).length < 10
        ? 'Choose a new password of at least 10 characters.'
        : next !== repeat
          ? 'The two new passwords do not match.'
          : next === current
            ? 'The new password is the same as the current one.'
            : null;

    if (problem) {
      this.setState({ password: { ...state, error: problem } });
      return;
    }

    if (!this.repository || typeof this.repository.changePassword !== 'function') {
      this.setState({ password: { ...state, error: 'Passwords cannot be changed without a server.' } });
      return;
    }

    this.setState({ password: { ...state, busy: true, error: '' } });
    this.repository.changePassword(current, next).then(
      () => {
        this.setState({ password: null });
        this.fire('Password changed', 'ok');
      },
      err =>
        this.setState(st =>
          st.password ? { password: { ...st.password, busy: false, error: err.message } } : null
        )
    );
  }

  /** The change-password form, when it is open. */
  passwordModal() {
    const { form, error, busy } = this.state.password;
    return formModalOf({
      open: true,
      title: 'Change password',
      subtitle: 'Applies to your own account, immediately',
      width: '460px',
      fields: [
        field('current', 'Current password', {
          type: 'password', value: form.current, onChange: this.onPasswordField('current'), wide: true,
        }),
        field('next', 'New password', {
          type: 'password', value: form.next, onChange: this.onPasswordField('next'), wide: true,
          hint: 'At least 10 characters',
        }),
        field('repeat', 'New password again', {
          type: 'password', value: form.repeat, onChange: this.onPasswordField('repeat'), wide: true,
        }),
      ],
      error,
      busy,
      submitLabel: 'Change password',
      note: 'Other sessions stay signed in; sign out of them separately',
      onSubmit: () => this.submitPassword(),
      onCancel: () => this.closePassword(),
    });
  }

  /**
   * Whether a real backend is answering.
   *
   * The bundled dashboard lists and party histories exist so the no-backend
   * demo has something to show. With a server behind the app they are somebody
   * else's figures, and on a database with nothing in them they describe
   * nothing at all -- so the screens compute from the working set instead.
   */
  serverBacked() { return !!(this.repository && typeof this.repository.report === 'function'); }

  role() { return this.props.role || 'Admin'; }

  /**
   * Whether the signed-in user holds a permission.
   *
   * With no permission list -- the in-memory fixture, or a demo with no
   * backend -- everything is allowed, because there is no server behind it to
   * be the real check. With one, this decides only what to draw: the API
   * checks the same code on the route regardless.
   */
  may(code) {
    const held = this.props.permissions;
    return !held ? true : held.indexOf(code) > -1;
  }

  /**
   * What the current role grants, where there is no session to ask.
   *
   * The design's role switch has to go on working without a server, and the
   * roles carry their grants either way -- so the question is still asked of
   * the permission rather than of a list of role names.
   */
  roleGrants() {
    const found = (this.permissionData().roleList || []).filter(r => r.code === this.role())[0];
    return found ? found.granted : null;
  }

  /**
   * Whether profit is shown.
   *
   * It used to be a list of role names written here, which meant a role newly
   * granted `report.profit` on the Settings screen went on seeing dashes. The
   * permission is the answer -- the session's where there is one, the role's
   * where there is not -- and the server strips the figures from its side
   * regardless. `showProfit` is the design's own tweak, kept for the demo.
   */
  canProfit() {
    const p = this.props.showProfit;
    if (p !== undefined && !p) return false;
    if (this.props.permissions) return this.may('report.profit');
    const granted = this.roleGrants();
    return !granted || granted.indexOf('report.profit') > -1;
  }
  limit() { return Number(this.props.approvalLimit || 500000); }

  bizOf(v) { const b = this.state.biz; return b === 'dealer' ? v.d : b === 'crop' ? v.c : v.d + v.c; }
  custList() { return this.data.customers.concat(this.state.extraCusts || []); }

  /* ------------------------------------------------- payment / expense / stock */

  /**
   * Open one of the transaction forms.
   *
   * The design never drew these, but its dashboard has always offered them as
   * quick actions. They reuse the design's own modal treatment.
   *
   * @param {'payment'|'expense'|'adjustment'|'transfer'} kind
   * @param {object} [seed] pre-selected values, e.g. paying a specific supplier
   */
  openForm(kind, seed) {
    const form = defaultsFor(kind, this.data, seed);
    this.setState({ modal: { kind, form, error: '', busy: false, invoices: null } });
    if (kind === 'payment') this.loadOpenInvoices(form);
  }

  /**
   * Fetch the invoices a payment can settle.
   *
   * Only the selected party's, and only from a repository that can answer:
   * the in-memory one has no invoice ledger, so the table shows its empty
   * state and the payment simply sits on account.
   */
  loadOpenInvoices(form) {
    if (!this.repository || typeof this.repository.openInvoices !== 'function') {
      this.setState(s => (s.modal ? { modal: { ...s.modal, invoices: [] } } : null));
      return;
    }

    const party = this.partyFor(form);
    if (!party) return;

    this.repository.openInvoices(form.direction, form.partyType, party.id).then(
      invoices => {
        // Ignore a response for a party the user has since changed away from.
        this.setState(s =>
          s.modal && s.modal.form.party === form.party && s.modal.form.direction === form.direction
            ? { modal: { ...s.modal, invoices } }
            : null
        );
      },
      () => this.setState(s => (s.modal ? { modal: { ...s.modal, invoices: [] } } : null))
    );
  }

  /** The master record behind the form's selected party. */
  partyFor(form) {
    const list =
      form.partyType === 'SUPPLIER'
        ? this.data.suppliers
        : form.partyType === 'COMPANY'
          ? this.data.companies
          : this.data.customers;
    return list.find(p => p.code === form.party) || null;
  }

  /** Set one invoice's allocated amount. */
  onAllocationChange(key, value) {
    this.setState(s => {
      if (!s.modal) return null;
      const allocated = { ...s.modal.form.allocated };
      if (value === '' || Number(value) === 0) delete allocated[key];
      else allocated[key] = value;
      return { modal: { ...s.modal, form: { ...s.modal.form, allocated }, error: '' } };
    });
  }

  /** Spread the payment across open invoices, oldest first. */
  autoAllocate() {
    this.setState(s => {
      if (!s.modal) return null;
      const allocated = autoAllocate(s.modal.invoices, s.modal.form.amount);
      return { modal: { ...s.modal, form: { ...s.modal.form, allocated }, error: '' } };
    });
  }

  closeForm() {
    this.setState({ modal: null });
  }

  /** Change handler for one field of the open form. */
  onFormField(key) {
    return e => {
      const value = e.target.value;
      this.setState(s => {
        if (!s.modal) return null;
        const form = { ...s.modal.form, [key]: value };

        // Switching the party type or stock kind invalidates the selection
        // beneath it, so reset to the first item of the new list.
        if (key === 'partyType') {
          form.party = defaultsFor('payment', this.data, { partyType: value }).party;
        }

        // Any of these changes which invoices are on offer, so the entered
        // allocation no longer applies.
        if (key === 'partyType' || key === 'party' || key === 'direction') {
          form.allocated = {};
          queueMicrotask(() => this.loadOpenInvoices(form));
        }
        if (key === 'itemType') {
          form.item = value === 'CROP_BATCH'
            ? (this.data.batches[0] ? this.data.batches[0].id : '')
            : (this.data.products[0] ? this.data.products[0].code : '');
        }

        // Clear a stale validation message as soon as the user edits.
        return { modal: { ...s.modal, form, error: '' } };
      });
    };
  }

  /** Which repository method each form posts to. */
  /**
   * Master kinds whose permission code is not just the kind name.
   *
   * Expense categories and payment methods sit under the modules that own
   * them rather than holding a top-level code, so the check has to say so --
   * looking for `method.edit` when the code is `payment.method.edit` silently
   * hides every control.
   */
  /**
   * The lines a goods form opens with.
   *
   * The worked example is kept only while every product it names is really in
   * the catalogue -- a line pointing at a product that does not exist cannot be
   * posted, because the code resolves to no id and the server refuses the body.
   * Otherwise the form opens on the first product with its own rate and no
   * quantity, which is a line waiting to be filled in rather than a guess.
   *
   * @param {Array} products the catalogue as loaded
   * @param {Array} example  the design's worked lines
   * @param {(product: object) => object} blank a line built from one product
   */
  static openingLines(products, example, blank) {
    const catalogue = products || [];
    const known = new Set(catalogue.map(p => p.code));
    if (example.every(line => known.has(line.pid))) return example;
    return catalogue.length ? [blank(catalogue[0])] : [];
  }

  static PERMISSION_PREFIX = {
    category: 'expense.category',
    productCategory: 'product.category',
    method: 'payment.method',
  };

  static FORM_METHOD = {
    payment: 'createPayment',
    expense: 'createExpense',
    adjustment: 'createStockAdjustment',
    transfer: 'createStockTransfer',
  };

  submitForm() {
    const state = this.state.modal;
    if (!state || state.busy) return;

    const problem = validateForm(state.kind, state.form);
    if (problem) {
      this.setState({ modal: { ...state, error: problem } });
      return;
    }

    const payload = payloadFor(state.kind, state.form, this.data);
    const method = BusinessApp.FORM_METHOD[state.kind];

    this.setState({ modal: { ...state, busy: true, error: '' } });

    this.persist(method, payload).then(
      saved => {
        this.setState({ modal: null });
        const no = saved && saved.txnNo ? saved.txnNo : '';
        const pending = saved && saved.status === 'PENDING_APPROVAL';
        this.fire(
          pending
            ? no + ' submitted for approval'
            : (no ? no + ' — ' : '') + this.formSuccessText(state.kind, state.form),
          pending ? 'warn' : 'ok'
        );
        // A posted payment or adjustment changes balances and stock, so the
        // workspace is refetched rather than patched in place.
        this.reloadWorkspace();
      },
      err => {
        if (err.silent) return;
        this.setState(s => (s.modal ? { modal: { ...s.modal, busy: false, error: err.message } } : null));
      }
    );
  }

  /* ------------------------------------------------------------ master data */

  /**
   * Open the add or edit form for a master record.
   *
   * `row` absent means a new one. The same modal, validator and submit path
   * serve crops, customers, suppliers and companies.
   */
  openMaster(kind, row) {
    this.setState({
      master: { kind, row: row || null, confirm: false, form: masterDefaults(kind, this.masterData(), row), error: '', busy: false },
    });
  }

  /**
   * The workspace, plus the master lists fetched on demand.
   *
   * Employees are not part of the workspace payload, so a form asking which
   * departments exist has to see the rows the employees screen loaded.
   */
  masterData() {
    const rows = this.state.masterRows;
    return {
      ...this.data,
      employees: rows.employee || this.data.employees || [],
      products: rows.product || this.data.products || [],
      // The unit form needs the records, not just the codes every other screen
      // works in, so it can offer the base units and show the conversions.
      unitRecords: rows.unit || this.settingsData().units || [],
      // The categories and brands that exist, rather than the ones other
      // products happen to use -- which is what made the first one impossible.
      productCategories: this.classifications('categories'),
      brands: this.classifications('brands'),
    };
  }

  /**
   * Ask before retiring a record.
   *
   * Retiring changes what every other screen offers, so it gets a deliberate
   * second step rather than a single click in a table row.
   */
  confirmRetire(kind, row) {
    this.setState({ master: { kind, row, confirm: true, form: {}, error: '', busy: false } });
  }

  closeMaster() {
    this.setState({ master: null });
  }

  /** Change handler for one field of the open master form. */
  onMasterField(key) {
    return e => {
      const value = e.target.value;
      this.setState(s =>
        s.master ? { master: { ...s.master, form: { ...s.master.form, [key]: value }, error: '' } } : null
      );
    };
  }

  /** Save a new or edited master record, or carry out a confirmed retirement. */
  submitMaster() {
    const state = this.state.master;
    if (!state || state.busy) return;

    if (state.confirm) return this.retireMaster(state);

    const problem = validateMaster(state.kind, state.form);
    if (problem) {
      this.setState({ master: { ...state, error: problem } });
      return;
    }

    const payload = masterPayload(state.kind, state.form);
    this.setState({ master: { ...state, busy: true, error: '' } });

    const write = state.row
      ? this.persist('updateMaster', state.kind, state.row.id ?? state.row.code, payload)
      : this.persist('createMaster', state.kind, payload);

    write.then(
      saved => {
        this.setState({ master: null });
        const code = (saved && saved.code) || '';
        this.fire(
          (code ? code + ' — ' : '') + payload.name + (state.row ? ' updated' : ' added'),
          'ok'
        );
        this.afterMasterChange(state.kind);
      },
      err => this.reportMasterError(err)
    );
  }

  /**
   * Put a retired record back.
   *
   * No confirmation: it restores something rather than removing it, and is
   * undone by the retire it reverses.
   */
  restoreMaster(kind, row) {
    this.persist('restoreMaster', kind, row.id ?? row.code).then(
      () => {
        this.fire(row.code + ' — ' + row.name + ' restored', 'ok');
        this.afterMasterChange(kind);
      },
      err => { if (!err.silent) this.fire(err.message, 'danger'); }
    );
  }

  retireMaster(state) {
    this.setState({ master: { ...state, busy: true, error: '' } });
    this.persist('retireMaster', state.kind, state.row.id ?? state.row.code).then(
      () => {
        this.setState({ master: null });
        this.fire(state.row.code + ' — ' + state.row.name + ' retired', 'ok');
        this.afterMasterChange(state.kind);
      },
      err => this.reportMasterError(err)
    );
  }

  /**
   * Show why a master write was refused, in the form that caused it.
   *
   * The server refuses to retire a party that still owes money and says how
   * much; that belongs next to the button, not in a toast that disappears.
   */
  reportMasterError(err) {
    if (err.silent) return;
    this.setState(s => (s.master ? { master: { ...s.master, busy: false, error: err.message } } : null));
  }

  /** Fetch the posted expense vouchers behind the Expense tab. */
  loadExpenses() {
    if (!this.repository || typeof this.repository.expenses !== 'function') return;
    this.repository.expenses().then(
      result => this.setState({ expenses: result }),
      () => {}
    );
  }

  /** A master change moves what every picker offers, so refetch rather than patch. */
  afterMasterChange(kind) {
    this.reloadWorkspace();
    this.loadMasterList(kind);
    // Units and payment methods are maintained from the Settings screen, and
    // that screen reads them out of the settings payload.
    if (kind === 'unit' || kind === 'method' || kind === 'productCategory' || kind === 'brand') {
      this.loadSettings();
    }
  }

  /**
   * Load one master list from the repository.
   *
   * Only the crops screen needs this today -- customers, suppliers and
   * companies already arrive with the workspace -- but every kind goes through
   * the same path so the next screen is a call, not a mechanism.
   */
  loadMasterList(kind) {
    if (!this.repository || typeof this.repository.listMaster !== 'function') return;
    this.repository.listMaster(kind).then(
      rows => this.setState(s => ({ masterRows: { ...s.masterRows, [kind]: rows } })),
      () => {}
    );
  }

  /* ---------------------------------------------------------------- settings */

  /**
   * Load the Settings screen's working set.
   *
   * Configuration is not part of the workspace every screen boots from, so it
   * is fetched when the screen is opened. Until it arrives -- and for good, with
   * no backend -- the bundled fallback stands in, which is why the panels are
   * never empty.
   */
  loadSettings() {
    if (!this.repository || typeof this.repository.settings !== 'function') return;
    this.repository.settings().then(
      settings => this.setState({ settings }),
      () => {}
    );
  }

  /**
   * Load the roles, their grants and the logins holding them.
   *
   * The matrix also arrives inside the settings payload, but the Employees
   * screen needs the roles without needing `settings.view`, so it is fetched
   * on its own and whichever copy is fresher is the one the screens read.
   */
  loadAccessControl() {
    if (this.repository && typeof this.repository.roles === 'function') {
      this.repository.roles().then(
        roleMatrix => this.setState({ roleMatrix }),
        () => {}
      );
    }
    if (this.mayUsers() && this.repository && typeof this.repository.userAccounts === 'function') {
      this.repository.userAccounts().then(
        userAccounts => this.setState({ userAccounts }),
        () => {}
      );
    }
  }

  /** The settings in hand: the server's once fetched, the bundled ones until then. */
  settingsData() {
    return this.state.settings || SETTINGS;
  }

  /**
   * The maintained categories or brands.
   *
   * With a server answering, the bundled lists are not an acceptable stand-in
   * while the real ones are in flight: they name four categories this business
   * has never heard of, and choosing one is refused on save. Better to offer
   * nothing for the moment it takes them to arrive.
   */
  classifications(key) {
    if (this.serverBacked()) return (this.state.settings && this.state.settings[key]) || [];
    return SETTINGS[key] || [];
  }

  /** The roles and their grants, from whichever call brought them last. */
  permissionData() {
    return this.state.roleMatrix || this.settingsData().permissions;
  }

  /** The logins, once they have been fetched; the team stands in until then. */
  accountsData() {
    if (this.state.userAccounts) return this.state.userAccounts;
    const team = this.state.masterRows.employee || this.data.employees || [];
    return team.map(e => ({
      id: e.id, employeeId: e.id, employeeCode: e.code, name: e.name,
      designation: e.designation, username: '', roles: e.role && e.role !== '\u2014' ? [e.role] : [],
      role: e.role, active: e.status !== 'Retired', status: e.status === 'Retired' ? 'Disabled' : 'Active',
    }));
  }

  /** Whether the signed-in user may change configuration. */
  maySettings() { return this.may('settings.edit'); }

  /** Whether they may cut the roles themselves, and maintain the logins. */
  mayRoles() { return this.may('role.edit'); }
  mayUsers() { return this.may('user.manage'); }

  /**
   * Open one of the settings forms.
   *
   * `row` is the record the panel was showing, so the form opens on what is
   * there rather than on a blank.
   */
  openSettings(kind, row) {
    this.setState({
      settingsForm: {
        kind,
        row: row || {},
        form: settingsDefaults(kind, row || {}),
        error: '',
        busy: false,
      },
    });
  }

  closeSettings() {
    this.setState({ settingsForm: null });
  }

  /**
   * Flip one entry of a set the form is holding -- a permission, a role.
   *
   * The form keeps the set rather than the switch positions, so the payload is
   * what it says it is: the codes that should end up granted.
   */
  onSettingsToggle(key, value) {
    this.setState(s => {
      if (!s.settingsForm) return null;
      const held = s.settingsForm.form[key] || [];
      const next = held.indexOf(value) > -1 ? held.filter(v => v !== value) : held.concat([value]);
      return { settingsForm: { ...s.settingsForm, form: { ...s.settingsForm.form, [key]: next }, error: '' } };
    });
  }

  onSettingsField(key) {
    return e => {
      const value = e.target.value;
      this.setState(s =>
        s.settingsForm
          ? { settingsForm: { ...s.settingsForm, form: { ...s.settingsForm.form, [key]: value }, error: '' } }
          : null
      );
    };
  }

  /** Which repository call each settings form submits through. */
  static SETTINGS_WRITE = {
    company: 'updateOrganization',
    fiscalYear: 'createFiscalYear',
    numbering: 'updateNumbering',
    limit: 'updateApprovalRule',
    notification: 'updateNotificationRule',
  };

  /**
   * The repository call one settings form makes, and its arguments.
   *
   * Most panels edit one record addressed by an id, which the table above
   * covers. Roles and logins do not fit that: a grant is a role and a set of
   * codes, a new role has no id yet, and a password reset takes neither a
   * record nor a patch. Rather than bend those into a shape they are not, the
   * kinds that differ say what they call.
   */
  settingsCall(kind, row, payload) {
    if (kind === 'role') {
      return row.id
        ? { method: 'updateRole', args: [row.id, payload] }
        : { method: 'createRole', args: [payload] };
    }
    if (kind === 'grants') {
      return { method: 'setRolePermissions', args: [row.roleId, payload.scope, payload.permissions] };
    }
    if (kind === 'login') return { method: 'createUserAccount', args: [payload] };
    if (kind === 'roleAssign') return { method: 'updateUserAccount', args: [row.id, payload] };
    if (kind === 'password') {
      return { method: 'resetUserPassword', args: [row.id, payload.password] };
    }

    const method = BusinessApp.SETTINGS_WRITE[kind];
    // The company profile and a new financial year are addressed by nothing;
    // numbering is addressed by its document type, a rule by its id.
    const target =
      kind === 'numbering' ? row.docType
        : kind === 'limit' || kind === 'notification' ? row.id
          : null;
    return { method, args: target === null ? [payload] : [target, payload] };
  }

  /** Whether this kind changed access rather than configuration. */
  static ACCESS_KINDS = ['role', 'grants', 'login', 'roleAssign', 'password'];

  submitSettings() {
    const state = this.state.settingsForm;
    if (!state || state.busy) return;

    const problem = validateSettings(state.kind, state.form, state.row);
    if (problem) {
      this.setState({ settingsForm: { ...state, error: problem } });
      return;
    }

    const payload = settingsPayload(state.kind, state.form, state.row);
    this.setState({ settingsForm: { ...state, busy: true, error: '' } });

    const { method, args } = this.settingsCall(state.kind, state.row, payload);

    this.persist(method, ...args).then(
      () => {
        this.setState({ settingsForm: null });
        this.fire(this.settingsSavedText(state.kind, state.row, state.form), 'ok');
        if (BusinessApp.ACCESS_KINDS.indexOf(state.kind) > -1) this.afterAccessChange();
        else this.afterSettingsChange();
      },
      err => {
        if (err.silent) return;
        this.setState(s =>
          s.settingsForm ? { settingsForm: { ...s.settingsForm, busy: false, error: err.message } } : null
        );
      }
    );
  }

  settingsSavedText(kind, row, form) {
    if (kind === 'company') return 'Company profile updated';
    if (kind === 'fiscalYear') return 'Financial year added';
    if (kind === 'numbering') return `${row.label} numbering updated`;
    if (kind === 'limit') return `${row.entityLabel} limit updated`;
    if (kind === 'role') return row.id ? `${form.name} updated` : `Role ${form.name} added`;
    if (kind === 'grants') {
      const held = form.granted.length;
      return held
        ? `${row.roleName} now has ${held} of ${row.permissions.length} on ${row.moduleLabel.toLowerCase()}`
        : `${row.roleName} no longer has access to ${row.moduleLabel.toLowerCase()}`;
    }
    if (kind === 'login') return `Login created for ${row.nameOf?.[form.employee] || form.username}`;
    if (kind === 'roleAssign') return `${row.name} is now ${form.roles.join(', ')}`;
    if (kind === 'password') return `Password reset — ${row.name} is signed out everywhere`;
    return `${row.name} updated`;
  }

  /**
   * A change to access moves what the signed-in user themselves may do.
   *
   * The roles, the logins and the settings copy of the matrix all have to be
   * re-read; so does the workspace, because a permission just granted or taken
   * away changes which screens and figures the session is entitled to.
   */
  afterAccessChange() {
    this.loadAccessControl();
    this.loadSettings();
    this.reloadWorkspace();
  }

  /** Delete a role nobody holds, after asking. */
  removeRole(role) {
    if (!window.confirm(`Delete the role ${role.name}? Nobody holds it.`)) return;
    this.persist('deleteRole', role.id).then(
      () => { this.fire(`Role ${role.name} deleted`, 'ok'); this.afterAccessChange(); },
      err => { if (!err.silent) this.fire(err.message, 'danger'); }
    );
  }

  /** Switch a login on or off from the row it sits on. */
  toggleLogin(account) {
    this.persist('updateUserAccount', account.id, { active: !account.active }).then(
      () => {
        this.fire(`Login ${account.username} ${account.active ? 'disabled' : 'enabled'}`, 'ok');
        this.afterAccessChange();
      },
      err => { if (!err.silent) this.fire(err.message, 'danger'); }
    );
  }

  /**
   * A settings change moves what the rest of the app does.
   *
   * The company name is in the sidebar, the current financial year is in the
   * header and the valuation method decides how a sale is costed, so the
   * workspace is refetched alongside the settings themselves.
   */
  afterSettingsChange() {
    this.loadSettings();
    this.reloadWorkspace();
  }

  /** Switch a notification rule on or off from the row it sits on. */
  toggleNotification(rule) {
    this.persist('updateNotificationRule', rule.id, { active: !rule.active }).then(
      () => {
        this.fire(`${rule.name} ${rule.active ? 'switched off' : 'switched on'}`, 'ok');
        this.loadSettings();
      },
      err => { if (!err.silent) this.fire(err.message, 'danger'); }
    );
  }

  /** Close, reopen or adopt a financial year. */
  changeFiscalYear(year, changes, message) {
    this.persist('updateFiscalYear', year.id, changes).then(
      () => { this.fire(message, 'ok'); this.afterSettingsChange(); },
      err => { if (!err.silent) this.fire(err.message, 'danger'); }
    );
  }

  /**
   * Choose how stock is costed.
   *
   * This used to change a value in browser memory that a reload put back and
   * the server never saw. It is a property of the organisation, so it is saved
   * as one, and the crop sales screen posts with whatever it says.
   */
  setValuation(label) {
    const method = label === 'FIFO' ? 'FIFO' : 'WEIGHTED_AVERAGE';
    if (label === this.state.valuation) return;
    this.setState({ valuation: label });
    this.persist('updateOrganization', { valuation: method }).then(
      () => { this.fire(`Inventory valued ${label === 'FIFO' ? 'FIFO' : 'at weighted average'} from now on`, 'ok'); this.afterSettingsChange(); },
      err => {
        // Put the buttons back where they were: nothing was saved.
        this.setState({ valuation: label === 'FIFO' ? 'Weighted Average' : 'FIFO' });
        if (!err.silent) this.fire(err.message, 'danger');
      }
    );
  }

  /* -------------------------------------------------------------- statements */

  /**
   * Load the profit and loss.
   *
   * The screen rendered a fixture: figures that never moved, under a heading
   * reading Net profit. They are read from the ledger now, which is the only
   * place a profit can be said to come from.
   */
  loadStatement() {
    if (!this.repository || typeof this.repository.profitAndLoss !== 'function') return;
    this.setState({ statementError: '' });
    this.repository.profitAndLoss().then(
      statement => this.setState({ statement, statementError: '' }),
      err => this.setState({
        statement: null,
        // A statement that failed to load must not read as a business that
        // earned nothing.
        statementError: err && err.message ? err.message : 'The profit and loss could not be loaded.',
      })
    );
  }

  /* --------------------------------------------------------------- inventory */

  /**
   * Load stock as the server holds it.
   *
   * The screen built its dealer lines out of the product master, which knows
   * how much of a product exists in total and not where any of it is -- so
   * every line was labelled with one warehouse name written into the code. The
   * stock table knows, and `GET /inventory` reports it a line per warehouse.
   */
  loadInventory() {
    if (!this.repository || typeof this.repository.inventory !== 'function') return;
    this.setState({ stockLoading: true, stockError: '' });

    // Every line, not the first page of them. The endpoint caps a page at 200
    // and the screen has no pager: stopping at the cap would quietly drop
    // stock from the table and from the totals beneath it, which is a wrong
    // valuation rather than a short list.
    const PAGE = 200;
    const gather = (page, sofar) =>
      this.repository.inventory({ page, pageSize: PAGE }).then(result => {
        const rows = sofar.concat(result.rows || []);
        const total = Number(result.meta && result.meta.total) || rows.length;
        return rows.length >= total || !(result.rows || []).length
          ? rows
          : gather(page + 1, rows);
      });

    gather(1, []).then(
      rows => this.setState({ stock: rows, stockLoading: false, stockError: '' }),
      err => this.setState({
        stock: null,
        stockLoading: false,
        // Kept rather than swallowed: an inventory that failed to load must
        // not be reported to the business as an inventory of nothing.
        stockError: err && err.message ? err.message : 'Stock could not be loaded.',
      })
    );
  }

  /* ---------------------------------------------------------------- invoices */

  /**
   * Load the invoices raised so far.
   *
   * The dealer sales screen has only ever been a form for writing one. What a
   * business needs beside it is the ones already written: to look at, to check
   * against a payment, and to print again when a customer mislays theirs.
   */
  loadInvoices() {
    if (!this.repository || typeof this.repository.invoices !== 'function') return;
    this.setState({ invoicesLoading: true });
    this.repository.invoices({ pageSize: 100 }).then(
      result => this.setState({ invoices: result.rows || [], invoicesLoading: false }),
      () => this.setState({ invoices: [], invoicesLoading: false })
    );
  }

  /**
   * Fetch one invoice in full and hand it to the browser to print.
   *
   * The row on the list carries a total and a status; a printed invoice needs
   * the lines, both parties and the letterhead, so it is fetched rather than
   * assembled out of whatever the list happened to be holding.
   */
  printInvoice(row) {
    if (!this.repository || typeof this.repository.invoice !== 'function') {
      this.fire('Invoices can only be printed with a server behind the app.', 'warn');
      return;
    }
    this.repository.invoice(row.id).then(
      invoice => {
        if (!openInvoice(invoice)) {
          // Nothing opened, and saying so beats a window that silently is not there.
          this.fire('Allow pop-ups for this site to print an invoice.', 'warn');
          return;
        }
        this.fire(row.no + ' opened for printing', 'ok');
      },
      err => this.fire('Could not open ' + row.no + ' — ' + err.message, 'danger')
    );
  }

  /** The invoices raised, as a table with a print action on every row. */
  invoiceList() {
    const rows = this.state.invoices || [];
    const settled = rows.filter(r => (Number(r.due) || 0) <= 0).length;

    return table(
      [column('Invoice'), column('Date'), column('Customer'), column('Items', 'right'),
        column('Amount', 'right'), column('Paid', 'right'), column('Due', 'right'),
        column('Status', 'center'), column('', 'right')],
      rows.map(r => ({cells:[
        cell(r.no, {mono:true, weight:'600'}),
        cell(shortDate(r.date), {color:C.mut}),
        cell(r.customer, {weight:'600'}),
        cell(int(r.items), {align:'right', mono:true, color:C.mut}),
        cell(money(r.amount), {align:'right', mono:true, weight:'600'}),
        cell(money(r.paid), {align:'right', mono:true, color:C.crop}),
        cell(r.due > 0 ? money(r.due) : '—', {align:'right', mono:true, weight:'600',
          color:r.due > 0 ? C.dngr : C.mut}),
        cell(STATUS_LABELS[r.status] || r.status, {align:'center', badge:true,
          badgeBg:r.status === 'POSTED' ? C.cropBg : r.status === 'CANCELLED' ? '#FBEEF0' : C.warnBg,
          badgeFg:r.status === 'POSTED' ? C.crop : r.status === 'CANCELLED' ? C.dngr : C.warn}),
        cell('', {align:'right', actions:[{label:'Print', onClick:() => this.printInvoice(r)}]}),
      ]})),
      {
        maxH:'420px',
        emptyTitle:this.state.invoicesLoading ? 'Loading invoices…' : 'No invoices yet',
        emptyNote:this.state.invoicesLoading ? '' : 'Post one above and it appears here, ready to print.',
        footNote:rows.length
          ? rows.length + (rows.length === 1 ? ' invoice · ' : ' invoices · ') + settled + ' settled'
          : '',
        footTotal:rows.length
          ? 'Outstanding ' + money(rows.reduce((t, r) => t + (Number(r.due) || 0), 0))
          : '',
      }
    );
  }
  /* ------------------------------------------------------------- audit trail */

  /**
   * Load the audit trail.
   *
   * Every write in the API writes an audit row inside the same transaction, so
   * this has always been real; the screen was showing a fixture beside it.
   */
  loadAudit() {
    if (!this.repository || typeof this.repository.audit !== 'function') return;
    this.setState({ auditLoading: true });
    this.repository.audit({ pageSize: 120 }).then(
      result => this.setState({ auditRows: result.rows || [], auditLoading: false }),
      () => this.setState({ auditRows: [], auditLoading: false })
    );
  }

  /**
   * Whether the signed-in user may do something to master data.
   *
   * This only decides what to draw. Every one of these routes checks the same
   * permission on the server, so hiding a button is a courtesy and not the
   * control. Without a permission list -- the in-memory fixture, or the demo
   * with no backend -- nothing is hidden, because there is no server to be
   * the real check.
   */
  mayMaster(kind, action) {
    const held = this.props.permissions;
    return !held ? true : held.indexOf(`${BusinessApp.PERMISSION_PREFIX[kind] || kind}.${action}`) > -1;
  }

  /** The add / edit / retire controls for one master screen. */
  masterControls(kind, row) {
    return {
      canAdd: this.mayMaster(kind, 'create'),
      canEdit: !!row && this.mayMaster(kind, 'edit'),
      canRetire: !!row && this.mayMaster(kind, 'delete'),
      addLabel: `Add ${kind}`,
      onAdd: () => this.openMaster(kind),
      onEdit: () => this.openMaster(kind, row),
      onRetire: () => this.confirmRetire(kind, row),
    };
  }

  /** Row actions for a master table. */
  masterRowActions(kind, row) {
    const actions = [];
    if (this.mayMaster(kind, 'edit')) {
      actions.push({ label: 'Edit', onClick: () => this.openMaster(kind, row) });
    }
    if (this.mayMaster(kind, 'delete')) {
      actions.push({ label: 'Retire', danger: true, onClick: () => this.confirmRetire(kind, row) });
    }
    return actions;
  }

  /** The warehouses screen: the godowns, and what each one is holding. */
  warehouses() {
    const rows = this.state.masterRows.warehouse || [];
    const active = rows.filter(w => w.status !== 'Closed');

    return {
      ...this.masterControls('warehouse', null),
      addLabel: 'Add warehouse',
      table: table(
        [
          column('Code'),
          column('Warehouse'),
          column('District'),
          column('Stock lines', 'right'),
          column('Quantity', 'right'),
          column('Stock value', 'right'),
          column('', 'right'),
        ],
        active.map(w => ({
          cells: [
            cell(w.code, { mono: true, color: C.mut }),
            cell(w.name, { weight: '600' }),
            cell(w.district || '—', { color: C.mut }),
            cell(w.lines ? String(w.lines) : '—', { align: 'right', mono: true, color: C.mut }),
            cell(w.quantity ? dec2(w.quantity) : '—', { align: 'right', mono: true, weight: '600' }),
            cell(w.value ? money(w.value) : '—', { align: 'right', mono: true }),
            cell('', { align: 'right', actions: this.masterRowActions('warehouse', w) }),
          ],
        })),
        {
          emptyTitle: 'No warehouses yet',
          emptyNote: 'Add a godown and stock can be received into it.',
          footNote: active.length + (active.length === 1 ? ' warehouse' : ' warehouses'),
          footTotal: 'Stock value ' + money(active.reduce((t, w) => t + (w.value || 0), 0)),
        }
      ),
    };
  }

  /** The employees screen: the team directory. */
  employees() {
    const rows = this.state.masterRows.employee || this.data.employees || [];
    const active = rows.filter(e => e.status !== 'Retired');
    const departments = new Set(active.map(e => e.department).filter(Boolean));

    // The logins, keyed by the employee they belong to, so each row knows
    // whether this person can sign in and as what.
    const accounts = this.accountsData();
    const loginFor = new Map(
      accounts.filter(a => a.employeeId != null).map(a => [a.employeeId, a])
    );
    const roles = this.permissionData().roleList || [];
    const withoutLogin = active.filter(e => !loginFor.has(e.id));

    return {
      ...this.masterControls('employee', null),
      addLabel: 'Add employee',
      // Giving someone a login is a different act from adding them to the
      // directory, and needs a different permission, so it is its own control.
      login:{
        canAdd: this.mayUsers() && withoutLogin.length > 0,
        label: 'Give a login',
        note: withoutLogin.length
          ? `${withoutLogin.length} without a login`
          : 'Everyone has a login',
        onAdd: () => this.openSettings('login', {
          employeeOptions: withoutLogin.map(e => `${e.name} (${e.code})`),
          employeeIds: Object.fromEntries(withoutLogin.map(e => [`${e.name} (${e.code})`, e.id])),
          nameOf: Object.fromEntries(withoutLogin.map(e => [`${e.name} (${e.code})`, e.name])),
          roleOptions: roles,
          roles: [],
        }),
      },
      table: table(
        [
          column('ID'),
          column('Name'),
          column('Designation'),
          column('Department'),
          column('Mobile'),
          column('System role'),
          column('Joined'),
          column('', 'right'),
        ],
        active.map(e => ({
          cells: [
            cell(e.code, { mono: true, color: C.mut }),
            cell(e.name, { weight: '600' }),
            cell(e.designation || '—'),
            cell(e.department || '—', { color: C.mut }),
            cell(e.mobile || '—', { mono: true }),
            // Someone with no login is not a lesser employee, so it reads as a
            // plain dash rather than an empty badge. A disabled login says so,
            // because "Sales" beside an account that cannot sign in is a lie.
            this.roleCell(loginFor.get(e.id), e),
            cell(e.joined || '—', { color: C.mut }),
            cell('', {
              align: 'right',
              actions: this.masterRowActions('employee', e)
                .concat(this.loginActions(loginFor.get(e.id), roles)),
            }),
          ],
        })),
        {
          emptyTitle: 'No employees yet',
          emptyNote: 'Add the team and each one can be given a system role.',
          footNote: active.length + (active.length === 1 ? ' employee' : ' employees')
            + ' · ' + departments.size + (departments.size === 1 ? ' department' : ' departments'),
        }
      ),
    };
  }

  /**
   * What the System role column shows for one person.
   *
   * The roles a login holds, or a dash where there is no login: someone
   * without one is not a lesser employee. A login that has been switched off
   * says so rather than showing the role it would have had.
   */
  roleCell(account, employee) {
    const held = account ? account.roles : employee.role && employee.role !== '—' ? [employee.role] : [];
    if (!held.length) return cell('—', { color: C.mut });
    if (account && account.active === false) {
      return cell(`${held.join(', ')} · disabled`, { badge: true, badgeBg: '#F0EEE9', badgeFg: C.mut });
    }
    return cell(held.join(', '), { badge: true, badgeBg: C.dealBg, badgeFg: C.deal });
  }

  /** The login controls on one employee row, for whoever may maintain logins. */
  loginActions(account, roles) {
    if (!this.mayUsers() || !account) return [];
    return [
      {
        label: 'Change role',
        onClick: () => this.openSettings('roleAssign', { ...account, roleOptions: roles }),
      },
      { label: 'Reset password', onClick: () => this.openSettings('password', account) },
      {
        label: account.active ? 'Disable login' : 'Enable login',
        danger: account.active,
        onClick: () => this.toggleLogin(account),
      },
    ];
  }

  /** The products screen: the dealer catalogue, with what each line is holding. */
  products() {
    const rows = this.state.masterRows.product || this.data.products || [];
    const active = rows.filter(p => p.status !== 'Retired');
    const low = active.filter(p => p.min && p.stock < p.min);

    return {
      ...this.masterControls('product', null),
      addLabel: 'Add product',
      table: table(
        [
          column('Code'),
          column('Product'),
          column('Category'),
          column('Unit'),
          column('Purchase', 'right'),
          column('Sale', 'right'),
          column('In stock', 'right'),
          column('', 'right'),
        ],
        active.map(p => ({
          cells: [
            cell(p.code, { mono: true, color: C.mut }),
            cell(p.name, { weight: '600', sub: p.brand }),
            cell(p.cat || '—', { color: C.mut }),
            cell(p.unit, { color: C.mut }),
            cell(money(p.pur), { align: 'right', mono: true, color: C.mut }),
            cell(money(p.sale), { align: 'right', mono: true, weight: '600' }),
            // Below the minimum reads as a warning, since that is the number
            // the reorder decision is made on.
            cell(int(p.stock) + ' ' + p.unit, {
              align: 'right', mono: true, weight: '600',
              color: p.min && p.stock < p.min ? C.dngr : C.ink,
              sub: p.min && p.stock < p.min ? 'below minimum ' + int(p.min) : '',
            }),
            cell('', { align: 'right', actions: this.masterRowActions('product', p) }),
          ],
        })),
        {
          emptyTitle: 'No products yet',
          emptyNote: 'Add the first product and it becomes available to buy and sell.',
          footNote: active.length + (active.length === 1 ? ' product' : ' products')
            + (low.length ? ' · ' + low.length + ' below minimum' : ''),
          // The carrying value where the server reports it, so this agrees with
          // the warehouses screen and the dashboard; the fixture has no
          // average cost, so it falls back to the catalogue rate.
          footTotal: 'Stock value '
            + money(active.reduce((t, p) => t + (p.value ?? p.stock * p.pur), 0)),
        }
      ),
    };
  }

  /** The crops screen: the bulk-trading master, with what each crop is holding. */
  crops() {
    const rows = this.state.masterRows.crop || [];
    const active = rows.filter(c => c.status !== 'Retired');
    const held = active.reduce((t, c) => t + (Number(c.value) || 0), 0);

    return {
      ...this.masterControls('crop', null),
      addLabel: 'Add crop',
      table: table(
        [
          column('Code'),
          column('Crop'),
          column('Unit'),
          column('Last rate', 'right'),
          column('In stock', 'right'),
          column('Stock value', 'right'),
          column('Status', 'center'),
          column('', 'right'),
        ],
        active.map(c => ({
          cells: [
            cell(c.code, { mono: true, color: C.mut }),
            cell(c.name, { weight: '600', sub: c.last ? 'last received ' + c.last : '' }),
            cell(c.unit, { color: C.mut }),
            cell(c.rate ? money(c.rate) : '—', { align: 'right', mono: true, color: C.mut }),
            // Crop quantities are fractional, so rounding 15.61 MT to 16 would
            // misstate what the godown holds.
            cell(c.quantity ? dec2(c.quantity) + ' ' + c.unit : '—', { align: 'right', mono: true, weight: '600' }),
            cell(c.value ? money(c.value) : '—', { align: 'right', mono: true }),
            cell(c.status, {
              align: 'center', badge: true,
              badgeBg: c.status === 'Active' ? C.cropBg : C.warnBg,
              badgeFg: c.status === 'Active' ? C.crop : C.warn,
            }),
            cell('', { align: 'right', actions: this.masterRowActions('crop', c) }),
          ],
        })),
        {
          emptyTitle: 'No crops yet',
          emptyNote: 'Add the first crop and it becomes available to purchase, store and sell.',
          footNote: active.length + (active.length === 1 ? ' crop' : ' crops'),
          footTotal: 'Stock value ' + money(held),
        }
      ),
    };
  }

  /** The open master modal: the add/edit form, or the retire confirmation. */
  masterModal() {
    const state = this.state.master;
    // The noun, not the kind: "Retire payment method", not "Retire method".
    const noun = nounFor(state.kind);

    if (state.confirm) {
      return formModalOf({
        open: true,
        title: `Retire ${noun}`,
        subtitle: `${state.row.code} · ${state.row.name}`,
        fields: [],
        summary: [{ k: 'Status after saving', v: 'Retired', good: false }],
        error: state.error,
        busy: state.busy,
        submitLabel: 'Retire',
        note: 'Nothing is deleted — past documents keep naming it, and it stops being offered on new ones',
        onSubmit: () => this.submitMaster(),
        onCancel: () => this.closeMaster(),
      });
    }

    return buildMasterModal(state.kind, state, this.masterData(), {
      onField: key => this.onMasterField(key),
      onSubmit: () => this.submitMaster(),
      onCancel: () => this.closeMaster(),
    });
  }

  formSuccessText(kind, form) {
    const amount = money(Number(form.amount) || 0);
    if (kind === 'payment') {
      return form.direction === 'RECEIPT' ? amount + ' received' : amount + ' paid';
    }
    if (kind === 'expense') return amount + ' expense recorded';
    if (kind === 'transfer') {
      return Number(form.quantity) + ' moved from ' + form.fromWarehouse + ' to ' + form.toWarehouse;
    }
    return 'stock adjustment recorded';
  }

  /**
   * Refresh the working set after a write that moves money or stock.
   *
   * Cheaper than patching every derived figure by hand, and it cannot drift
   * from what the server actually holds.
   */
  reloadWorkspace() {
    if (!this.repository || typeof this.repository.load !== 'function') return;
    this.repository.load().then(
      data => {
        this.data = data;
        this.scheduleRender();
        this.loadDashboard();
      },
      () => {}
    );
  }

  /**
   * Send a write through the repository. Falls back to resolving the payload
   * unchanged when no repository is wired, so the logic stays testable.
   *
   * A write already in flight blocks another of the same kind: double-clicking
   * Post must never create two transactions. The guard is here rather than on
   * the button so it holds however the action is triggered.
   */
  persist(method, ...args) {
    if (!this._inFlight) this._inFlight = new Set();

    if (this._inFlight.has(method)) {
      // A second click while the first is still saving is ignored rather than
      // reported: the user did nothing wrong, and an error toast would be noise.
      const ignored = /** @type {Error & {silent?: boolean}} */ (new Error('Already saving.'));
      ignored.silent = true;
      return Promise.reject(ignored);
    }
    this._inFlight.add(method);
    this.setState({ busy: method });
    // Immediate feedback, replaced by the outcome when the write settles.
    this.fire('Saving…', 'ok');

    const done = () => {
      this._inFlight.delete(method);
      this.setState({ busy: null });
    };

    const call =
      this.repository && typeof this.repository[method] === 'function'
        ? this.repository[method](...args)
        : Promise.resolve(args[0]);

    return call.then(
      (value) => { done(); return value; },
      (err) => { done(); throw err; }
    );
  }

  saveCustomer() {
    const f = this.state.newCust;
    if (!f.name.trim() || !f.mobile.trim()) { this.fire('Customer name and mobile number are required.', 'danger'); return; }
    const code = 'CUS-' + ('00' + (this.data.customers.length + (this.state.extraCusts || []).length + 1)).slice(-3);
    const c = {code:code, name:f.name, bn:f.bn || '', type:f.type, person:f.person, mobile:f.mobile, district:f.district, upazila:f.upazila,
      limit:+f.limit || 0, days:+f.days || 0, sales:0, coll:0, out:+f.opening || 0, last:'—', b30:+f.opening || 0, b60:0, b90:0, b90p:0};
    this.persist('createCustomer', c).then(saved => {
      this.setState(s => ({extraCusts:(s.extraCusts || []).concat([saved]), custModal:false, custSel:code,
        ds:Object.assign({}, s.ds, {cust:code}),
        newCust:{name:'', bn:'', type:'Dealer', person:'', mobile:'', district:'Bogura', upazila:'', limit:500000, days:15, opening:0}}));
      this.fire(code + ' — ' + f.name + ' created and selected on this invoice', 'ok');
    }).catch(err => { if (!err.silent) this.fire('Could not save customer — ' + err.message, 'danger'); });
  }

  calcCP() {
    const f = this.state.cp, S = this.state;
    const gross = +f.qty || 0, ded = gross * (+f.moist || 0) / 100, net = gross - ded;
    const pv = net * (+f.rate || 0);
    const add = (+f.transport || 0) + (+f.loading || 0) + (+f.unloading || 0) + (+f.other || 0);
    const total = pv + add, cpu = net ? total / net : 0;
    const last = this.data.lastRate[f.crop] || 0, diff = (+f.rate || 0) - last;
    const sup = this.data.suppliers.filter(s => s.code === f.sup)[0] || this.data.suppliers[0] || BLANK_PARTY;
    const adv = +f.advance || 0;
    return {v:f, sup:sup, supOutText:money(sup.out), supPurText:lakh(sup.pur), grossText:dec2(gross) + ' ' + f.unit, dedText:'− ' + dec2(ded) + ' ' + f.unit,
      netText:dec2(net) + ' ' + f.unit, net:net, pvText:money(pv), addText:money(add), totalText:money(total), total:total,
      cpuText:money(cpu), cpuNum:cpu, perUnitLabel:'per ' + f.unit, lastText:money(last),
      diffText:(diff >= 0 ? '+' : '−') + money(Math.abs(diff)).slice(1) + ' vs last purchase', diffColor:diff > 0 ? C.dngr : C.crop,
      advText:money(adv), balText:money(pv - adv), needAppr:total > this.limit(), limitText:money(this.limit()),
      batchId:'BC-2608-0' + (12 + S.cropLog.length - 4), purNo:'PC-2608-014',
      crops:this.data.crops, grades:this.data.grades, whs:this.data.warehouses, units:this.data.units, sups:this.data.suppliers,
      log:table([column('Purchase No'), column('Date'), column('Supplier'), column('Crop'), column('Qty', 'right'), column('Rate', 'right'), column('Landed cost / unit', 'right'), column('Total', 'right'), column('Status', 'center')],
        S.cropLog.map(r => ({cells:[cell(r.no, {mono:true, weight:'600'}), cell(r.date, {color:C.mut}), cell(r.sup), cell(r.crop, {dot:C.crop}),
          cell(int(r.qty) + ' ' + r.unit, {align:'right', mono:true}), cell(money(r.rate), {align:'right', mono:true}),
          cell(money(r.cpu), {align:'right', mono:true, color:C.crop, weight:'600'}), cell(money(r.total), {align:'right', mono:true, weight:'600'}),
          cell(r.status, {align:'center', badge:true, badgeBg:r.status === 'Posted' ? C.cropBg : '#F0EEE9', badgeFg:r.status === 'Posted' ? C.crop : '#6E6A64'})]}))
      )};
  }

  postCP() {
    const c = this.calcCP(), f = this.state.cp;
    if (!c.net) { this.fire('Enter a quantity before posting.', 'danger'); return; }
    const no = 'PC-2608-0' + (14 + this.state.cropLog.length - 5);
    const batch = {id:c.batchId, crop:f.crop, grade:f.grade, wh:f.wh, qty:c.net, rem:c.net, cost:c.cpuNum, date:'28 Aug 2026', age:0, sup:c.sup.name};
    const logRow = {no:no, date:'28 Aug 2026', sup:c.sup.name, crop:f.crop, qty:c.net, unit:f.unit, rate:+f.rate || 0, cpu:c.cpuNum, total:c.total, status:c.needAppr ? 'Pending approval' : 'Posted'};
    const intent = {date:f.date, supplierCode:f.sup, crop:f.crop, grade:f.grade, warehouse:f.wh,
      quantity:+f.qty || 0, unit:f.unit, moisture:+f.moist || 0, rate:+f.rate || 0,
      transport:+f.transport || 0, loading:+f.loading || 0, unloading:+f.unloading || 0,
      other:+f.other || 0, advance:+f.advance || 0, note:f.note};
    this.persist('postCropPurchase', {logRow:logRow, batch:batch, intent:intent}).then(saved => {
      this.setState(s => ({
        batches:[saved.batch].concat(s.batches),
        cropLog:[saved.logRow].concat(s.cropLog)
      }));
      this.fire(c.needAppr ? no + ' saved and sent for approval — ' + money(c.total) : no + ' posted · batch ' + c.batchId + ' added to stock', c.needAppr ? 'warn' : 'ok');
    }).catch(err => { if (!err.silent) this.fire('Could not post purchase — ' + err.message, 'danger'); });
  }

  calcCS() {
    const f = this.state.cs, S = this.state, val = S.valuation;
    const pool = S.batches.filter(b => b.crop === f.crop && b.rem > 0).slice().sort((a, b) => b.age - a.age);
    const avgCost = pool.length ? pool.reduce((t, b) => t + b.cost * b.rem, 0) / pool.reduce((t, b) => t + b.rem, 0) : 0;
    let allocQty = 0, cogs = 0, over = false;
    const rows = pool.map(b => {
      const a = +f.alloc[b.id] || 0; if (a > b.rem) over = true;
      allocQty += a; cogs += a * (val === 'FIFO' ? b.cost : avgCost);
      return {id:b.id, grade:b.grade, wh:b.wh, remText:dec2(b.rem) + ' MT', costText:money(b.cost), ageText:b.age + ' days', supName:b.sup, date:b.date,
        qtyVal:f.alloc[b.id] === undefined ? '' : f.alloc[b.id], over:a > b.rem, leftText:dec2(Math.max(0, b.rem - a)) + ' MT left after sale',
        onQty:e => { const v = e.target.value === '' ? '' : Number(e.target.value); this.setState(s => { const al = Object.assign({}, s.cs.alloc); al[b.id] = v; return {cs:Object.assign({}, s.cs, {alloc:al})}; }); }};
    });
    const sales = allocQty * (+f.rate || 0), exp = (+f.transport || 0) + (+f.other || 0);
    const profit = sales - cogs - exp, per = allocQty ? profit / allocQty : 0, margin = sales ? profit / sales * 100 : 0;
    return {v:f, rows:rows, pool:pool, crops:this.data.crops, buyers:this.data.buyers, salesNo:'SC-2608-052',
      allocText:dec2(allocQty) + ' MT', allocQty:allocQty, over:over,
      salesText:money(sales), cogsText:'− ' + money(cogs).slice(1), expText:'− ' + money(exp).slice(1),
      profitText:money(profit), profitColor:profit >= 0 ? C.crop : C.dngr, perText:money(per) + ' / MT',
      marginText:margin.toFixed(2) + '%', avgCostText:money(avgCost), valuation:val,
      rateText:money(+f.rate || 0), showProfit:this.canProfit(), needAppr:sales > this.limit() * 4,
      log:table([column('Sales No'), column('Date'), column('Buyer company'), column('Crop'), column('Batch'), column('Qty', 'right'), column('Rate', 'right'), column('Sales value', 'right'), column('Gross profit', 'right')],
        S.saleLog.map(r => ({cells:[cell(r.no, {mono:true, weight:'600'}), cell(r.date, {color:C.mut}), cell(r.buyer), cell(r.crop, {dot:C.crop}),
          cell(r.batch, {mono:true, color:C.mut}), cell(int(r.qty) + ' MT', {align:'right', mono:true}), cell(money(r.rate), {align:'right', mono:true}),
          cell(money(r.amt), {align:'right', mono:true, weight:'600'}),
          cell(this.canProfit() ? money(r.profit) : '—', {align:'right', mono:true, color:C.crop, weight:'600'})]}))
      )};
  }

  postCS() {
    const c = this.calcCS(), f = this.state.cs;
    if (c.over) { this.fire('Allocation exceeds remaining stock in one or more batches.', 'danger'); return; }
    if (!c.allocQty) { this.fire('Allocate quantity from at least one batch.', 'danger'); return; }
    const logRow = {no:c.salesNo, date:'28 Aug 2026', buyer:f.buyer, crop:f.crop, batch:c.rows.filter(r => (+f.alloc[r.id] || 0) > 0).map(r => r.id).join(', '),
      qty:c.allocQty, rate:+f.rate || 0, amt:c.allocQty * (+f.rate || 0), profit:0, status:'Posted'};
    const intent = {date:f.date, buyerName:f.buyer, crop:f.crop, quantity:c.allocQty,
      rate:+f.rate || 0, transport:+f.transport || 0, other:+f.other || 0,
      valuation:this.state.valuation};
    this.persist('postCropSale', {logRow:logRow, allocations:Object.assign({}, f.alloc), intent:intent}).then(saved => {
      this.setState(s => ({
        batches:s.batches.map(b => { const a = +saved.allocations[b.id] || 0; return a ? Object.assign({}, b, {rem:b.rem - a}) : b; }),
        saleLog:[saved.logRow].concat(s.saleLog),
        cs:Object.assign({}, s.cs, {alloc:{}})
      }));
      this.fire(c.salesNo + ' posted · ' + c.allocText + ' issued, stock and buyer receivable updated', 'ok');
    }).catch(err => { if (!err.silent) this.fire('Could not post sale — ' + err.message, 'danger'); });
  }

  autoAlloc() {
    const f = this.state.cs, target = +f.target || 0;
    const pool = this.state.batches.filter(b => b.crop === f.crop && b.rem > 0).slice().sort((a, b) => b.age - a.age);
    let left = target; const al = {};
    pool.forEach(b => { const take = Math.min(left, b.rem); if (take > 0) al[b.id] = take; left -= take; });
    this.setState(s => ({cs:Object.assign({}, s.cs, {alloc:al})}));
    this.fire(left > 0 ? 'Only ' + dec2(target - left) + ' MT available — allocated oldest batches first' : 'Allocated ' + dec2(target) + ' MT, oldest batch first (FIFO)', left > 0 ? 'warn' : 'ok');
  }

  /**
   * Post a dealer sales invoice.
   *
   * The design's button only raised a toast; posting now goes through the
   * repository, so against the API it moves stock, raises the receivable and
   * writes the ledger, and the toast reports what the server actually did.
   */
  postDS(available, due) {
    if (available < 0) {
      this.fire('Credit limit exceeded — approval required before posting.', 'danger');
      return;
    }

    const f = this.state.ds;
    const cust = this.custList().filter(c => c.code === f.cust)[0];
    const intent = {date:f.date, customerCode:f.cust, warehouse:f.wh, terms:f.terms,
      paid:+f.paid || 0,
      lines:f.lines.map(l => { const p = this.data.products.filter(x => x.code === l.pid)[0] || {};
        return {productCode:l.pid, quantity:+l.qty || 0, bonus:+l.bonus || 0,
          rate:+l.rate || 0, discount:+l.disc || 0, unit:p.unit}; })};

    this.persist('postDealerSale', {intent:intent, customer:cust, due:due}).then(saved => {
      const no = saved && saved.txnNo ? saved.txnNo : 'DS-2608-222';
      if (saved && saved.status === 'PENDING_APPROVAL') {
        this.fire(no + ' saved and sent for approval', 'warn');
      } else if (due > 0) {
        this.fire(no + ' posted · stock reduced, receivable ' + money(due) + ' created', 'ok');
      } else if (due < 0) {
        // Paid more than the invoice: the surplus sits on account, and no
        // receivable is raised. Saying "receivable −৳84,708 created" would be
        // nonsense, and the server does not create one either.
        this.fire(no + ' posted · settled in full, ' + money(-due) + ' left on account', 'ok');
      } else {
        this.fire(no + ' posted · stock reduced, settled in full', 'ok');
      }
    }).catch(err => { if (!err.silent) this.fire(err.message, 'danger'); });
  }

  /** Post a dealer purchase bill. */
  postDP(net) {
    const f = this.state.dp;
    const co = this.data.companies.filter(c => c.code === f.co)[0];
    const intent = {date:f.date, companyCode:f.co, warehouse:f.wh, invoiceNo:f.inv,
      terms:f.terms, transport:+f.transport || 0, other:+f.other || 0,
      lines:f.lines.map(l => ({productCode:l.pid, quantity:+l.qty || 0, free:+l.free || 0,
        rate:+l.rate || 0, discount:+l.disc || 0}))};

    this.persist('postDealerPurchase', {intent:intent, company:co, net:net}).then(saved => {
      const no = saved && saved.txnNo ? saved.txnNo : 'DP-2608-072';
      if (saved && saved.status === 'PENDING_APPROVAL') {
        this.fire(no + ' saved, approval requested above ' + money(this.limit()), 'warn');
      } else {
        this.fire(no + ' posted · stock and company payable updated', 'ok');
      }
    }).catch(err => { if (!err.silent) this.fire(err.message, 'danger'); });
  }

  calcDS() {
    const f = this.state.ds, all = this.custList(), cust = all.filter(c => c.code === f.cust)[0] || all[0] || BLANK_PARTY;
    let gross = 0, discAmt = 0, cost = 0;
    const lines = f.lines.map((l, i) => {
      const p = this.data.products.filter(x => x.code === l.pid)[0] || this.data.products[0] || BLANK_PRODUCT;
      const amt = (+l.qty || 0) * (+l.rate || 0), d = amt * (+l.disc || 0) / 100, net = amt - d;
      gross += amt; discAmt += d; cost += (+l.qty || 0) * p.pur;
      return {i:i, pid:l.pid, name:p.name, unit:p.unit, stockText:int(p.stock) + ' ' + p.unit, lastText:money(p.sale),
        qtyVal:l.qty, rateVal:l.rate, discVal:l.disc, bonusVal:l.bonus, netText:money(net),
        low:(+l.qty || 0) > p.stock, products:this.data.products,
        onProduct:e => this.setState(s => { const L = s.ds.lines.slice(); const np = this.data.products.filter(x => x.code === e.target.value)[0]; L[i] = Object.assign({}, L[i], {pid:e.target.value, rate:np.sale}); return {ds:Object.assign({}, s.ds, {lines:L})}; }),
        onQty:e => this.setLine('ds', i, 'qty', e.target.value), onRate:e => this.setLine('ds', i, 'rate', e.target.value),
        onDisc:e => this.setLine('ds', i, 'disc', e.target.value), onBonus:e => this.setLine('ds', i, 'bonus', e.target.value),
        onDel:() => this.setState(s => ({ds:Object.assign({}, s.ds, {lines:s.ds.lines.filter((_, k) => k !== i)})}))};
    });
    const vat = 0, net = gross - discAmt + vat, profit = net - cost, margin = net ? profit / net * 100 : 0;
    const paid = +f.paid || 0, due = net - paid;
    const exposure = cust.out + due, avail = cust.limit - exposure;
    return {v:f, cust:cust, lines:lines, custs:all, whs:this.data.warehouses, invNo:'DS-2608-222',
      modal:this.state.custModal, nc:this.state.newCust,
      onNew:() => this.setState({custModal:true}), onCancel:() => this.setState({custModal:false}), onSave:() => this.saveCustomer(),
      types:this.optionsInUse(all, 'type', ['Dealer', 'Retailer', 'Corporate', 'Individual']),
      districts:this.optionsInUse(all.concat(this.data.suppliers, this.data.companies), 'district'),
      grossText:money(gross), discText:'− ' + money(discAmt).slice(1), netText:money(net), netNum:net, costText:money(cost),
      profitText:money(profit), marginText:margin.toFixed(2) + '%', profitColor:profit >= 0 ? C.crop : C.dngr,
      paidText:money(paid), dueText:money(due), limitText:money(cust.limit), outText:money(cust.out),
      availText:money(avail), availColor:avail < 0 ? C.dngr : C.crop, overLimit:avail < 0,
      showProfit:this.canProfit(), lineCount:lines.length + ' line items',
      onAdd:() => this.setState(s => ({ds:Object.assign({}, s.ds, {lines:s.ds.lines.concat([{pid:'P-1002', qty:10, rate:385, disc:0, bonus:0}])})})),
      onPost:() => this.postDS(avail, due)};
  }

  setLine(g, i, k, raw) {
    const v = raw === '' ? '' : Number(raw);
    this.setState(s => { const L = s[g].lines.slice(); L[i] = Object.assign({}, L[i], {[k]:v}); return {[g]:Object.assign({}, s[g], {lines:L})}; });
  }

  calcDP() {
    const f = this.state.dp, co = this.data.companies.filter(c => c.code === f.co)[0] || this.data.companies[0] || BLANK_PARTY;
    let gross = 0, discAmt = 0, freeQty = 0;
    const lines = f.lines.map((l, i) => {
      const p = this.data.products.filter(x => x.code === l.pid)[0] || this.data.products[0] || BLANK_PRODUCT;
      const amt = (+l.qty || 0) * (+l.rate || 0), d = amt * (+l.disc || 0) / 100;
      gross += amt; discAmt += d; freeQty += +l.free || 0;
      const eff = ((+l.qty || 0) + (+l.free || 0)) ? (amt - d) / ((+l.qty || 0) + (+l.free || 0)) : 0;
      return {i:i, pid:l.pid, name:p.name, unit:p.unit, stockText:int(p.stock) + ' ' + p.unit, lastText:money(p.pur),
        qtyVal:l.qty, freeVal:l.free, rateVal:l.rate, discVal:l.disc, netText:money(amt - d), effText:money(eff), products:this.data.products,
        onProduct:e => this.setState(s => { const L = s.dp.lines.slice(); const np = this.data.products.filter(x => x.code === e.target.value)[0]; L[i] = Object.assign({}, L[i], {pid:e.target.value, rate:np.pur}); return {dp:Object.assign({}, s.dp, {lines:L})}; }),
        onQty:e => this.setLine('dp', i, 'qty', e.target.value), onFree:e => this.setLine('dp', i, 'free', e.target.value),
        onRate:e => this.setLine('dp', i, 'rate', e.target.value), onDisc:e => this.setLine('dp', i, 'disc', e.target.value),
        onDel:() => this.setState(s => ({dp:Object.assign({}, s.dp, {lines:s.dp.lines.filter((_, k) => k !== i)})}))};
    });
    const addl = (+f.transport || 0) + (+f.other || 0), net = gross - discAmt + addl;
    return {v:f, co:co, cos:this.data.companies, whs:this.data.warehouses, lines:lines, purNo:'DP-2608-072',
      grossText:money(gross), discText:'− ' + money(discAmt).slice(1), addlText:money(addl), netText:money(net),
      freeText:int(freeQty) + ' pcs free', payableText:money(co.bal + net), coBalText:money(co.bal),
      needAppr:net > this.limit(), limitText:money(this.limit()),
      onAdd:() => this.setState(s => ({dp:Object.assign({}, s.dp, {lines:s.dp.lines.concat([{pid:'P-1002', qty:100, free:0, rate:318, disc:0}])})})),
      onPost:() => this.postDP(net)};
  }

  /**
   * Pull dashboard aggregates from the repository when it can compute them.
   *
   * The in-memory repository has no `dashboard` method, so nothing changes
   * there and the bundled figures are used. Against the API the totals are
   * aggregated in SQL, which is what makes the business-type filter reconcile:
   * All is the sum of Dealer and Bulk Crop because the database says so.
   */
  loadDashboard() {
    if (!this.repository || typeof this.repository.dashboard !== 'function') return;

    const biz = this.state.biz;
    const businessType = biz === 'dealer' ? 'DEALER' : biz === 'crop' ? 'BULK_CROP' : 'ALL';

    this.setState({ dashLoading: true });
    this.repository.dashboard(businessType).then(
      data => {
        // A stale response from a filter the user has since changed is dropped.
        if (this.state.biz === biz) this.setState({ serverDash: data, dashLoading: false });
      },
      () => this.setState({ dashLoading: false })
    );
  }

  /**
   * Map server aggregates onto the eight tiles the design shows.
   *
   * The supporting line states a fact the server actually returned -- a
   * document count, an account count -- rather than a period-on-period
   * percentage, because the API does not compute comparisons and inventing
   * one would put a number on screen that nothing backs.
   */
  serverKpis(d) {
    const tile = (k, value, note, detail, good) => ({
      k: k,
      v: money(value),
      sub: lakh(value),
      note: note,
      up: detail,
      upColor: good ? C.crop : C.warn,
    });

    const today = d.today || {sales:{amount:0, documents:0}};
    const profit = d.grossProfit;

    const out = [
      tile("Today's Sales", today.sales.amount, today.sales.documents + ' invoices', 'posted today', true),
      tile('This Month Sales', d.sales.amount, d.sales.documents + ' invoices', 'posted to date', true),
      tile('This Month Purchase', d.purchases.amount, d.purchases.documents + ' bills', 'posted to date', true),
    ];

    if (profit) {
      // The figure is each sale's own recorded profit, which already carries
      // the transport and other selling cost booked against it -- the same
      // number the batch profit report shows. Saying "sales less cost of
      // goods" made it look like it should equal the profit and loss gross
      // profit line, which is Tk 40,000 higher because that deducts selling
      // cost lower down.
      out.push(tile('Gross Profit', profit.amount, 'margin ' + profit.marginPct.toFixed(1) + '%',
        'after cost of goods and selling cost', profit.amount >= 0));
    }

    out.push(
      tile('Outstanding Receivable', d.receivable.amount, d.receivable.documents + ' open invoices',
        'awaiting collection', false),
      tile('Outstanding Payable', d.payable.amount, d.payable.documents + ' bills', 'due to suppliers', false),
      tile('Current Stock Value', d.stock.totalValue, d.stock.batches + ' crop batches',
        'across all warehouses', true),
      tile('Cash & Bank Balance', d.cash.balance, d.cash.accounts + ' accounts', 'cash, bank and MFS', true)
    );

    return out;
  }

  /**
   * Bars for the sales-and-purchase trend, from the server's monthly series.
   *
   * The design scaled the bars by sales alone, because in its sample data
   * sales always exceeded purchases. Against real trading that does not hold —
   * a month of heavy procurement outspends its sales — and a sales-only scale
   * pushes the purchase bar out of its 150px track. Both series therefore set
   * the scale.
   */
  serverChart(trend) {
    if (!trend || !trend.length) return [];

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const lakh = n => (Number(n) || 0) / 100000;
    const label = month => {
      const [, m] = String(month).split('-');
      return MONTHS[Number(m) - 1] || month;
    };

    const points = trend.map(t => ({
      l: label(t.month),
      s: lakh(t.sales),
      p: lakh(t.purchase),
      // Null when the signed-in role may not see profit figures.
      pr: t.profit === null || t.profit === undefined ? null : lakh(t.profit),
    }));

    // Guard the empty case: every value zero would divide by zero.
    const peak = Math.max(...points.map(x => Math.max(x.s, x.p)));
    const max = peak > 0 ? peak * 1.12 : 1;
    const height = v => ((v / max) * 150).toFixed(1) + 'px';

    return points.map(x => ({
      l: x.l,
      sH: height(x.s),
      pH: height(x.p),
      sText: '৳' + x.s.toFixed(1) + ' L',
      tip:
        x.l + ' — sales ৳' + x.s.toFixed(1) + ' L · purchase ৳' + x.p.toFixed(1) + ' L' +
        (x.pr === null ? '' : ' · profit ৳' + x.pr.toFixed(1) + ' L'),
    }));
  }

  /** Rows for one business-line panel, from that line's server aggregate. */
  businessPanelRows(d) {
    if (!d) return [];
    const rows = [
      {k:'Sales', v:money(d.sales.amount)},
      {k:'Purchase', v:money(d.purchases.amount)},
    ];
    if (d.grossProfit) {
      rows.push({k:'Gross profit', v:money(d.grossProfit.amount)});
    }
    rows.push(
      {k:'Outstanding', v:money(d.receivable.amount)},
      {k:'Stock value', v:money(d.stock.totalValue)}
    );
    if (d.grossProfit) {
      rows.push({k:'Margin', v:d.grossProfit.marginPct.toFixed(1) + '%'});
    }
    return rows;
  }

  dash() {
    const K = DASHBOARD_KPIS;
    const sd = this.state.serverDash;
    const kpis = sd ? this.serverKpis(sd) : K.map(x => {
      const v = x.fix !== undefined ? x.fix : this.bizOf(x);
      return {k:x.k, v:money(v), sub:lakh(v), note:x.note, up:x.up, upColor:x.good ? C.crop : C.warn};
    });
    const months = MONTHLY_SERIES;
    const b = this.state.biz;
    const series = months.map(x => { const s = b === 'dealer' ? x.ds : b === 'crop' ? x.cs : x.ds + x.cs; const p = b === 'dealer' ? x.dp : b === 'crop' ? x.cp : x.dp + x.cp; return {l:x.l, s:s, p:p, pr:s - p}; });
    const max = Math.max.apply(null, series.map(x => x.s)) * 1.12;
    const chart = sd && sd.trend
      ? this.serverChart(sd.trend)
      : series.map(x => ({l:x.l, sH:(x.s / max * 150).toFixed(1) + 'px', pH:(x.p / max * 150).toFixed(1) + 'px',
          sText:'৳' + x.s.toFixed(1) + ' L', tip:x.l + ' — sales ৳' + x.s.toFixed(1) + ' L · purchase ৳' + x.p.toFixed(1) + ' L · profit ৳' + x.pr.toFixed(1) + ' L'}));
    const byBiz = sd && sd.byBusiness;
    const panels = byBiz ? [
      {name:'Dealer Business', color:C.deal, bg:C.dealBg, tag:'Company → Dealer → Customer', screen:'dealer-sales',
        rows:this.businessPanelRows(byBiz.DEALER)},
      {name:'Bulk Crop Business', color:C.crop, bg:C.cropBg, tag:'Farmer → Us → Buyer company', screen:'crop-sales',
        rows:this.businessPanelRows(byBiz.BULK_CROP)}
    ] : [
      {name:'Dealer Business', color:C.deal, bg:C.dealBg, tag:'Company → Dealer → Customer', screen:'dealer-sales',
        rows:[{k:'Sales', v:money(9840000)}, {k:'Purchase', v:money(7210000)}, {k:'Gross profit', v:money(1486000)}, {k:'Outstanding', v:money(1580000)}, {k:'Stock value', v:money(5620000)}, {k:'Margin', v:'15.1%'}]},
      {name:'Bulk Crop Business', color:C.crop, bg:C.cropBg, tag:'Farmer → Us → Buyer company', screen:'crop-sales',
        rows:[{k:'Crop purchased', v:'642 MT'}, {k:'Crop sold', v:'478 MT'}, {k:'Purchase value', v:money(21150000)}, {k:'Sales value', v:money(24600000)}, {k:'Avg purchase rate', v:money(32945) + ' / MT'}, {k:'Avg selling rate', v:money(36180) + ' / MT'}]}
    ];
    // The parties actually on file, ranked by what they have traded. The
    // bundled lists described the demo business, so an empty one was shown
    // five companies it had never dealt with.
    const ranked = (rows, value) =>
      (rows || [])
        .map(r => ({ n: r.name, v: Number(value(r)) || 0 }))
        .filter(x => x.v > 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, 5);

    const customers = this.data.customers || [];
    const companies = this.data.companies || [];
    const topCust = this.serverBacked() ? ranked(customers, c => c.sales) : TOP_CUSTOMERS;
    const topCo = this.serverBacked() ? ranked(companies, c => Math.abs(c.bal)) : TOP_COMPANIES;
    // Nothing to scale against when there is nothing to chart, and a bar is
    // a share of the largest value rather than of zero.
    const bar = arr => { const mx = arr.length ? arr[0].v : 0; return arr.map(x => ({n:x.n, v:lakh(x.v), w:(mx ? x.v / mx * 100 : 0).toFixed(1) + '%'})); };
    // Each customer carries its own ageing, so the chart is their sum and it
    // cannot tell a different story from the receivable table.
    // Crop purchases and sales are in the working set already; the dashboard
    // lists them rather than a fixture that happened to resemble them.
    const recent = (this.state.cropLog || [])
      .map(r => [r.no, r.date, 'Crop purchase', r.sup, 'crop', r.total, r.status])
      .concat((this.state.saleLog || []).map(r => [r.no, r.date, 'Crop sale', r.buyer, 'crop', r.amt, r.status]))
      .slice(0, 6);

    const bucketOf = key => customers.reduce((t, c) => t + (Number(c[key]) || 0), 0);
    const aging = this.serverBacked()
      ? [
          { k: '0 – 30 days', v: bucketOf('b30'), c: C.crop },
          { k: '31 – 60 days', v: bucketOf('b60'), c: C.warn },
          { k: '61 – 90 days', v: bucketOf('b90'), c: '#C4720F' },
          { k: '90+ days', v: bucketOf('b90p'), c: C.dngr },
        ]
      : AGING_BUCKETS;
    const agMax = aging.reduce((m, x) => Math.max(m, x.v), 0);
    return {kpis:kpis, chart:chart, panels:panels, showProfit:this.canProfit(),
      topCust:bar(topCust), topCo:bar(topCo),
      aging:aging.map(x => ({k:x.k, v:money(x.v), w:(agMax ? (x.v / agMax) * 100 : 0).toFixed(1) + '%', c:x.c})),
      low:[{n:'Ispahani TSP Fertilizer 50kg', d:'74 of 120 bags minimum', p:'62%'}, {n:'ACI Zinc Sulphate 1kg', d:'210 of 250 pcs minimum', p:'84%'},
        {n:'Onion — batch BC-2606-001', d:'14 MT, 73 days old, dead stock risk', p:'35%'}],
      // The four money and stock actions now open their form directly instead
      // of only landing the user on the screen that hosts it.
      actions:[
        {l:'New Crop Purchase', onClick:this.go('crop-purchase')},
        {l:'New Crop Sale', onClick:this.go('crop-sales')},
        {l:'New Dealer Sale', onClick:this.go('dealer-sales')},
        {l:'New Dealer Purchase', onClick:this.go('dealer-purchase')},
        {l:'Receive Payment', onClick:() => this.openForm('payment', {direction:'RECEIPT', partyType:'CUSTOMER'})},
        {l:'Pay Supplier', onClick:() => this.openForm('payment', {direction:'PAYMENT', partyType:'SUPPLIER'})},
        {l:'Stock Transfer', onClick:() => this.openForm('transfer')},
        {l:'Add Expense', onClick:() => this.openForm('expense')}
      ],
      recent:table([column('Reference'), column('Date'), column('Type'), column('Party'), column('Business'), column('Amount', 'right'), column('Status', 'center')],
        (this.serverBacked() ? recent : [['SC-2608-051', '26 Aug', 'Crop sale', 'City Group (Rice Unit)', 'crop', 2952000, 'Posted'],
         ['DS-2608-221', '28 Aug', 'Dealer sale', 'Nabin Krishi Bitan', 'dealer', 1328000, 'Pending approval'],
         ['PC-2608-014', '28 Aug', 'Crop purchase', 'Abdul Karim Mondol', 'crop', 3020000, 'Pending approval'],
         ['RC-2608-310', '28 Aug', 'Collection', 'Sonar Bangla Enterprise', 'dealer', 450000, 'Posted'],
         ['DP-2608-071', '27 Aug', 'Dealer purchase', 'ACI Agrochemicals Ltd.', 'dealer', 892400, 'Posted'],
         ['PY-2608-118', '27 Aug', 'Supplier payment', 'Jashim Uddin Sarkar', 'crop', 1200000, 'Posted']]).map(r => ({cells:[
          cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(r[3]),
          cell(r[4] === 'crop' ? 'Bulk Crop' : 'Dealer', {badge:true, badgeBg:r[4] === 'crop' ? C.cropBg : C.dealBg, badgeFg:r[4] === 'crop' ? C.crop : C.deal}),
          cell(money(r[5]), {align:'right', mono:true, weight:'600'}),
          cell(r[6], {align:'center', badge:true, badgeBg:r[6] === 'Posted' ? '#F0EEE9' : C.warnBg, badgeFg:r[6] === 'Posted' ? '#3D3A36' : C.warn})]})),
        {emptyTitle:'Nothing posted yet', emptyNote:'Purchases, sales and collections appear here as they are recorded.'})};
  }

  inv() {
    const S = this.state, t = S.invTab;

    // Where stock actually is, when the server has said. Each line names its
    // own warehouse; the same product held in two godowns is two lines, which
    // is what the stock table records and what a stock-take has to match.
    // With a server answering, stock is what the stock table says and nothing
    // else: deriving it from the product master gives a different warehouse
    // and a different valuation, so it is not done at all rather than done
    // while the real figures are in flight.
    const served = this.serverBacked() ? S.stock || [] : S.stock;
    let rows = [];
    if (served) {
      rows = served
        .filter(r => t === 'all' || r.kind === t)
        .map(r => ({kind:r.kind, name:r.name, sub:r.sub, qty:r.qty, unit:r.unit,
          cost:r.cost, val:r.value, age:r.age, date:r.date ? shortDate(r.date) : '—',
          // A stock row carrying no godown is a data fault, and showing it as
          // blank hides it; a dash is at least visible in the column.
          wh:r.warehouse || '—', low:r.flagged}));
    } else {
      if (t !== 'dealer') rows = rows.concat(S.batches.map(b => ({kind:'crop', name:b.crop, sub:'Batch ' + b.id + ' · ' + b.grade, wh:b.wh, qty:b.rem, unit:'MT', cost:b.cost, val:b.rem * b.cost, age:b.age, date:b.date, low:b.age > 60})));
      if (t !== 'crop') rows = rows.concat(this.data.products.map(p => ({kind:'dealer', name:p.name, sub:p.brand + ' · ' + p.cat, wh:(this.data.warehouses || [])[0] || '—', qty:p.stock, unit:p.unit, cost:p.pur, val:p.stock * p.pur, age:null, date:'—', low:p.stock < p.min})));
    }
    const sort = S.invSort;
    rows.sort((a, b) => sort === 'value' ? b.val - a.val : sort === 'age' ? (b.age || 0) - (a.age || 0) : sort === 'qty' ? b.qty - a.qty : a.name.localeCompare(b.name));
    const mark = k => sort === k ? '  ↓' : '';
    const total = rows.reduce((t2, r) => t2 + r.val, 0);

    // The KPIs describe all stock, not the tab in view, so they are built from
    // every line rather than from the filtered `rows` above.
    const crops = served
      ? served.filter(r => r.kind === 'crop').map(r => ({ qty: r.qty, val: r.value }))
      : S.batches.map(b => ({ qty: b.rem, val: b.rem * b.cost }));
    const goods = served
      ? served.filter(r => r.kind === 'dealer').map(r => ({ qty: r.qty, val: r.value, min: 0, flagged: r.flagged }))
      : this.data.products.map(p => ({ qty: p.stock, val: p.stock * p.pur, min: p.min }));
    const sum = (list, key) => list.reduce((x, r) => x + (Number(r[key]) || 0), 0);
    const cropValue = sum(crops, 'val');
    const goodsValue = sum(goods, 'val');
    const warehouses = served
      ? new Set(served.map(r => r.warehouse).filter(Boolean)).size
      : new Set(S.batches.map(b => b.wh)).size || this.data.warehouses.length;
    // The server flags a line that is low or ageing; without one the minimum
    // stock on the product master and the batch age are what there is to go on.
    const needsAction = served
      ? served.filter(r => r.flagged).length
      : goods.filter(g => g.min && g.qty < g.min).length
        + S.batches.filter(b => (b.age || 0) > 60).length;
    return {actions:[
        {l:'Transfer stock', onClick:() => this.openForm('transfer')},
        {l:'Adjust stock', onClick:() => this.openForm('adjustment')}
      ],
      tabs:[{k:'all', l:'All stock'}, {k:'crop', l:'Bulk crops'}, {k:'dealer', l:'Dealer products'}].map(x => ({l:x.l, on:x.k === t,
        bg:x.k === t ? '#fff' : 'transparent', color:x.k === t ? C.ink : C.mut, onClick:this.hs('invTab', x.k)})),
      kpis:[{k:'Total stock value', v:money(cropValue + goodsValue), s:'across ' + warehouses + (warehouses === 1 ? ' warehouse' : ' warehouses')},
        {k:'Bulk crop stock', v:dec2(sum(crops, 'qty')) + ' MT', s:money(cropValue)},
        {k:'Dealer product stock', v:int(sum(goods, 'qty')) + ' units', s:money(goodsValue)},
        {k:'Low stock / dead stock', v:needsAction + (needsAction === 1 ? ' item' : ' items'), s:needsAction ? 'needs action' : 'nothing flagged'}],
      table:table([column('Item', 'left', {onClick:this.hs('invSort', 'name'), sortMark:mark('name')}), column('Type'), column('Warehouse'),
        column('Quantity', 'right', {onClick:this.hs('invSort', 'qty'), sortMark:mark('qty')}), column('Avg cost', 'right'),
        column('Stock value', 'right', {onClick:this.hs('invSort', 'value'), sortMark:mark('value')}),
        column('Age', 'right', {onClick:this.hs('invSort', 'age'), sortMark:mark('age')}), column('Status', 'center')],
        rows.map(r => ({cells:[cell(r.name, {weight:'600', sub:r.sub}),
          cell(r.kind === 'crop' ? 'Bulk Crop' : 'Dealer', {badge:true, badgeBg:r.kind === 'crop' ? C.cropBg : C.dealBg, badgeFg:r.kind === 'crop' ? C.crop : C.deal}),
          cell(r.wh, {color:C.mut}), cell(dec2(r.qty) + ' ' + r.unit, {align:'right', mono:true, weight:'600'}),
          cell(money(r.cost), {align:'right', mono:true}), cell(money(r.val), {align:'right', mono:true, weight:'600'}),
          cell(r.age === null ? '—' : r.age + ' d', {align:'right', mono:true, color:r.age > 60 ? C.dngr : C.mut, sub:r.date}),
          cell(r.low ? (r.kind === 'crop' ? 'Ageing' : 'Low stock') : 'Healthy', {align:'center', badge:true, badgeBg:r.low ? C.warnBg : C.cropBg, badgeFg:r.low ? C.warn : C.crop})]})),
        {
          // Three different situations that all draw as an empty grid, and
          // only one of them means the business is holding nothing.
          emptyTitle:S.stockError ? 'Stock could not be loaded'
            : S.stockLoading ? 'Loading stock…'
              : 'No stock on hand',
          emptyNote:S.stockError ? S.stockError
            : S.stockLoading ? ''
              : 'Post a purchase, or record an opening balance from Adjust stock.',
          footNote:S.stockError ? 'Figures unavailable'
            : rows.length + ' stock lines · valuation ' + S.valuation,
          footTotal:S.stockError ? '' : 'Total ' + money(total),
        })};
  }

  cust() {
    const S = this.state, all = this.custList();
    // No customers means no customer to be looking at. The blank record draws
    // the panel as dashes and zeros rather than taking the render down, and
    // `selected` is what everything else keys off: there is nobody selected,
    // so nothing may be edited and no history belongs to anyone.
    const selected = all.filter(x => x.code === S.custSel)[0] || all[0] || null;
    const c = selected || BLANK_PARTY;
    const avail = c.limit - c.out;
    const purchases = table([column('Invoice'), column('Date'), column('Items'), column('Amount', 'right'), column('Paid', 'right'), column('Due', 'right'), column('Status', 'center')],
      (selected ? [['DS-2608-221', '28 Aug 2026', '4 items', 1328000, 400000, 928000, 'Pending approval'], ['DS-2608-204', '21 Aug 2026', '6 items', 862000, 862000, 0, 'Settled'],
       ['DS-2608-188', '14 Aug 2026', '3 items', 445000, 245000, 200000, 'Partial'], ['DS-2607-171', '31 Jul 2026', '5 items', 738000, 738000, 0, 'Settled']] : []).map(r => ({cells:[
        cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(money(r[3]), {align:'right', mono:true}),
        cell(money(r[4]), {align:'right', mono:true, color:C.crop}), cell(money(r[5]), {align:'right', mono:true, weight:'600', color:r[5] ? C.dngr : C.mut}),
        cell(r[6], {align:'center', badge:true, badgeBg:r[6] === 'Settled' ? C.cropBg : r[6] === 'Partial' ? C.warnBg : '#F0EEE9', badgeFg:r[6] === 'Settled' ? C.crop : r[6] === 'Partial' ? C.warn : '#3D3A36'})]})),
      {emptyTitle:'No invoices yet', emptyNote:'Sales raised for this customer appear here.'});
    const payments = table([column('Receipt'), column('Date'), column('Mode'), column('Against invoice'), column('Amount', 'right')],
      (selected ? [['RC-2608-309', '27 Aug 2026', 'bKash', 'DS-2608-221', 400000], ['RC-2608-291', '21 Aug 2026', 'Bank — Islami Bank', 'DS-2608-204', 862000],
       ['RC-2608-266', '14 Aug 2026', 'Cash', 'DS-2608-188', 245000], ['RC-2607-240', '31 Jul 2026', 'Cheque', 'DS-2607-171', 738000]] : []).map(r => ({cells:[
        cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(r[3], {mono:true, color:C.mut}),
        cell(money(r[4]), {align:'right', mono:true, weight:'600', color:C.crop})]})),
      {emptyTitle:'No receipts yet', emptyNote:'Collections against this customer appear here.'});
    const ledger = table([column('Date'), column('Particulars'), column('Debit', 'right'), column('Credit', 'right'), column('Balance', 'right')],
      (selected ? [['31 Jul 2026', 'Opening balance', 0, 0, 282000], ['14 Aug 2026', 'Invoice DS-2608-188', 445000, 0, 727000], ['14 Aug 2026', 'Receipt RC-2608-266', 0, 245000, 482000],
       ['21 Aug 2026', 'Invoice DS-2608-204', 862000, 0, 1344000], ['21 Aug 2026', 'Receipt RC-2608-291', 0, 862000, 482000],
       ['28 Aug 2026', 'Invoice DS-2608-221', 1328000, 0, 1810000], ['27 Aug 2026', 'Receipt RC-2608-309', 0, 400000, 1410000]] : []).map(r => ({cells:[
        cell(r[0], {color:C.mut}), cell(r[1]), cell(r[2] ? money(r[2]) : '—', {align:'right', mono:true}),
        cell(r[3] ? money(r[3]) : '—', {align:'right', mono:true}), cell(money(r[4]), {align:'right', mono:true, weight:'600'})]})),
      {emptyTitle:'Nothing on the ledger', emptyNote:'Invoices and receipts build the running balance here.'});
    return {list:all.map(x => ({code:x.code, name:x.name, bn:x.bn, meta:x.type + ' · ' + x.district, out:money(x.out),
      on:x.code === S.custSel, bg:x.code === S.custSel ? C.accBg : '#fff', bd:x.code === S.custSel ? C.acc : '#E3E0DA', onClick:this.hs('custSel', x.code)})),
      c:c, salesText:money(c.sales), collText:money(c.coll), outText:money(c.out), limitText:money(c.limit), availText:money(avail),
      // A limit of nothing is not a limit exceeded: no customer, no bar.
      availW:(c.limit ? Math.min(100, c.out / c.limit * 100) : 0).toFixed(1) + '%',
      availColor:avail < 0 ? C.dngr : C.crop, daysText:c.days + ' days',
      // The screen says so rather than showing a panel of dashes unexplained.
      isEmpty:!selected, emptyTitle:'No customers yet',
      emptyNote:'Add the first one and their invoices, receipts and ledger build up here.',
      tabs:this.tabify([{k:'purchases', l:'Purchase history'}, {k:'payments', l:'Payment history'}, {k:'ledger', l:'Ledger'}], S.custTab, 'custTab'),
      isPur:S.custTab === 'purchases', isPay:S.custTab === 'payments', isLed:S.custTab === 'ledger',
      purchases:purchases, payments:payments, ledger:ledger,
      // Nothing selected is nothing to edit or retire; adding the first one
      // is the only thing this screen offers a new business.
      ...this.masterControls('customer', selected), addLabel:'Add customer',
      countText:all.length + (all.length === 1 ? ' customer' : ' customers')};
  }

  sup() {
    const S = this.state;
    const picked = this.data.suppliers.filter(x => x.code === S.supSel)[0] || this.data.suppliers[0] || null;
    const s = picked || BLANK_PARTY;
    const pur = table([column('Purchase No'), column('Date'), column('Crop'), column('Batch'), column('Qty', 'right'), column('Rate', 'right'), column('Amount', 'right'), column('Paid', 'right')],
      // This supplier's purchases. It used to pad the list with the first two
      // rows of the whole log whatever the supplier, so every farmer appeared
      // to have delivered someone else's crop.
      (picked ? this.state.cropLog.filter(r => r.sup === s.name) : []).slice(0, 4).map((r, i) => ({cells:[
        cell(r.no, {mono:true, weight:'600'}), cell(r.date, {color:C.mut}), cell(r.crop, {dot:C.crop}),
        cell('BC-2608-0' + (11 - i), {mono:true, color:C.mut}), cell(int(r.qty) + ' ' + r.unit, {align:'right', mono:true}),
        cell(money(r.rate), {align:'right', mono:true}), cell(money(r.total), {align:'right', mono:true, weight:'600'}),
        cell(money(r.total * (i === 0 ? 0.5 : 1)), {align:'right', mono:true, color:C.crop})]})),
      {emptyTitle:'No purchases from this supplier yet', emptyNote:'Post a bulk crop purchase to see the history here.'});
    const pay = table([column('Voucher'), column('Date'), column('Mode'), column('Against'), column('Amount', 'right')],
      (picked ? [['PY-2608-118', '27 Aug 2026', 'bKash', 'PC-2608-013 advance', 1500000], ['PY-2608-104', '22 Aug 2026', 'Bank — DBBL', 'PC-2608-013 balance', 1060000],
       ['PY-2608-090', '18 Aug 2026', 'Cash', 'PC-2608-009', 800000]] : []).map(r => ({cells:[
        cell(r[0], {mono:true, weight:'600'}), cell(r[1], {color:C.mut}), cell(r[2]), cell(r[3], {color:C.mut}),
        cell(money(r[4]), {align:'right', mono:true, weight:'600', color:C.dngr})]})),
      {emptyTitle:'No payments yet', emptyNote:'Vouchers paid to this supplier appear here.'});
    return {list:this.data.suppliers.map(x => ({code:x.code, name:x.name, bn:x.bn, meta:x.type + ' · ' + x.upazila + ', ' + x.district, out:money(x.out),
      on:x.code === S.supSel, bg:x.code === S.supSel ? C.accBg : '#fff', bd:x.code === S.supSel ? C.acc : '#E3E0DA', onClick:this.hs('supSel', x.code)})),
      s:s, purText:money(s.pur), paidText:money(s.paid), outText:money(s.out),
      tabs:this.tabify([{k:'purchases', l:'Purchase history'}, {k:'payments', l:'Payment history'}], S.supTab, 'supTab'),
      isPur:S.supTab === 'purchases', purchases:pur, payments:pay,
      isEmpty:!picked, emptyTitle:'No suppliers yet',
      emptyNote:'Add the first farmer or trader and their purchases and payments build up here.',
      ...this.masterControls('supplier', picked), addLabel:'Add supplier',
      countText:this.data.suppliers.length
        + (this.data.suppliers.length === 1 ? ' supplier' : ' suppliers')};
  }

  /** Values already present in the data, plus a few common ones, sorted. */
  optionsInUse(rows, key, seed) {
    const seen = new Set(seed || []);
    (rows || []).forEach(r => { if (r && r[key]) seen.add(String(r[key])); });
    return [...seen].sort((a, b) => a.localeCompare(b));
  }

  acct() {
    const S = this.state, t = S.acctTab;
    // Everything the accounts screen states is derived from these three lists,
    // so a KPI cannot drift from the table underneath it.
    const owing = this.data.customers.filter(c => c.out > 0);
    // A company balance is signed: negative is money owed to us. Crop sales go
    // to buyer companies rather than customers, so leaving them out made the
    // receivable read zero while the dashboard counted them.
    const owingCompanies = this.data.companies.filter(c => c.bal < 0);
    const owedSuppliers = this.data.suppliers.filter(x => x.out > 0);
    const owedCompanies = this.data.companies.filter(c => c.bal > 0);
    const receivableTotal =
      owing.reduce((x, c) => x + c.out, 0) + owingCompanies.reduce((x, c) => x - c.bal, 0);
    // Only customers carry aging buckets; a company balance has no age here.
    const overdue = owing.reduce((x, c) => x + (c.b60 || 0) + (c.b90 || 0) + (c.b90p || 0), 0);
    const payableTotal =
      owedSuppliers.reduce((x, y) => x + y.out, 0) + owedCompanies.reduce((x, y) => x + y.bal, 0);
    const owedParties = owedSuppliers.length + owedCompanies.length;
    const owingParties = owing.length + owingCompanies.length;
    // Every figure below comes from the one statement, so the lines, the KPI
    // and the margin cannot disagree with each other or with the report.
    // Nothing stands in for a statement that did not arrive. A screen that
    // falls back to a specimen on failure reports a profit the business never
    // made, which is worse than reporting nothing at all.
    const statement = S.statement;
    const pl = statement ? statement.lines : [];
    const netProfit = statement ? statement.totals.netProfit : 0;
    const revenue = statement ? statement.totals.revenue : 0;
    const margin = statement && revenue ? statement.totals.marginPct.toFixed(1) + '%' : '—';
    const rec = table([column('Customer'), column('Type'), column('Credit limit', 'right'), column('0–30', 'right'), column('31–60', 'right'), column('61–90', 'right'), column('90+', 'right'), column('Total due', 'right'), column('', 'center')],
      owing.map(c => ({cells:[cell(c.name, {weight:'600', sub:c.district}), cell(c.type, {color:C.mut}),
        cell(money(c.limit), {align:'right', mono:true, color:C.mut}), cell(money(c.b30), {align:'right', mono:true}),
        cell(money(c.b60), {align:'right', mono:true, color:c.b60 ? C.warn : C.mut}),
        cell(money(c.b90), {align:'right', mono:true, color:c.b90 ? '#C4720F' : C.mut}),
        cell(money(c.b90p), {align:'right', mono:true, color:c.b90p ? C.dngr : C.mut, weight:c.b90p ? '600' : '400'}),
        cell(money(c.out), {align:'right', mono:true, weight:'700'}),
        cell('Collect', {align:'center', badge:true, badgeBg:C.accBg, badgeFg:C.acc})]}))
        // Buyer companies owe against crop sales. They carry no aging buckets,
        // so those columns read as dashes rather than as zeroes.
        .concat(owingCompanies.map(c => ({cells:[
          cell(c.name, {weight:'600', sub:c.district}),
          cell('Buyer company', {badge:true, badgeBg:C.cropBg, badgeFg:C.crop}),
          cell(c.limit ? money(c.limit) : '—', {align:'right', mono:true, color:C.mut}),
          cell('—', {align:'right', color:C.mut}), cell('—', {align:'right', color:C.mut}),
          cell('—', {align:'right', color:C.mut}), cell('—', {align:'right', color:C.mut}),
          cell(money(-c.bal), {align:'right', mono:true, weight:'700'}),
          cell('Collect', {align:'center', badge:true, badgeBg:C.accBg, badgeFg:C.acc})]}))),
      {footNote:owingParties + (owingParties === 1 ? ' party' : ' parties') + ' with open balance',
       footTotal:'Receivable ' + money(receivableTotal)});
    const pay = table([column('Party'), column('Kind'), column('Bill / reference'), column('Due date'), column('Outstanding', 'right'), column('', 'center')],
      owedSuppliers.map(s => ({cells:[cell(s.name, {weight:'600', sub:s.district}), cell('Farmer / supplier', {badge:true, badgeBg:C.cropBg, badgeFg:C.crop}),
        cell('PC balance', {color:C.mut}), cell('30 Aug 2026', {color:C.mut}), cell(money(s.out), {align:'right', mono:true, weight:'700'}),
        cell('Pay', {align:'center', badge:true, badgeBg:C.accBg, badgeFg:C.acc})]}))
        .concat(owedCompanies.map(c => ({cells:[cell(c.name, {weight:'600', sub:c.district}), cell('Principal company', {badge:true, badgeBg:C.dealBg, badgeFg:C.deal}),
          cell('Invoice ' + c.code, {color:C.mut}), cell('05 Sep 2026', {color:C.mut}), cell(money(c.bal), {align:'right', mono:true, weight:'700'}),
          cell('Pay', {align:'center', badge:true, badgeBg:C.accBg, badgeFg:C.acc})]}))),
      {footNote:'Payables across farmers and companies', footTotal:'Payable ' + money(payableTotal)});
    // The real accounts once they have been fetched; the bundled list is the
    // fallback for running with no backend.
    const accounts = (S.masterRows.account || ACCOUNTS).filter(a => a.status !== 'Closed');
    const cashTotal = accounts.reduce((t, r) => t + (r.balance ?? r.opening ?? 0), 0);
    const cash = table([column('Account'), column('Code'), column('Type'), column('Last movement'), column('Balance', 'right'), column('', 'right')],
      accounts.map(r => ({cells:[
        cell(r.name, {weight:'600'}),
        cell(r.code || '—', {mono:true, color:C.mut}),
        cell(r.type, {badge:true, badgeBg:'#F0EEE9', badgeFg:'#3D3A36'}),
        cell(shortDate(r.lastMovement || r.last), {color:C.mut}),
        cell(money(r.balance ?? r.opening ?? 0), {align:'right', mono:true, weight:'700'}),
        cell('', {align:'right', actions:this.masterRowActions('account', r)})]})),
      {footNote:accounts.length + ' accounts', footTotal:'Total ' + money(cashTotal)});

    const categories = (S.masterRows.category || this.data.expenseCategories || [])
      .filter(c => c.status !== 'Retired');
    const cats = table([column('Code'), column('Category'), column('Vouchers', 'right'), column('Spent', 'right'), column('', 'right')],
      categories.map(c => ({cells:[
        cell(c.code || '—', {mono:true, color:C.mut}),
        cell(c.name, {weight:'600'}),
        cell(c.vouchers ? String(c.vouchers) : '—', {align:'right', mono:true, color:C.mut}),
        cell(c.spent ? money(c.spent) : '—', {align:'right', mono:true, weight:'600'}),
        cell('', {align:'right', actions:this.masterRowActions('category', c)})]})),
      {emptyTitle:'No expense categories yet',
       emptyNote:'Add one and expenses can be booked against it.',
       footNote:categories.length + (categories.length === 1 ? ' category' : ' categories'),
       footTotal:'Spent ' + money(categories.reduce((t, c) => t + (c.spent || 0), 0))});
    // Whatever the business actually spent, once fetched.
    const vouchers = (S.expenses && S.expenses.rows) || EXPENSE_VOUCHERS;
    const spent = S.expenses && S.expenses.total != null
      ? S.expenses.total
      : vouchers.reduce((t2, r) => t2 + (Number(r.amount) || 0), 0);
    const exp = table([column('Voucher'), column('Date'), column('Category'), column('Note'), column('Business'), column('Amount', 'right')],
      vouchers.map(r => {
        const line = r.businessType === 'BULK_CROP' ? 'Bulk Crop' : r.businessType === 'DEALER' ? 'Dealer' : 'Shared';
        return {cells:[
          cell(r.no, {mono:true, weight:'600'}),
          cell(shortDate(r.date), {color:C.mut}),
          cell(r.category || '—'),
          cell(r.note || '—', {color:C.mut}),
          cell(line, {badge:true,
            badgeBg:line === 'Bulk Crop' ? C.cropBg : line === 'Dealer' ? C.dealBg : '#F0EEE9',
            badgeFg:line === 'Bulk Crop' ? C.crop : line === 'Dealer' ? C.deal : '#3D3A36'}),
          cell(money(r.amount), {align:'right', mono:true, weight:'600'})]};
      }),
      {emptyTitle:'No expenses recorded yet',
       emptyNote:'Record one and it appears here against its category.',
       footNote:vouchers.length + (vouchers.length === 1 ? ' voucher' : ' vouchers'),
       footTotal:'Total ' + money(spent)});
    return {tabs:this.tabify([{k:'receivable', l:'Receivable'}, {k:'payable', l:'Payable'}, {k:'cash', l:'Cash & Bank'}, {k:'expense', l:'Expense'}, {k:'category', l:'Categories'}, {k:'pl', l:'Profit & Loss'}], t, 'acctTab'),
      actions:[
        {l:'Receive payment', onClick:() => this.openForm('payment', {direction:'RECEIPT', partyType:'CUSTOMER'})},
        {l:'Pay supplier', onClick:() => this.openForm('payment', {direction:'PAYMENT', partyType:'SUPPLIER'})},
        {l:'Add expense', onClick:() => this.openForm('expense')}
      ],
      isRec:t === 'receivable', isPay:t === 'payable', isCash:t === 'cash', isExp:t === 'expense',
      isCat:t === 'category', isPl:t === 'pl',
      rec:rec, pay:pay, cash:cash, exp:exp, cats:cats,
      addAccount:{canAdd:this.mayMaster('account', 'create'), label:'Add account', onAdd:() => this.openMaster('account')},
      addCategory:{canAdd:this.mayMaster('category', 'create'), label:'Add category', onAdd:() => this.openMaster('category')},
      // Read from the same rows the tables below are built from, so a KPI can
      // never disagree with the table it sits above.
      kpis:[{k:'Total receivable', v:money(receivableTotal), s:money(overdue) + ' overdue'},
        {k:'Total payable', v:money(payableTotal), s:owedParties + ' parties'},
        {k:'Cash & bank', v:money(cashTotal), s:accounts.length + (accounts.length === 1 ? ' account' : ' accounts')},
        {k:'Net profit', v:statement ? money(netProfit) : '—', s:'margin ' + margin}],
      pl:pl.map(x => ({k:x.label, v:money(x.amount), bold:x.bold ? '600' : '400', size:x.big ? '17px' : '13.5px',
        color:x.good ? C.crop : x.amount < 0 ? '#3D3A36' : C.ink, bg:x.bold ? '#FAF9F7' : '#fff'})),
      plTitle:'Profit & loss' + (statement && !statement.isEmpty ? ' — ' + periodLabel(statement.period) : ''),
      plSub:statement && statement.period && statement.period.businessType
        ? 'One business line, as posted to the ledger'
        : 'Both business models combined, as posted to the ledger',
      plNote:S.statementError
        ? S.statementError
        : !statement
          ? 'Loading the profit and loss…'
          : statement.isEmpty
            ? 'Nothing has been posted yet, so there is nothing to report.'
            : ''};
  }

  /**
   * Load the list of reports the server can serve.
   *
   * The bundled catalogue lists every report the design drew; a given backend
   * may implement fewer. Listing only what can actually be produced is better
   * than offering a menu item that answers with an empty table.
   */
  loadReportCatalogue() {
    if (!this.repository || typeof this.repository.reportCatalogue !== 'function') return;
    this.repository.reportCatalogue().then(
      groups => {
        this.setState({ reportCatalogue: groups });
        // Load whatever is selected by default; otherwise the screen would
        // open showing the bundled figures until the user clicked something.
        const listed = groups.flatMap(g => g.items.map(i => i.id));
        const selected = listed.includes(this.state.repSel) ? this.state.repSel : listed[0];
        if (selected) this.selectReport(selected);
      },
      () => {}
    );
  }

  /**
   * Download the selected report.
   *
   * The server builds the file from the same definition the table came from,
   * so the download always matches what is on screen. Without a backend there
   * is nothing to produce, and the user is told so rather than shown a
   * success message for a file that was never written.
   */
  exportReport(format, label) {
    if (!this.repository || typeof this.repository.exportReport !== 'function') {
      this.fire('Export needs the server connection.', 'warn');
      return;
    }

    const biz = this.state.biz;
    this.fire('Preparing ' + (format === 'pdf' ? 'PDF' : 'Excel') + ' file…', 'ok');

    this.repository
      .exportReport(this.state.repSel, format, {
        businessType: biz === 'dealer' ? 'DEALER' : biz === 'crop' ? 'BULK_CROP' : 'ALL',
      })
      .then(
        filename => this.fire(label + ' downloaded as ' + filename, 'ok'),
        err => this.fire('Could not export — ' + err.message, 'danger')
      );
  }

  /** Report page size; the server pages, this is only what we ask for. */
  static REPORT_PAGE_SIZE = 25;

  /**
   * Select a report and load it.
   *
   * Against the API the rows are aggregated and paged in SQL, so the browser
   * only ever holds one page. With the in-memory repository there is no
   * `report` method, so the bundled definitions are used and the original
   * simulated delay is kept -- which is what the existing tests exercise.
   */
  selectReport(reportId, page = 0) {
    this.setState({ repSel: reportId, repPage: page, repLoading: true });

    if (!this.repository || typeof this.repository.report !== 'function') {
      clearTimeout(this._r);
      this._r = setTimeout(() => this.setState({ repLoading: false }), 550);
      return;
    }

    const biz = this.state.biz;
    this.repository
      .report(reportId, {
        businessType: biz === 'dealer' ? 'DEALER' : biz === 'crop' ? 'BULK_CROP' : 'ALL',
        page: page + 1,
        pageSize: BusinessApp.REPORT_PAGE_SIZE,
      })
      .then(
        result => {
          // Ignore a response for a report the user has since navigated away from.
          if (this.state.repSel !== reportId) return;
          this.setState({ serverReport: { id: reportId, ...result }, repLoading: false });
        },
        err => {
          if (this.state.repSel !== reportId) return;
          this.setState({ serverReport: null, repLoading: false, repError: err.message });
        }
      );
  }

  /**
   * Build a DataTable from a server report.
   *
   * The server describes each column's type, so money is right-aligned and
   * monospaced, counts are formatted as integers and codes keep the mono face
   * -- without the client guessing from the value, which would read a rate of
   * 30500 the same way it reads a quantity.
   */
  serverReportTable(report) {
    const numeric = t => t === 'money' || t === 'number' || t === 'percent';
    const lastIndex = report.columns.length - 1;

    const cols = report.columns.map(c => column(c.label, numeric(c.type) ? 'right' : 'left'));

    const rows = report.rows.map(r => ({
      cells: report.columns.map((c, i) => {
        const v = r[c.key];
        const emphasis = i === lastIndex;

        if (c.type === 'money') {
          const n = Number(v) || 0;
          return cell(money(n), {align:'right', mono:true,
            weight:emphasis ? '700' : '400',
            color:n < 0 ? C.dngr : emphasis ? C.crop : C.ink});
        }
        if (c.type === 'number') return cell(int(v), {align:'right', mono:true});
        if (c.type === 'percent') return cell((Number(v) || 0).toFixed(1) + '%', {align:'right', mono:true});
        if (c.type === 'code') return cell(v == null ? '—' : String(v), {mono:true, weight:'600'});
        return cell(v == null || v === '' ? '—' : String(v),
          i === 0 ? {weight:'600'} : {color:C.mut});
      })
    }));

    // The server returns one totals figure per report; show it in the footer.
    const totalKey = report.totals ? Object.keys(report.totals)[0] : null;
    const meta = report.meta || {};
    const size = BusinessApp.REPORT_PAGE_SIZE;

    return table(cols, rows, {
      footNote:(meta.total ?? rows.length) + ' rows',
      footTotal:totalKey
        ? totalKey.charAt(0).toUpperCase() + totalKey.slice(1) + ' ' + money(report.totals[totalKey])
        : '',
      maxH:'420px',
      emptyTitle:'No rows for this report',
      emptyNote:'Nothing matches the current period and business type.',
      page:meta.totalPages > 1 ? {
        index:this.state.repPage || 0,
        size:size,
        total:meta.total,
        server:true,
        onPrev:() => this.selectReport(report.id, (this.state.repPage || 0) - 1),
        onNext:() => this.selectReport(report.id, (this.state.repPage || 0) + 1)
      } : null
    });
  }

  rep() {
    const S = this.state;
    // The server's catalogue wins when there is one, so the sidebar lists only
    // reports that can actually be produced.
    const groups = (S.reportCatalogue || REPORT_GROUPS).map(g => ({
      g: g.g || g.group,
      items: (g.items || []).map(i => (Array.isArray(i) ? i : [i.id, i.label]))
    }));
    const defs = {
      'crop-batch-profit':{title:'Batch-wise crop profit', note:'August 2026 · all warehouses · bulk crop only',
        t:table([column('Batch'), column('Crop'), column('Supplier'), column('Purchased', 'right'), column('Sold', 'right'), column('Landed cost', 'right'), column('Avg sale rate', 'right'), column('Profit / MT', 'right'), column('Total profit', 'right')],
          [['BC-2608-011', 'Maize', 'Abdul Karim Mondol', 100, 38, 30800, 34500, 3700, 140600], ['BC-2608-009', 'Maize', 'Aftab Ali Bepari', 60, 25, 29450, 33200, 3750, 93750],
           ['BC-2607-014', 'Paddy (BRRI-28)', 'Jashim Uddin Sarkar', 250, 162, 26200, 28900, 2700, 437400], ['BC-2607-008', 'Rice (Miniket)', 'Jashim Uddin Sarkar', 120, 75, 57400, 61500, 4100, 307500],
           ['BC-2607-002', 'Potato', 'Nurul Haque Krishi Khamar', 180, 84, 20900, 22600, 1700, 142800], ['BC-2606-001', 'Onion', 'Shahida Begum', 40, 26, 45800, 44200, -1600, -41600]].map(r => ({cells:[
            cell(r[0], {mono:true, weight:'600'}), cell(r[1], {dot:C.crop}), cell(r[2], {color:C.mut}),
            cell(int(r[3]) + ' MT', {align:'right', mono:true}), cell(int(r[4]) + ' MT', {align:'right', mono:true}),
            cell(money(r[5]), {align:'right', mono:true}), cell(money(r[6]), {align:'right', mono:true}),
            cell(money(r[7]), {align:'right', mono:true, color:Number(r[7]) < 0 ? C.dngr : C.crop}),
            cell(money(r[8]), {align:'right', mono:true, weight:'700', color:Number(r[8]) < 0 ? C.dngr : C.crop})]})),
          {footNote:'6 batches', footTotal:'Total profit ' + money(1080450)})},
      'fin-aging':{title:'Customer outstanding & aging', note:'As on 28 Aug 2026 · dealer business', t:this.acct().rec},
      'sales-product':{title:'Product-wise sales', note:'August 2026 · dealer business',
        t:table([column('Product'), column('Category'), column('Qty sold', 'right'), column('Sales value', 'right'), column('Cost', 'right'), column('Profit', 'right'), column('Margin', 'right')],
          this.data.products.map((p, i) => { const q = [1420, 760, 380, 510, 96, 132][i], sv = q * p.sale, c = q * p.pur;
            return {cells:[cell(p.name, {weight:'600'}), cell(p.cat, {color:C.mut}), cell(int(q) + ' ' + p.unit, {align:'right', mono:true}),
              cell(money(sv), {align:'right', mono:true, weight:'600'}), cell(money(c), {align:'right', mono:true, color:C.mut}),
              cell(money(sv - c), {align:'right', mono:true, color:C.crop, weight:'600'}), cell(((sv - c) / sv * 100).toFixed(1) + '%', {align:'right', mono:true})]}; }),
          {footNote:this.data.products.length + ' products',
           footTotal:'Sales ' + money(this.data.products.reduce((t, x) => t + (x.sale || 0) * (x.sold || 0), 0))})},
      'pur-supplier':{title:'Supplier-wise purchase', note:'FY 2026-27 to date · bulk crop',
        t:table([column('Supplier'), column('Type'), column('District'), column('Purchase value', 'right'), column('Paid', 'right'), column('Outstanding', 'right')],
          this.data.suppliers.map(s => ({cells:[cell(s.name, {weight:'600', sub:s.bn}), cell(s.type, {color:C.mut}), cell(s.district), cell(money(s.pur), {align:'right', mono:true, weight:'600'}),
            cell(money(s.paid), {align:'right', mono:true, color:C.crop}), cell(money(s.out), {align:'right', mono:true, weight:'600', color:s.out ? C.dngr : C.mut})]})),
          {footNote:this.data.suppliers.length + ' suppliers',
           footTotal:'Purchase ' + money(this.data.suppliers.reduce((t, x) => t + (x.pur || 0), 0))})}
    };
    const server = S.serverReport && S.serverReport.id === S.repSel ? S.serverReport : null;
    // When the repository can serve reports, the bundled definitions are not a
    // fallback -- showing last year's seeded numbers beside live ones would be
    // worse than showing nothing while the real answer loads.
    const serverBacked = !!(this.repository && typeof this.repository.report === 'function');
    const cur = server
      ? {title:null, note:null, t:this.serverReportTable(server)}
      : serverBacked
        ? null
        : defs[S.repSel];
    const flat = []; groups.forEach(g => g.items.forEach(i => flat.push({id:i[0], l:i[1]})));
    const curLabel = (flat.filter(f => f.id === S.repSel)[0] || {l:''}).l;
    return {groups:groups.map(g => ({g:g.g, items:g.items.map(i => ({l:i[1], on:i[0] === S.repSel, bg:i[0] === S.repSel ? C.accBg : 'transparent',
      color:i[0] === S.repSel ? C.acc : '#3D3A36', weight:i[0] === S.repSel ? '600' : '400',
      onClick:() => this.selectReport(i[0])}))})),
      loading:S.repLoading, has:!!cur && !S.repLoading, none:!cur && !S.repLoading,
      title:cur && cur.title ? cur.title : curLabel,
      note:cur
        ? cur.note || (server ? 'Aggregated by the server for the selected period and business type.' : '')
        : 'This report is wired to the same filter engine but has no seeded rows in the prototype.',
      t:cur ? cur.t : table([], []), curLabel:curLabel,
      onExport:() => this.exportReport('xlsx', curLabel), onPdf:() => this.exportReport('pdf', curLabel)};
  }

  appr() {
    const S = this.state, L = this.limit();
    const act = (id, ok) => () => {
      const history = (ok ? 'Approved' : 'Rejected') + ' by ' + this.data.company.user + ' · 28 Aug, just now';
      this.persist('decideApproval', id, ok, history).then(() => {
        this.setState(s => ({approvals:s.approvals.map(a => a.id === id ? Object.assign({}, a, {status:ok ? 'approved' : 'rejected', hist:history}) : a)}));
        this.fire('Request ' + id + ' ' + (ok ? 'approved' : 'rejected'), ok ? 'ok' : 'warn');
      }).catch(err => { if (!err.silent) this.fire('Could not record decision — ' + err.message, 'danger'); });
    };
    const cards = S.approvals.filter(a => a.status === 'pending').map(a => ({id:a.id, kind:a.kind, ref:a.ref, party:a.party, amt:money(a.amt), by:a.by, when:a.when, why:a.why,
      tone:a.kind.indexOf('Crop') > -1 ? C.crop : a.kind === 'Sales Discount' ? C.deal : C.warn,
      toneBg:a.kind.indexOf('Crop') > -1 ? C.cropBg : a.kind === 'Sales Discount' ? C.dealBg : C.warnBg,
      onOk:act(a.id, true), onNo:act(a.id, false)}));
    const done = S.approvals.filter(a => a.status !== 'pending');
    return {cards:cards, empty:cards.length === 0, count:cards.length, limitText:money(L),
      hist:table([column('Request'), column('Type'), column('Reference'), column('Party'), column('Amount', 'right'), column('Outcome'), column('History')],
        done.map(a => ({cells:[cell(a.id, {mono:true, weight:'600'}), cell(a.kind), cell(a.ref, {mono:true, color:C.mut}), cell(a.party),
          cell(money(a.amt), {align:'right', mono:true, weight:'600'}),
          cell(a.status === 'approved' ? 'Approved' : 'Rejected', {badge:true, badgeBg:a.status === 'approved' ? C.cropBg : '#FBEEF0', badgeFg:a.status === 'approved' ? C.crop : C.dngr}),
          cell(a.hist, {color:C.mut, size:'12px'})]})), {emptyTitle:'No decisions yet', emptyNote:'Approved and rejected requests will be listed here.'})};
  }

  search() {
    const q = this.state.q.trim().toLowerCase();
    if (!q) return {open:false, groups:[], q:q, empty:false};
    const hit = [];
    this.custList().forEach(c => { if ((c.name + c.code + c.district + c.mobile).toLowerCase().indexOf(q) > -1) hit.push({g:'Customers', l:c.name, s:c.code + ' · ' + c.district + ' · due ' + money(c.out), go:'customers', pick:['custSel', c.code]}); });
    this.data.suppliers.forEach(c => { if ((c.name + c.code + c.district + c.mobile).toLowerCase().indexOf(q) > -1) hit.push({g:'Suppliers', l:c.name, s:c.code + ' · ' + c.district + ' · payable ' + money(c.out), go:'suppliers', pick:['supSel', c.code]}); });
    this.data.companies.forEach(c => { if ((c.name + c.code + c.type).toLowerCase().indexOf(q) > -1) hit.push({g:'Companies', l:c.name, s:c.code + ' · ' + c.type, go:'companies', pick:null}); });
    this.data.products.forEach(p => { if ((p.name + p.code + p.brand + p.cat).toLowerCase().indexOf(q) > -1) hit.push({g:'Products', l:p.name, s:p.code + ' · stock ' + int(p.stock) + ' ' + p.unit + ' · sale ' + money(p.sale), go:'inventory', pick:null}); });
    this.state.batches.forEach(b => { if ((b.id + b.crop + b.wh).toLowerCase().indexOf(q) > -1) hit.push({g:'Batches', l:b.id + ' — ' + b.crop, s:b.rem + ' MT left · cost ' + money(b.cost) + ' · ' + b.wh, go:'inventory', pick:null}); });
    this.state.cropLog.forEach(r => { if ((r.no + r.sup + r.crop).toLowerCase().indexOf(q) > -1) hit.push({g:'Crop purchases', l:r.no, s:r.sup + ' · ' + r.crop + ' · ' + money(r.total) + ' · ' + r.status, go:'crop-purchase', pick:null}); });
    this.state.saleLog.forEach(r => { if ((r.no + r.buyer + r.crop + r.batch).toLowerCase().indexOf(q) > -1) hit.push({g:'Crop sales', l:r.no, s:r.buyer + ' · ' + r.crop + ' · ' + money(r.amt), go:'crop-sales', pick:null}); });
    const gs = [];
    hit.slice(0, 14).forEach(h => { let g = gs.filter(x => x.g === h.g)[0]; if (!g) { g = {g:h.g, items:[]}; gs.push(g); }
      g.items.push({l:h.l, s:h.s, onClick:() => { const st = {screen:h.go, q:'', qOpen:false}; if (h.pick) st[h.pick[0]] = h.pick[1]; this.setState(st); }}); });
    return {open:true, groups:gs, q:this.state.q, empty:gs.length === 0};
  }

  /**
   * The next financial year, proposed from the latest one on file.
   *
   * Bangladesh runs July to June, so the next year almost always starts the day
   * after the last one ended and runs a year. Proposing it rather than asking
   * means the form is usually right as it opens.
   */
  nextFiscalYear() {
    const years = this.settingsData().fiscalYears || [];
    const latest = years.map(y => y.endsOn).sort().slice(-1)[0];
    if (!latest) return {};

    const end = new Date(latest);
    const start = new Date(end.getTime() + 86400000);
    const nextEnd = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate() - 1);
    const iso = d => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');

    return {
      nextCode: `FY ${start.getFullYear()}-${String(nextEnd.getFullYear()).slice(-2)}`,
      nextStart: iso(start),
      nextEnd: iso(nextEnd),
    };
  }

  /** The open settings form. */
  settingsModal() {
    const state = this.state.settingsForm;
    // The districts the business already deals in, so the company's default is
    // chosen from them rather than typed afresh.
    const districts = [...new Set(
      (this.data.customers || [])
        .concat(this.data.suppliers || [], this.data.companies || [])
        .map(p => p.district)
        .filter(Boolean)
        .concat(state.form.defaultDistrict ? [state.form.defaultDistrict] : [])
    )].sort((a, b) => a.localeCompare(b));

    return buildSettingsModal(state.kind, state, {
      onField: key => this.onSettingsField(key),
      onToggle: (key, value) => this.onSettingsToggle(key, value),
      onSubmit: () => this.submitSettings(),
      onCancel: () => this.closeSettings(),
    }, districts);
  }

  /**
   * The audit trail.
   *
   * Every write in the API records one of these inside the transaction that
   * made the change, so this table is the history rather than an illustration
   * of one. A row states which field moved and what it moved between; a change
   * touching several fields becomes several rows, which is how it reads.
   */
  auditTable() {
    const entries = this.state.auditRows;
    const header = [column('When'), column('User'), column('Action'), column('Record'), column('Field'), column('Previous'), column('New')];

    const rows = (entries || []).flatMap(entry => {
      const changed = Object.keys(entry.newValue || entry.oldValue || {})
        .filter(name => !AUDIT_BOOKKEEPING.has(name));
      // An entry with no field-level diff -- a post, an approval -- is one row
      // carrying its summary rather than nothing at all.
      const fields = changed.length ? changed : [null];

      return fields.map(name => ({
        cells: [
          cell(entry.when, { color: C.mut, mono: true, size: '12px' }),
          cell(entry.user, { weight: '600' }),
          cell(humanField(entry.action)),
          cell(this.auditRecordOf(entry), { mono: true, color: C.mut }),
          cell(name ? humanField(name) : entry.summary || '—'),
          cell(name ? auditValue(entry.oldValue, name) : '—', { mono: true, color: C.mut }),
          cell(name ? auditValue(entry.newValue, name) : '—', { mono: true, weight: '600' }),
        ],
      }));
    });

    return table(header, rows, {
      maxH: '520px',
      footNote: entries ? `${rows.length} change${rows.length === 1 ? '' : 's'} across ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : '',
      emptyTitle: this.state.auditLoading ? 'Loading the trail…' : 'Nothing recorded yet',
      emptyNote: this.state.auditLoading
        ? ''
        : 'Every create, edit, post and approval is written here as it happens.',
    });
  }

  /** The document a log entry is about: its number where the summary names one. */
  auditRecordOf(entry) {
    const match = /\b[A-Z]{2,4}-[0-9]{3,4}-[0-9]+\b/.exec(entry.summary || '');
    if (match) return match[0];
    const code = /\b[A-Z]{2,6}-[0-9]{2,4}\b/.exec(entry.summary || '');
    if (code) return code[0];
    return humanField(entry.entity) + (entry.entityId ? ` #${entry.entityId}` : '');
  }

  renderVals() {
    const S = this.state, role = this.role();
    // Configuration in hand, and the organisation inside it. Every Settings
    // panel reads from these two, so nothing on that screen is written twice.
    const cfg = this.settingsData(), org = cfg.organization;
    // Roles come from their own call where one has been made, so the Employees
    // screen has them without needing the Settings payload.
    const perms = this.permissionData();
    // A screen is offered when the user holds the permission behind it. The
    // role names are the fallback for a demo with no server to ask, where the
    // role is a tweak rather than something a session actually holds -- and
    // they are what the design's role switch goes on driving.
    const allowed = i =>
      this.props.permissions
        ? i.perm === '*' || this.may(i.perm)
        : i.roles === '*' || i.roles.indexOf(role) > -1;
    const nav = this.data.nav.map(g => ({g:g.g, items:g.items.filter(allowed).map(i => ({
      label:i.label, icon:i.icon, on:S.screen === i.id, onClick:this.go(i.id),
      bg:S.screen === i.id ? C.accBg : 'transparent', color:S.screen === i.id ? C.acc : '#4A463F',
      weight:S.screen === i.id ? '600' : '450', barBg:S.screen === i.id ? C.acc : 'transparent'}))})).filter(g => g.items.length);
    const title = this.data.titles[S.screen] || ['', ''];
    const is = {}; Object.keys(this.data.titles).forEach(k => { is[k.split('-').join('')] = S.screen === k; });
    const pendCount = S.approvals.filter(a => a.status === 'pending').length;
    return {
      modal:this.state.password ? this.passwordModal()
        : this.state.settingsForm ? this.settingsModal()
        : this.state.master ? this.masterModal() : buildModal(this),
      crop:this.crops(),
      prod:this.products(),
      wh:this.warehouses(),
      team:this.employees(),
      co:this.data.company, role:role, biz:S.biz, screen:S.screen, titleMain:title[0], titleSub:title[1], is:is,
      bizTabs:[{k:'all', l:'All business'}, {k:'dealer', l:'Dealer'}, {k:'crop', l:'Bulk Crop'}].map(x => ({l:x.l, on:x.k === S.biz,
        bg:x.k === S.biz ? '#fff' : 'transparent', color:x.k === S.biz ? C.ink : C.mut, sh:x.k === S.biz ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
        onClick:() => { this.setState({biz:x.k}); this.loadDashboard(); }})),
      nav:nav, dash:this.dash(), cp:this.calcCP(), cs:this.calcCS(), ds:this.calcDS(), dp:this.calcDP(),
      inv:this.inv(), cust:this.cust(), sup:this.sup(), acct:this.acct(), rep:this.rep(), appr:this.appr(),
      sr:this.search(), q:S.q, onQ:e => this.setState({q:e.target.value, qOpen:true}), onQClear:() => this.setState({q:'', qOpen:false}),
      notifOpen:S.notifOpen, onNotif:() => this.setState(s => ({notifOpen:!s.notifOpen, userOpen:false})), notifCount:S.notifs.length,
      notifs:S.notifs.map(n => ({t:n.t, d:n.d, ago:n.ago, onClick:this.go(n.go),
        c:n.tone === 'danger' ? C.dngr : n.tone === 'warn' ? C.warn : n.tone === 'ok' ? C.crop : C.acc})),
      userOpen:S.userOpen, onUser:() => this.setState(s => ({userOpen:!s.userOpen, notifOpen:false})),
      // Signing out and changing a password are only meaningful against a
      // server; the no-backend demo has no session to end and no password set.
      account:{
        canManage:this.serverBacked(),
        onPassword:() => this.openPassword(),
        onSignOut:() => this.signOut(),
      },
      // What this session actually holds, rather than a note about a design
      // tweak: the sidebar lists the screens these permissions reach.
      userNote:this.props.permissions
        ? `${this.props.permissions.length} permissions from the ${role} role. ` +
          'The sidebar lists only the screens they reach.'
        : `Signed in as ${role}. The sidebar lists only the screens that role reaches.`,
      toast:S.toast, toastBg:S.toast ? (S.toast.tone === 'danger' ? '#B3261E' : S.toast.tone === 'warn' ? '#8A5A00' : '#1F4D2E') : '#1F4D2E',
      onCloseToast:() => this.setState({toast:null}),
      pend:pendCount, pendText:pendCount + ' pending',
      onCP:{sup:this.h('cp', 'sup'), crop:this.h('cp', 'crop'), grade:this.h('cp', 'grade'), wh:this.h('cp', 'wh'), date:this.h('cp', 'date'),
        qty:this.h('cp', 'qty', true), unit:this.h('cp', 'unit'), moist:this.h('cp', 'moist', true), rate:this.h('cp', 'rate', true),
        transport:this.h('cp', 'transport', true), loading:this.h('cp', 'loading', true), unloading:this.h('cp', 'unloading', true),
        other:this.h('cp', 'other', true), advance:this.h('cp', 'advance', true), note:this.h('cp', 'note'),
        post:() => this.postCP(), draft:() => this.fire('Draft PC-2608-014 saved — nothing posted to stock or accounts', 'ok')},
      onCS:{buyer:this.h('cs', 'buyer'), crop:this.h('cs', 'crop'), date:this.h('cs', 'date'), rate:this.h('cs', 'rate', true),
        transport:this.h('cs', 'transport', true), other:this.h('cs', 'other', true), target:this.h('cs', 'target', true),
        auto:() => this.autoAlloc(), post:() => this.postCS(), clear:() => this.setState(s => ({cs:Object.assign({}, s.cs, {alloc:{}})}))},
      onNC:{name:this.h('newCust', 'name'), bn:this.h('newCust', 'bn'), type:this.h('newCust', 'type'), person:this.h('newCust', 'person'),
        mobile:this.h('newCust', 'mobile'), district:this.h('newCust', 'district'), upazila:this.h('newCust', 'upazila'),
        limit:this.h('newCust', 'limit', true), days:this.h('newCust', 'days', true), opening:this.h('newCust', 'opening', true)},
      onDS:{cust:this.h('ds', 'cust'), date:this.h('ds', 'date'), sp:this.h('ds', 'sp'), wh:this.h('ds', 'wh'), terms:this.h('ds', 'terms'), paid:this.h('ds', 'paid', true)},
      onDP:{co:this.h('dp', 'co'), inv:this.h('dp', 'inv'), date:this.h('dp', 'date'), wh:this.h('dp', 'wh'), terms:this.h('dp', 'terms'),
        transport:this.h('dp', 'transport', true), other:this.h('dp', 'other', true)},
      valTabs:[{k:'FIFO', l:'FIFO'}, {k:'Weighted Average', l:'Weighted average'}].map(x => ({l:x.l, on:x.k === S.valuation,
        bg:x.k === S.valuation ? C.accBg : '#fff', color:x.k === S.valuation ? C.acc : C.mut, bd:x.k === S.valuation ? C.acc : C.bd,
        onClick:() => this.setValuation(x.k)})),
      setSecs:[['company', 'Company profile'], ['fy', 'Financial year'], ['numbering', 'Numbering'], ['units', 'Units & conversion'], ['pay', 'Payment methods'],
        ['classify', 'Categories & brands'],
        ['limits', 'Approval limits'], ['valuation', 'Inventory valuation'], ['roles', 'Roles & permissions'], ['notif', 'Notification rules']].map(x => ({
        l:x[1], on:S.setSec === x[0], bg:S.setSec === x[0] ? C.accBg : 'transparent', color:S.setSec === x[0] ? C.acc : '#3D3A36',
        weight:S.setSec === x[0] ? '600' : '400', onClick:this.hs('setSec', x[0])})),
      setIs:{company:S.setSec === 'company', fy:S.setSec === 'fy', numbering:S.setSec === 'numbering', units:S.setSec === 'units',
        pay:S.setSec === 'pay', classify:S.setSec === 'classify', limits:S.setSec === 'limits',
        valuation:S.setSec === 'valuation', roles:S.setSec === 'roles', notif:S.setSec === 'notif'},
      // The grants actually held, not a description of what they were meant to
      // be: computed from `role_permissions`, and editable in place. A cell is
      // one role against one module, so clicking it opens that module's
      // permissions for that role.
      matrix:{
        cols:['Module'].concat(perms.roles),
        rows:perms.modules.map(m => ({cells:[{t:m.label, w:'600', color:'#3D3A36', align:'left', plain:true}].concat(
          perms.roles.map(role => {
            const level = m.levels[role] || '—';
            const held = perms.roleList.filter(r => r.code === role)[0];
            const editable = this.mayRoles() && !!held;
            return {t:level, w:'400', align:'center',
              color:level === 'Full' ? C.crop : level === '—' || level === 'Hidden' ? '#B6B0A6' : '#3D3A36',
              plain:!editable,
              title:editable ? `Change what ${role} may do with ${m.label.toLowerCase()}` : '',
              onClick:editable ? () => this.openSettings('grants', {
                roleId:held.id, roleName:held.name, moduleLabel:m.label,
                permissions:m.permissions,
                granted:m.permissions.filter(x => held.granted.indexOf(x.code) > -1).map(x => x.code),
              }) : null};
          }))}))},

      // The roles themselves, under the table: what each is for, how many
      // people hold it, and the controls to rename or remove one.
      roleRows:perms.roleList.map(r => ({
        k:r.name,
        d:(r.description || 'No description yet') + ' · ' + r.granted.length + ' permissions',
        tag:r.users === 1 ? '1 user' : r.users + ' users',
        tagBg:r.users ? C.dealBg : '#F0EEE9', tagFg:r.users ? C.deal : C.mut,
        canEdit:this.mayRoles(),
        onEdit:() => this.openSettings('role', r),
        // A role the system is set up around stays; one nobody holds can go.
        canRemove:this.mayRoles() && !r.system && !r.users,
        onRemove:() => this.removeRole(r),
      })),
      addRole:{canAdd:this.mayRoles(), label:'Add role',
        onAdd:() => this.openSettings('role', {})},
      rolesNote:this.mayRoles()
        ? 'Click a cell to change what that role may do. The server checks these on every request, so a change applies at once — including to anyone already signed in.'
        : 'What each role may do. The server checks these on every request, so the table is the rule rather than a description of it.',

      audit:this.auditTable(),
      invoices:this.invoiceList(),
      repFilters:[{k:'Period', v:'01–28 Aug 2026'}, {k:'Business type', v:S.biz === 'all' ? 'All' : S.biz === 'crop' ? 'Bulk Crop' : 'Dealer'},
        {k:'Warehouse', v:'All'}, {k:'Customer', v:'All'}, {k:'Supplier', v:'All'}, {k:'Crop / product', v:'All'}, {k:'Currency', v:'BDT ৳'}],
      skeleton:[{w:'92%'}, {w:'78%'}, {w:'85%'}, {w:'64%'}, {w:'88%'}, {w:'71%'}],
      // Read from the organisation record rather than restated here: the
      // trade licence and BIN go on invoices and cannot be a second copy.
      setCompany:[{k:'Company name', v:org.name}, {k:'System name', v:org.systemName},
        {k:'Trade licence no', v:org.tradeLicenceNo || '—'}, {k:'BIN / VAT registration', v:org.binNo || '—'},
        {k:'Head office', v:org.headOffice || '—'}, {k:'Mobile', v:org.mobile || '—'}, {k:'Email', v:org.email || '—'},
        {k:'Currency', v:currencyName(org.currency)}, {k:'Default district', v:org.defaultDistrict || '—'}],
      companyEdit:{canEdit:this.maySettings(), label:'Edit profile',
        onEdit:() => this.openSettings('company', org)},

      setFy:cfg.fiscalYears.map(y => ({
        k:y.code, d:y.span,
        tag:y.status, bg:y.current ? '#FBFAF8' : '#fff',
        tagBg:y.current ? C.cropBg : y.closed ? '#F0EEE9' : C.warnBg,
        tagFg:y.current ? C.crop : y.closed ? '#3D3A36' : C.warn,
        // A year that is neither current nor closed can be adopted; the current
        // one cannot be closed while it is the only place documents can go.
        canAdopt:this.maySettings() && !y.current && !y.closed,
        canClose:this.maySettings() && !y.current && !y.closed,
        canReopen:this.maySettings() && y.closed,
        onAdopt:() => this.changeFiscalYear(y, {current:true}, y.code + ' is now the current financial year'),
        onClose:() => this.changeFiscalYear(y, {closed:true}, y.code + ' closed — its transactions are locked'),
        onReopen:() => this.changeFiscalYear(y, {closed:false}, y.code + ' reopened'),
      })),
      addFy:{canAdd:this.maySettings(), label:'Add year',
        onAdd:() => this.openSettings('fiscalYear', this.nextFiscalYear())},

      setNum:cfg.numbering.map(n => ({
        k:n.label, v:n.pattern,
        d:n.issued ? n.issued + ' issued' + (n.lastPeriod ? ' in ' + n.lastPeriod : '') : 'none issued yet',
        canEdit:this.maySettings(), onEdit:() => this.openSettings('numbering', n),
      })),

      setUnits:cfg.units.map(u => {
        const on = u.active !== false;
        return {
          // The name reads on its own; the code belongs with the conversion,
          // which already names it — 'Bag (50 kg) (Bag)' helped nobody.
          k:u.name, v:u.base ? u.conversion : u.code + ' · base unit',
          tone:on ? C.crop : '#D9D5CD', knob:on ? '19px' : '2px',
          canEdit:this.mayMaster('unit', 'edit'),
          canToggle:on ? this.mayMaster('unit', 'delete') : this.mayMaster('unit', 'edit'),
          toggleLabel:on ? 'Retire' : 'Restore',
          onEdit:() => this.openMaster('unit', u),
          onToggle:() => (on ? this.confirmRetire('unit', u) : this.restoreMaster('unit', u)),
        };
      }),
      // Categories and brands read the same way as units: a list, an add
      // button, and a switch that retires or restores the row it sits beside.
      setClassify:[
        {kind:'productCategory', title:'Product categories',
          note:'What the dealer catalogue is grouped by',
          rows:this.settingsData().categories || []},
        {kind:'brand', title:'Brands',
          note:'Whose product it is — the maker, not the supplier',
          rows:this.settingsData().brands || []},
      ].map(group => ({
        title:group.title, note:group.note,
        canAdd:this.mayMaster(group.kind, 'create'),
        addLabel:group.kind === 'brand' ? 'Add brand' : 'Add category',
        onAdd:() => this.openMaster(group.kind),
        isEmpty:group.rows.length === 0,
        emptyNote:'None yet — add one and it appears on the product form.',
        rows:group.rows.map(r => {
          const on = r.active !== false;
          return {
            k:r.name,
            d:r.products ? r.products + (r.products === 1 ? ' product' : ' products') : 'nothing filed under it',
            tone:on ? C.crop : '#D9D5CD', knob:on ? '19px' : '2px',
            canEdit:this.mayMaster(group.kind, 'edit'),
            canToggle:on ? this.mayMaster(group.kind, 'delete') : this.mayMaster(group.kind, 'edit'),
            toggleLabel:on ? 'Retire' : 'Restore',
            onEdit:() => this.openMaster(group.kind, r),
            onToggle:() => (on ? this.confirmRetire(group.kind, r) : this.restoreMaster(group.kind, r)),
          };
        }),
      })),
      addUnit:{canAdd:this.mayMaster('unit', 'create'), label:'Add unit',
        onAdd:() => this.openMaster('unit')},

      // Real methods once fetched; the bundled list is the no-backend
      // fallback. The switch used to be a picture -- it now retires or
      // restores the method it sits beside.
      setPay: (S.masterRows.method || this.data.paymentMethods || PAYMENT_METHODS)
        .map(p => {
          const on = p.active !== undefined ? p.active : p.on !== undefined ? p.on : true;
          const row = { ...p, name: p.name || p.k, code: p.code || p.k };
          return {
            k: row.name,
            d: p.account || p.d || (on ? 'in use' : 'not in use'),
            tone: on ? C.crop : '#D9D5CD',
            knob: on ? '19px' : '2px',
            canEdit: this.mayMaster('method', 'edit'),
            canToggle: on ? this.mayMaster('method', 'delete') : this.mayMaster('method', 'edit'),
            toggleLabel: on ? 'Retire' : 'Restore',
            onEdit: () => this.openMaster('method', row),
            onToggle: () => (on ? this.confirmRetire('method', row) : this.restoreMaster('method', row)),
          };
        }),
      addMethod:{canAdd:this.mayMaster('method', 'create'), label:'Add method',
        onAdd:() => this.openMaster('method')},

      // The limits the approval engine actually applies. The label is built
      // from the threshold rather than stored beside it, so the two can never
      // disagree the way 'Purchase above ৳5,00,000' did once the figure moved.
      setLimits:cfg.approvalRules.map(r => ({
        k:approvalRuleLabel(r),
        v:r.condition === 'ALWAYS' ? 'always' : r.condition === 'DISCOUNT_PCT_ABOVE'
          ? Number(r.threshold).toFixed(2) + '%' : money(r.threshold),
        d:r.active ? '' : 'switched off',
        muted:!r.active,
        canEdit:this.maySettings() && r.condition !== 'ALWAYS',
        onEdit:() => this.openSettings('limit', r),
      })),

      setNotif:cfg.notificationRules.map(n => ({
        k:n.name,
        // The rule says where its own figure belongs, so a day count and a
        // taka amount each read as a sentence rather than as a prefix.
        d:n.threshold === null ? n.description
          : n.description.replace('{value}', n.unit === 'days' ? n.threshold : money(n.threshold)),
        on:n.active, tag:n.active ? 'On' : 'Off',
        tagBg:n.active ? C.cropBg : '#F0EEE9', tagFg:n.active ? C.crop : '#8C877F',
        canEdit:this.maySettings() && n.threshold !== null,
        canToggle:this.maySettings(),
        onEdit:() => this.openSettings('notification', n),
        onToggle:() => this.toggleNotification(n),
      })),
      phones: PHONE_SCREENS,
      companyAdd:{canAdd:this.mayMaster('company', 'create'), addLabel:'Add company', onAdd:() => this.openMaster('company')},
      companiesTable:table([column('Code'), column('Company'), column('Role'), column('Contact person'), column('Mobile'), column('Credit limit', 'right'), column('Balance', 'right'), column('Status', 'center'), column('', 'right')],
        this.data.companies.map(c => ({cells:[cell(c.code, {mono:true, color:C.mut}), cell(c.name, {weight:'600', sub:c.district}),
          cell(c.type, {badge:true, badgeBg:c.type === 'Buyer' ? C.cropBg : c.type === 'Principal' ? C.dealBg : '#F0EEE9', badgeFg:c.type === 'Buyer' ? C.crop : c.type === 'Principal' ? C.deal : '#3D3A36'}),
          cell(c.person), cell(c.mobile, {mono:true}), cell(c.limit ? money(c.limit) : '—', {align:'right', mono:true, color:C.mut}),
          cell((c.bal < 0 ? 'Receivable ' : 'Payable ') + money(Math.abs(c.bal)), {align:'right', mono:true, weight:'600', color:c.bal < 0 ? C.crop : C.ink}),
          cell(c.status, {align:'center', badge:true, badgeBg:c.status === 'Active' ? C.cropBg : C.warnBg, badgeFg:c.status === 'Active' ? C.crop : C.warn}),
          cell('', {align:'right', actions:this.masterRowActions('company', c)})]})),
        {footNote:this.data.companies.length + ' companies · one company can act as both supplier and buyer'})
    };
  }
}
