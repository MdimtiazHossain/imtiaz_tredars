import { describe, it, expect, beforeEach } from 'vitest';
import appTemplate from '../src/templates/app.html?raw';
import dataTableTemplate from '../src/templates/dataTable.html?raw';
import formModalTemplate from '../src/templates/formModal.html?raw';
import { BusinessApp } from '../src/app/logic.js';
import { Repository } from '../src/data/repository.js';

/** Mount the real design templates against the real screen logic. */
async function mountApp(props = {}) {
  const repository = new Repository({ latency: 0 });
  const data = await repository.load();
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = new BusinessApp(
    { role: 'Admin', showProfit: true, approvalLimit: 500000, repository, ...props },
    data
  );
  app.mount(root, appTemplate, {
    DataTable: dataTableTemplate,
    FormModal: formModalTemplate,
  });
  return { app, root };
}

/** Apply pending state and repaint synchronously. */
function flush(app) {
  app.renderNow();
}

const SCREENS = [
  'dashboard',
  'crop-purchase',
  'crop-sales',
  'dealer-purchase',
  'dealer-sales',
  'inventory',
  'customers',
  'suppliers',
  'companies',
  'accounts',
  'approvals',
  'reports',
  'settings',
  'employees',
  'audit',
  'mobile',
];

describe('application shell', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('mounts and renders the sidebar identity', async () => {
    const { root } = await mountApp();
    expect(root.textContent).toContain('Meghna Agro Enterprise');
    expect(root.querySelector('aside')).not.toBeNull();
  });

  it('renders the dashboard by default with its KPI cards', async () => {
    const { root } = await mountApp();
    expect(root.querySelector('h1').textContent).toBe('Business Overview');
    expect(root.textContent).toContain("Today's Sales");
  });

  it('renders a DataTable with rows and a sticky header', async () => {
    const { root } = await mountApp();
    const table = root.querySelector('table');
    expect(table).not.toBeNull();
    expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(table.querySelector('thead th').getAttribute('style')).toContain('position:sticky');
  });
});

describe('navigation', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it.each(SCREENS)('renders the %s screen without error', async (screen) => {
    const { app, root } = await mountApp();
    app.setState({ screen });
    flush(app);
    expect(root.querySelector('h1').textContent).toBe(app.data.titles[screen][0]);
    expect(root.textContent.length).toBeGreaterThan(200);
  });

  it('moves screen when a sidebar item is clicked', async () => {
    const { app, root } = await mountApp();
    const buttons = [...root.querySelectorAll('aside nav button')];
    const inventory = /** @type {HTMLElement} */ (
      buttons.find((b) => b.textContent.trim() === 'Inventory')
    );
    inventory.click();
    flush(app);
    expect(app.state.screen).toBe('inventory');
    expect(root.querySelector('h1').textContent).toBe('Inventory & Batch Stock');
  });
});

describe('role-based access', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('hides settings from a sales user', async () => {
    const { root } = await mountApp({ role: 'Sales' });
    const labels = [...root.querySelectorAll('aside nav button')].map((b) => b.textContent.trim());
    expect(labels).toContain('Dealer Sales');
    expect(labels).not.toContain('Settings');
  });

  it('gives an admin the full navigation', async () => {
    const { root } = await mountApp({ role: 'Admin' });
    const labels = [...root.querySelectorAll('aside nav button')].map((b) => b.textContent.trim());
    expect(labels).toContain('Settings');
    expect(labels).toContain('Audit Trail');
  });

  it('withholds profit figures from a warehouse user', async () => {
    const { app } = await mountApp({ role: 'Warehouse' });
    expect(app.canProfit()).toBe(false);
  });
});

describe('global search', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('is closed until something is typed', async () => {
    const { app } = await mountApp();
    expect(app.search().open).toBe(false);
  });

  it('finds a customer by name', async () => {
    const { app } = await mountApp();
    app.setState({ q: 'Rahman', qOpen: true });
    const groups = app.search().groups;
    expect(groups.some((g) => g.g === 'Customers')).toBe(true);
  });

  it('reports no match for nonsense', async () => {
    const { app } = await mountApp();
    app.setState({ q: 'zzzznotathing', qOpen: true });
    expect(app.search().empty).toBe(true);
  });
});

describe('inventory sorting', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('marks the active sort column and reorders rows', async () => {
    const { app } = await mountApp();
    app.setState({ screen: 'inventory', invSort: 'value' });
    const byValue = app.inv().table;
    expect(byValue.cols.some((c) => c.sortMark === '  ↓')).toBe(true);

    app.setState({ invSort: 'name' });
    const byName = app.inv().table;
    expect(byName.rows[0].cells[0].text).not.toBe(byValue.rows[0].cells[0].text);
  });
});

describe('approvals', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('moves a request out of the pending queue once approved', async () => {
    const { app } = await mountApp();
    const before = app.appr().count;
    app.appr().cards[0].onOk();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.appr().count).toBe(before - 1);
  });
});

describe('crop purchase posting', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('adds a batch and a log row when posted', async () => {
    const { app } = await mountApp();
    const batches = app.state.batches.length;
    const log = app.state.cropLog.length;
    app.postCP();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.state.batches).toHaveLength(batches + 1);
    expect(app.state.cropLog).toHaveLength(log + 1);
  });

  it('refuses to post an empty quantity', async () => {
    const { app } = await mountApp();
    app.setState({ cp: { ...app.state.cp, qty: 0 } });
    const batches = app.state.batches.length;
    app.postCP();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.state.batches).toHaveLength(batches);
    expect(app.state.toast.tone).toBe('danger');
  });
});

describe('customer creation', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('requires a name and mobile number', async () => {
    const { app } = await mountApp();
    app.saveCustomer();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.state.toast.tone).toBe('danger');
    expect(app.state.extraCusts).toHaveLength(0);
  });

  it('adds the customer and selects it on the invoice', async () => {
    const { app } = await mountApp();
    app.setState({
      newCust: { ...app.state.newCust, name: 'Test Traders', mobile: '01700-000000' },
    });
    app.saveCustomer();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.state.extraCusts).toHaveLength(1);
    expect(app.state.ds.cust).toBe(app.state.extraCusts[0].code);
  });
});

describe('dealer posting', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('posts a dealer sale through the repository', async () => {
    const { app } = await mountApp();
    const calls = [];
    app.repository.postDealerSale = async (payload) => {
      calls.push(payload);
      return { txnNo: 'DS-9999-001', status: 'POSTED' };
    };

    app.calcDS().onPost();
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toHaveLength(1);
    expect(calls[0].intent.customerCode).toBe(app.state.ds.cust);
    expect(calls[0].intent.lines).toHaveLength(app.state.ds.lines.length);
    expect(app.state.toast.msg).toContain('DS-9999-001');
    expect(app.state.toast.tone).toBe('ok');
  });

  it('refuses to post a dealer sale beyond the credit limit', async () => {
    const { app } = await mountApp();
    let called = false;
    app.repository.postDealerSale = async () => { called = true; return {}; };

    // Push the invoice far past the customer's limit.
    app.setState({ ds: { ...app.state.ds, lines: [{ pid: 'P-1001', qty: 100000, rate: 295, disc: 0, bonus: 0 }] } });
    app.calcDS().onPost();
    await new Promise((r) => setTimeout(r, 20));

    expect(called).toBe(false);
    expect(app.state.toast.tone).toBe('danger');
    expect(app.state.toast.msg).toMatch(/credit limit/i);
  });

  it('reports an approval-routed dealer sale as pending', async () => {
    const { app } = await mountApp();
    app.repository.postDealerSale = async () => ({ txnNo: 'DS-9999-002', status: 'PENDING_APPROVAL' });

    app.calcDS().onPost();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.toast.msg).toMatch(/sent for approval/i);
    expect(app.state.toast.tone).toBe('warn');
  });

  it('posts a dealer purchase through the repository', async () => {
    const { app } = await mountApp();
    const calls = [];
    app.repository.postDealerPurchase = async (payload) => {
      calls.push(payload);
      return { txnNo: 'DP-9999-001', status: 'POSTED' };
    };

    app.calcDP().onPost();
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toHaveLength(1);
    expect(calls[0].intent.companyCode).toBe(app.state.dp.co);
    expect(app.state.toast.msg).toContain('DP-9999-001');
  });

  it('does not claim a negative receivable when the customer overpays', async () => {
    const { app } = await mountApp();
    app.repository.postDealerSale = async () => ({ txnNo: 'DS-9999-003', status: 'POSTED' });

    // The invoice defaults carry a payment larger than the invoice total.
    app.calcDS().onPost();
    await new Promise((r) => setTimeout(r, 20));

    expect(app.state.toast.msg).not.toMatch(/receivable ৳-/);
    expect(app.state.toast.msg).toMatch(/settled in full/);
  });

  it('reports the receivable when there is a genuine balance', async () => {
    const { app } = await mountApp();
    app.repository.postDealerSale = async () => ({ txnNo: 'DS-9999-004', status: 'POSTED' });

    app.setState({ ds: { ...app.state.ds, paid: 0 } });
    app.calcDS().onPost();
    await new Promise((r) => setTimeout(r, 20));

    expect(app.state.toast.msg).toMatch(/receivable ৳[\d,]+ created/);
  });

  it('surfaces a server error as a danger toast', async () => {
    const { app } = await mountApp();
    app.repository.postDealerSale = async () => {
      throw new Error('Only 3 available in Bogura Depot.');
    };

    app.calcDS().onPost();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.toast.tone).toBe('danger');
    expect(app.state.toast.msg).toContain('Only 3 available');
  });
});

describe('duplicate submission', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('sends only one request when Post is clicked twice', async () => {
    const { app } = await mountApp();
    let calls = 0;
    app.repository.postCropPurchase = async (payload) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return payload;
    };

    app.postCP();
    app.postCP();
    await new Promise((r) => setTimeout(r, 80));

    expect(calls).toBe(1);
  });

  it('does not show an error toast for the ignored second click', async () => {
    const { app } = await mountApp();
    app.repository.postCropPurchase = async (payload) => {
      await new Promise((r) => setTimeout(r, 30));
      return payload;
    };

    app.postCP();
    app.postCP();
    await new Promise((r) => setTimeout(r, 80));

    expect(app.state.toast.tone).not.toBe('danger');
  });

  it('allows a second post once the first has settled', async () => {
    const { app } = await mountApp();
    let calls = 0;
    app.repository.postCropPurchase = async (payload) => {
      calls += 1;
      return payload;
    };

    app.postCP();
    await new Promise((r) => setTimeout(r, 20));
    app.postCP();
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toBe(2);
  });

  it('shows saving feedback while a write is in flight', async () => {
    const { app } = await mountApp();
    app.repository.createCustomer = async (record) => {
      await new Promise((r) => setTimeout(r, 40));
      return record;
    };

    app.setState({ newCust: { ...app.state.newCust, name: 'Feedback Co', mobile: '01700-111222' } });
    app.saveCustomer();

    // Mid-flight the user sees progress, and the write is marked busy.
    await new Promise((r) => setTimeout(r, 10));
    expect(app.state.toast.msg).toBe('Saving…');
    expect(app.state.busy).toBe('createCustomer');

    await new Promise((r) => setTimeout(r, 80));
    expect(app.state.busy).toBeNull();
    expect(app.state.toast.msg).toContain('created and selected');
  });
});

describe('trend chart', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  const trend = [
    { month: '2026-07', sales: 500000, purchase: 200000, profit: 100000 },
    { month: '2026-08', sales: 900000, purchase: 2000000, profit: 300000 },
  ];

  it('labels each bar with its month name', async () => {
    const { app } = await mountApp();
    const bars = app.serverChart(trend);
    expect(bars.map((b) => b.l)).toEqual(['Jul', 'Aug']);
  });

  it('converts taka to lakh for the caption', async () => {
    const { app } = await mountApp();
    const bars = app.serverChart(trend);
    expect(bars[0].sText).toBe('৳5.0 L');
    expect(bars[1].sText).toBe('৳9.0 L');
  });

  it('keeps a purchase bar larger than sales inside the track', async () => {
    const { app } = await mountApp();
    const bars = app.serverChart(trend);
    // August purchases (৳20 L) exceed its sales (৳9 L); scaling by sales alone
    // would push the bar past the 150px track.
    const purchaseHeight = parseFloat(bars[1].pH);
    expect(purchaseHeight).toBeLessThanOrEqual(150);
    expect(purchaseHeight).toBeGreaterThan(parseFloat(bars[1].sH));
  });

  it('scales both series against the same peak', async () => {
    const { app } = await mountApp();
    const bars = app.serverChart(trend);
    // 5 L against a 20 L peak is a quarter of the tallest bar.
    const ratio = parseFloat(bars[0].sH) / parseFloat(bars[1].pH);
    expect(ratio).toBeCloseTo(0.25, 2);
  });

  it('names sales, purchase and profit in the tooltip', async () => {
    const { app } = await mountApp();
    const bars = app.serverChart(trend);
    expect(bars[1].tip).toContain('sales ৳9.0 L');
    expect(bars[1].tip).toContain('purchase ৳20.0 L');
    expect(bars[1].tip).toContain('profit ৳3.0 L');
  });

  it('omits profit from the tooltip when the role may not see it', async () => {
    const { app } = await mountApp();
    const bars = app.serverChart([{ month: '2026-08', sales: 100000, purchase: 50000, profit: null }]);
    expect(bars[0].tip).toContain('sales');
    expect(bars[0].tip).not.toContain('profit');
  });

  it('does not divide by zero on a month with no activity', async () => {
    const { app } = await mountApp();
    const bars = app.serverChart([{ month: '2026-08', sales: 0, purchase: 0, profit: 0 }]);
    expect(bars[0].sH).toBe('0.0px');
    expect(Number.isNaN(parseFloat(bars[0].pH))).toBe(false);
  });

  it('returns nothing for an empty series', async () => {
    const { app } = await mountApp();
    expect(app.serverChart([])).toEqual([]);
    expect(app.serverChart(null)).toEqual([]);
  });
});

describe('transaction forms', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('opens the payment form seeded from the action that raised it', async () => {
    const { app } = await mountApp();
    app.openForm('payment', { direction: 'PAYMENT', partyType: 'SUPPLIER' });
    expect(app.state.modal.kind).toBe('payment');
    expect(app.state.modal.form.direction).toBe('PAYMENT');
    expect(app.state.modal.form.party).toMatch(/^SUP-/);
  });

  it('renders the modal into the page when open', async () => {
    const { app, root } = await mountApp();
    expect(root.textContent).not.toContain('Record a payment');
    app.openForm('payment');
    flush(app);
    expect(root.textContent).toContain('Record a payment');
  });

  it('closes on cancel without saving', async () => {
    const { app } = await mountApp();
    let saved = false;
    app.repository.createPayment = async () => { saved = true; return {}; };
    app.openForm('payment');
    app.renderVals().modal.onCancel();
    expect(app.state.modal).toBeNull();
    expect(saved).toBe(false);
  });

  it('refuses a payment with no amount', async () => {
    const { app } = await mountApp();
    let called = false;
    app.repository.createPayment = async () => { called = true; return {}; };
    app.openForm('payment');
    app.submitForm();
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(false);
    expect(app.state.modal.error).toMatch(/amount/i);
  });

  it('refuses a stock adjustment with no reason', async () => {
    const { app } = await mountApp();
    app.openForm('adjustment');
    app.setState({ modal: { ...app.state.modal, form: { ...app.state.modal.form, quantityDelta: -4 } } });
    app.submitForm();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.modal.error).toMatch(/reason/i);
  });

  it('refuses a stock adjustment of zero', async () => {
    const { app } = await mountApp();
    app.openForm('adjustment');
    app.setState({
      modal: { ...app.state.modal, form: { ...app.state.modal.form, quantityDelta: 0, reason: 'Recount' } },
    });
    app.submitForm();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.modal.error).toMatch(/zero/i);
  });

  it('resets the party when the party type changes', async () => {
    const { app } = await mountApp();
    app.openForm('payment');
    expect(app.state.modal.form.party).toMatch(/^CUS-/);
    app.onFormField('partyType')({ target: { value: 'SUPPLIER' } });
    expect(app.state.modal.form.party).toMatch(/^SUP-/);
  });

  it('defaults a transfer to two different warehouses', async () => {
    const { app } = await mountApp();
    app.openForm('transfer');
    const { fromWarehouse, toWarehouse } = app.state.modal.form;
    // Moving stock to where it already is has no meaning, so the form must not
    // open in a state the server would reject.
    expect(fromWarehouse).not.toBe(toWarehouse);
  });

  it('refuses a transfer into the same warehouse', async () => {
    const { app } = await mountApp();
    let called = false;
    app.repository.createStockTransfer = async () => { called = true; return {}; };

    app.openForm('transfer');
    const from = app.state.modal.form.fromWarehouse;
    app.onFormField('toWarehouse')({ target: { value: from } });
    app.onFormField('quantity')({ target: { value: '5' } });
    app.submitForm();
    await new Promise((r) => setTimeout(r, 20));

    expect(called).toBe(false);
    expect(app.state.modal.error).toMatch(/different warehouses/i);
  });

  it('refuses a transfer of nothing', async () => {
    const { app } = await mountApp();
    app.openForm('transfer');
    app.submitForm();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.modal.error).toMatch(/quantity/i);
  });

  it('shows what stays behind without floating-point noise', async () => {
    const { app } = await mountApp();
    app.openForm('transfer');
    const batch = app.data.batches.find((b) => b.id === app.state.modal.form.item);
    app.onFormField('quantity')({ target: { value: String(batch.rem - 15.6) } });

    const summary = app.renderVals().modal.summary.map((s) => s.v);
    // 21.6 - 6 is 15.600000000000001 in binary floating point; the form shows
    // quantities the way the schema stores them.
    expect(summary.every((v) => !String(v).includes('000000'))).toBe(true);
    expect(summary).toContain('15.6');
  });

  it('sends the transfer the server expects, with database ids', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.createStockTransfer = async (t) => {
      sent.push(t);
      return { txnNo: 'TRF-9999-001', status: 'POSTED' };
    };

    // In API mode the workspace carries a name-to-id map; the payload must use
    // it, because the server takes ids and an undefined one fails every write.
    app.data.warehouseIds = Object.fromEntries(app.data.warehouses.map((w, i) => [w, i + 1]));

    app.openForm('transfer');
    app.onFormField('quantity')({ target: { value: '4' } });
    app.submitForm();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent).toHaveLength(1);
    expect(sent[0].fromWarehouseId).not.toBe(sent[0].toWarehouseId);
    expect(sent[0].lines).toHaveLength(1);
    expect(sent[0].lines[0]).toMatchObject({ itemType: 'CROP_BATCH', quantity: 4 });
    expect(app.state.modal).toBeNull();
    expect(app.state.toast.msg).toContain('TRF-9999-001');
  });

  it('resets the item when the stock kind changes', async () => {
    const { app } = await mountApp();
    app.openForm('adjustment');
    expect(app.state.modal.form.item).toMatch(/^BC-/);
    app.onFormField('itemType')({ target: { value: 'PRODUCT' } });
    expect(app.state.modal.form.item).toMatch(/^P-/);
  });

  it('sends the payment the server expects and closes on success', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.createPayment = async (p) => {
      sent.push(p);
      return { txnNo: 'RC-9999-001' };
    };

    app.openForm('payment');
    app.onFormField('amount')({ target: { value: '25000' } });
    app.submitForm();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ direction: 'RECEIPT', partyType: 'CUSTOMER', amount: 25000 });
    expect(typeof sent[0].accountId).toBe('number');
    expect(app.state.modal).toBeNull();
    expect(app.state.toast.msg).toContain('RC-9999-001');
  });

  it('sends a shared expense as a null business type', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.createExpense = async (e) => { sent.push(e); return { txnNo: 'EXP-1' }; };

    app.openForm('expense');
    app.onFormField('amount')({ target: { value: '5000' } });
    app.submitForm();
    await new Promise((r) => setTimeout(r, 40));

    // 'Shared' is the absence of a business line, not a third value.
    expect(sent[0].businessType).toBeNull();
    expect(sent[0].amount).toBe(5000);
  });

  it('reports an approval-routed adjustment rather than claiming it posted', async () => {
    const { app } = await mountApp();
    app.repository.createStockAdjustment = async () => ({
      txnNo: 'ADJ-9999-001',
      status: 'PENDING_APPROVAL',
    });

    app.openForm('adjustment');
    app.setState({
      modal: { ...app.state.modal, form: { ...app.state.modal.form, quantityDelta: -4, reason: 'Weight loss' } },
    });
    app.submitForm();
    await new Promise((r) => setTimeout(r, 40));

    expect(app.state.toast.msg).toMatch(/submitted for approval/);
    expect(app.state.toast.tone).toBe('warn');
  });

  it('keeps the form open and shows the reason when the server refuses', async () => {
    const { app } = await mountApp();
    app.repository.createPayment = async () => {
      throw new Error('Cannot allocate more than the balance outstanding.');
    };

    app.openForm('payment');
    app.onFormField('amount')({ target: { value: '999999' } });
    app.submitForm();
    await new Promise((r) => setTimeout(r, 40));

    expect(app.state.modal).not.toBeNull();
    expect(app.state.modal.busy).toBe(false);
    expect(app.state.modal.error).toContain('Cannot allocate');
  });

  it('names an overpayment as money on account, not a negative balance', async () => {
    const { app } = await mountApp();
    app.openForm('payment');
    // Pay more than the selected customer actually owes.
    const owed = app.data.customers[0].out;
    app.onFormField('amount')({ target: { value: String(owed + 50000) } });
    const summary = app.renderVals().modal.summary.map((r) => r.k);
    expect(summary).toContain('Settled, leaving on account');
    expect(summary).not.toContain('Outstanding after');
  });

  it('offers the actions on the screens that host them', async () => {
    const { app, root } = await mountApp();

    app.setState({ screen: 'accounts' });
    flush(app);
    const accountsButtons = [...root.querySelectorAll('.app-main button')].map((b) => b.textContent.trim());
    expect(accountsButtons).toContain('Receive payment');
    expect(accountsButtons).toContain('Pay supplier');
    expect(accountsButtons).toContain('Add expense');

    app.setState({ screen: 'inventory' });
    flush(app);
    const inventoryButtons = [...root.querySelectorAll('.app-main button')].map((b) => b.textContent.trim());
    expect(inventoryButtons).toContain('Adjust stock');
  });
});

describe('payment allocation', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  const invoices = [
    { invoiceType: 'dealer_sales', invoiceId: 7, invoiceNo: 'DS-1', balance: 100000, dueDate: '2026-08-01' },
    { invoiceType: 'dealer_sales', invoiceId: 9, invoiceNo: 'DS-2', balance: 50000, dueDate: '2026-08-20' },
  ];

  /** Open the payment form with a known set of invoices already loaded. */
  async function withInvoices() {
    const { app } = await mountApp();
    app.repository.openInvoices = async () => invoices;
    app.openForm('payment');
    await new Promise((r) => setTimeout(r, 30));
    return app;
  }

  it('lists the party open invoices', async () => {
    const app = await withInvoices();
    const rows = app.renderVals().modal.allocation.rows;
    expect(rows.map((r) => r.invoiceNo)).toEqual(['DS-1', 'DS-2']);
  });

  it('shows the whole payment as unallocated until something is applied', async () => {
    const app = await withInvoices();
    app.onFormField('amount')({ target: { value: '80000' } });
    expect(app.renderVals().modal.allocation.footTotal).toContain('80,000 unallocated');
  });

  it('settles the oldest invoice first', async () => {
    const app = await withInvoices();
    app.onFormField('amount')({ target: { value: '120000' } });
    app.autoAllocate();

    // 100,000 clears the older invoice, the remaining 20,000 goes to the next.
    expect(app.state.modal.form.allocated).toEqual({
      'dealer_sales:7': 100000,
      'dealer_sales:9': 20000,
    });
  });

  it('never allocates more than an invoice still owes', async () => {
    const app = await withInvoices();
    app.onFormField('amount')({ target: { value: '999999' } });
    app.autoAllocate();
    const allocated = app.state.modal.form.allocated;
    expect(allocated['dealer_sales:7']).toBe(100000);
    expect(allocated['dealer_sales:9']).toBe(50000);
  });

  it('leaves the surplus unallocated rather than forcing it onto an invoice', async () => {
    const app = await withInvoices();
    app.onFormField('amount')({ target: { value: '200000' } });
    app.autoAllocate();
    expect(app.renderVals().modal.allocation.footTotal).toContain('50,000 unallocated');
  });

  it('flags a line asking for more than the invoice owes', async () => {
    const app = await withInvoices();
    app.onFormField('amount')({ target: { value: '500000' } });
    app.onAllocationChange('dealer_sales:7', '400000');
    const row = app.renderVals().modal.allocation.rows[0];
    expect(row.border).not.toBe('#E3E0DA');
  });

  it('refuses to submit when more is allocated than received', async () => {
    const app = await withInvoices();
    let posted = false;
    app.repository.createPayment = async () => { posted = true; return {}; };

    app.onFormField('amount')({ target: { value: '50000' } });
    app.onAllocationChange('dealer_sales:7', '90000');
    app.submitForm();
    await new Promise((r) => setTimeout(r, 30));

    expect(posted).toBe(false);
    expect(app.state.modal.error).toMatch(/more than the payment/i);
  });

  it('sends only the lines that were filled in', async () => {
    const app = await withInvoices();
    const sent = [];
    app.repository.createPayment = async (p) => { sent.push(p); return { txnNo: 'RC-1' }; };

    app.onFormField('amount')({ target: { value: '100000' } });
    app.onAllocationChange('dealer_sales:7', '60000');
    app.submitForm();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent[0].allocations).toEqual([
      { invoiceType: 'dealer_sales', invoiceId: 7, amount: 60000 },
    ]);
  });

  it('clears the allocation when the party changes', async () => {
    const app = await withInvoices();
    app.onFormField('amount')({ target: { value: '100000' } });
    app.autoAllocate();
    expect(Object.keys(app.state.modal.form.allocated)).not.toHaveLength(0);

    app.onFormField('party')({ target: { value: 'CUS-002' } });
    // The invoices on offer have changed, so what was entered no longer applies.
    expect(app.state.modal.form.allocated).toEqual({});
  });

  it('offers the empty state when the party owes nothing', async () => {
    const { app } = await mountApp();
    app.repository.openInvoices = async () => [];
    app.openForm('payment');
    await new Promise((r) => setTimeout(r, 30));

    const alloc = app.renderVals().modal.allocation;
    expect(alloc.isEmpty).toBe(true);
    expect(alloc.emptyNote).toMatch(/sit on account/i);
  });
});

describe('master data', () => {
  it('offers every master screen a way to add a record', async () => {
    const { app } = await mountApp();
    const vals = app.renderVals();
    expect(vals.cust.canAdd).toBe(true);
    expect(vals.sup.canAdd).toBe(true);
    expect(vals.companyAdd.canAdd).toBe(true);
    expect(vals.crop.canAdd).toBe(true);
  });

  it('hides what the signed-in user may not do', async () => {
    // Sales can add and edit customers but not retire them, and cannot touch
    // crops at all. The server enforces the same codes; this only decides
    // what to draw.
    const { app } = await mountApp({ permissions: ['customer.create', 'customer.edit'] });
    const vals = app.renderVals();
    expect(vals.cust.canAdd).toBe(true);
    expect(vals.cust.canEdit).toBe(true);
    expect(vals.cust.canRetire).toBe(false);
    expect(vals.crop.canAdd).toBe(false);
  });

  it('opens an empty form to add and a filled one to edit', async () => {
    const { app } = await mountApp();
    app.openMaster('supplier');
    expect(app.state.master.row).toBeNull();
    expect(app.state.master.form.name).toBe('');

    const existing = app.data.suppliers[0];
    app.openMaster('supplier', existing);
    expect(app.state.master.form.name).toBe(existing.name);
    expect(app.state.master.form.district).toBe(existing.district);
    expect(app.renderVals().modal.title).toMatch(/edit supplier/i);
  });

  it('refuses a record with no name', async () => {
    const { app } = await mountApp();
    let called = false;
    app.repository.createMaster = async () => { called = true; return {}; };

    app.openMaster('customer');
    app.submitForm && app.submitMaster();
    await new Promise((r) => setTimeout(r, 20));

    expect(called).toBe(false);
    expect(app.state.master.error).toMatch(/name/i);
  });

  it('refuses a party with no mobile number', async () => {
    const { app } = await mountApp();
    app.openMaster('supplier');
    app.onMasterField('name')({ target: { value: 'Imtiaz Krishi Bhandar' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.master.error).toMatch(/mobile/i);
  });

  it('sends a new supplier and closes on success', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.createMaster = async (kind, body) => {
      sent.push([kind, body]);
      return { id: 9, code: 'SUP-009', ...body };
    };

    app.openMaster('supplier');
    app.onMasterField('name')({ target: { value: 'Imtiaz Krishi Bhandar' } });
    app.onMasterField('mobile')({ target: { value: '01711000111' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('supplier');
    expect(sent[0][1]).toMatchObject({ name: 'Imtiaz Krishi Bhandar', mobile: '01711000111' });
    expect(app.state.master).toBeNull();
    expect(app.state.toast.msg).toContain('SUP-009');
  });

  it('edits through update rather than create', async () => {
    const { app } = await mountApp();
    const calls = [];
    app.repository.createMaster = async () => { calls.push('create'); return {}; };
    app.repository.updateMaster = async (kind, id, body) => {
      calls.push(['update', kind, id]);
      return { id, code: 'CUS-001', ...body };
    };

    const existing = app.data.customers[0];
    app.openMaster('customer', existing);
    app.onMasterField('district')({ target: { value: 'Naogaon' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('update');
    expect(calls[0][1]).toBe('customer');
  });

  it('asks before retiring, and does nothing until confirmed', async () => {
    const { app } = await mountApp();
    let retired = 0;
    app.repository.retireMaster = async () => { retired += 1; return {}; };

    const existing = app.data.suppliers[0];
    app.confirmRetire('supplier', existing);
    expect(retired).toBe(0);

    const modal = app.renderVals().modal;
    expect(modal.title).toMatch(/retire supplier/i);
    // The confirmation is a decision, not a form to fill in.
    expect(modal.fields).toEqual([]);
    expect(modal.submitLabel).toBe('Retire');

    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));
    expect(retired).toBe(1);
    expect(app.state.master).toBeNull();
  });

  it('shows the server refusal in the form rather than losing it', async () => {
    const { app } = await mountApp();
    app.repository.retireMaster = async () => {
      throw new Error('Tk 2,46,700 is still payable to this supplier.');
    };

    app.confirmRetire('supplier', app.data.suppliers[0]);
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));

    // Still open, with the reason attached, so the operator can see why.
    expect(app.state.master).not.toBeNull();
    expect(app.state.master.error).toMatch(/still payable/i);
    expect(app.state.master.busy).toBe(false);
  });

  it('builds the crop list from the repository, with row actions', async () => {
    const { app } = await mountApp();
    app.loadMasterList('crop');
    await new Promise((r) => setTimeout(r, 40));

    const crop = app.renderVals().crop;
    expect(crop.table.rows.length).toBeGreaterThan(0);

    const actions = crop.table.rows[0].cells.slice(-1)[0].actions;
    expect(actions.map((a) => a.label)).toEqual(['Edit', 'Retire']);
    // The retire action reads as the destructive one.
    expect(actions[1].color).not.toBe(actions[0].color);
  });

  it('will not retire a crop that still has stock', async () => {
    const { app } = await mountApp();
    app.loadMasterList('crop');
    await new Promise((r) => setTimeout(r, 40));

    const held = app.state.masterRows.crop.find((c) => c.quantity > 0);
    expect(held).toBeTruthy();

    app.confirmRetire('crop', held);
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));

    expect(app.state.master.error).toMatch(/still in stock/i);
  });

  it('offers districts the data already uses rather than a fixed list', async () => {
    const { app } = await mountApp();
    app.openMaster('customer');
    const districts = app
      .renderVals()
      .modal.fields.find((f) => f.key === 'district')
      .options.map((o) => o.value);

    const known = app.data.customers
      .concat(app.data.suppliers)
      .concat(app.data.companies)
      .map((p) => p.district);
    expect(districts.length).toBeGreaterThan(0);
    districts.forEach((d) => expect(known).toContain(d));
  });
});

describe('derived figures', () => {
  it('states a receivable total that matches the rows above it', async () => {
    const { app } = await mountApp();
    const vals = app.renderVals();
    const kpi = vals.acct.kpis.find((k) => k.k === 'Total receivable').v;
    expect(vals.acct.rec.footTotal).toContain(kpi);
  });

  it('counts the customers it actually lists', async () => {
    const { app } = await mountApp();
    const acct = app.renderVals().acct;
    const listed = acct.rec.rows.length;
    expect(acct.rec.footNote).toBe(
      listed + (listed === 1 ? ' customer' : ' customers') + ' with open balance'
    );
  });

  it('totals the cash accounts it shows rather than repeating a number', async () => {
    const { app } = await mountApp();
    const acct = app.renderVals().acct;
    const kpi = acct.kpis.find((k) => k.k === 'Cash & bank').v;
    expect(acct.cash.footTotal).toContain(kpi);
    expect(acct.cash.footNote).toBe(acct.cash.rows.length + ' accounts');
  });

  it('takes the margin against total revenue, not one business line', async () => {
    const { app } = await mountApp();
    const kpi = app.renderVals().acct.kpis.find((k) => k.k.startsWith('Net profit'));
    // Both lines together, so the margin cannot read several times high.
    expect(kpi.s).toBe('margin 10.3%');
  });
});
