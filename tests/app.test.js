import { describe, it, expect, beforeEach } from 'vitest';
import appTemplate from '../src/templates/app.html?raw';
import dataTableTemplate from '../src/templates/dataTable.html?raw';
import formModalTemplate from '../src/templates/formModal.html?raw';
import { BusinessApp } from '../src/app/logic.js';
import { Repository } from '../src/data/repository.js';
import { money } from '../src/domain/format.js';

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

    // Paid more than the invoice comes to. A blank invoice opens with nothing
    // paid, so the overpayment this is about is stated here rather than
    // inherited from a default.
    const total = app.calcDS().netNum ?? 10_000_000;
    app.setState({ ds: { ...app.state.ds, paid: total + 50000 } });
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

  it('builds the product catalogue with row actions and a low-stock note', async () => {
    const { app } = await mountApp();
    app.loadMasterList('product');
    await new Promise((r) => setTimeout(r, 40));

    const prod = app.renderVals().prod;
    expect(prod.canAdd).toBe(true);
    expect(prod.table.rows.length).toBeGreaterThan(0);
    expect(prod.table.rows[0].cells.slice(-1)[0].actions.map((a) => a.label)).toEqual([
      'Edit',
      'Retire',
    ]);

    // A product under its minimum is called out where the reorder decision is
    // made, rather than only in a report.
    const below = app.data.products.find((p) => p.min && p.stock < p.min);
    expect(below).toBeTruthy();
    expect(prod.table.footNote).toMatch(/below minimum/);
  });

  it('warns when a product would sell below cost', async () => {
    const { app } = await mountApp();
    app.openMaster('product');
    app.onMasterField('name')({ target: { value: 'Amistar Top' } });
    app.onMasterField('pur')({ target: { value: '420' } });
    app.onMasterField('sale')({ target: { value: '380' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.master.error).toMatch(/below the purchase rate/i);
  });

  it('offers the categories and brands that have been set up', async () => {
    const { app } = await mountApp();
    app.openMaster('product');
    const fields = app.renderVals().modal.fields;
    const settings = app.settingsData();

    const cats = fields.find((f) => f.key === 'cat').options.map((o) => o.value);
    const brands = fields.find((f) => f.key === 'brand').options.map((o) => o.value);

    // Blank first: both are optional, and an unclassified catalogue is a real
    // state rather than an error.
    expect(cats[0]).toBe('');
    expect(brands[0]).toBe('');
    expect(cats.slice(1)).toEqual(settings.categories.map((c) => c.name));
    expect(brands.slice(1)).toEqual(settings.brands.map((b) => b.name));
  });

  it('offers a category no product uses yet', async () => {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    const { app } = await mountApp({ repository });
    // This is the case that used to be impossible: the form listed only what
    // other products were filed under, so the first one could never be set.
    const fresh = { id: 99, code: 'BIO', name: 'Biological', products: 0, active: true };
    app.setState({ settings: { ...app.settingsData(), categories: [fresh] } });

    app.openMaster('product');
    const cats = app.renderVals().modal.fields.find((f) => f.key === 'cat').options.map((o) => o.value);

    expect(cats).toEqual(['', 'Biological']);
    expect(app.data.products.some((p) => p.cat === 'Biological')).toBe(false);
  });

  it('leaves a retired category off the form', async () => {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    const { app } = await mountApp({ repository });
    app.setState({
      settings: {
        ...app.settingsData(),
        categories: [
          { id: 1, code: 'A', name: 'Still offered', products: 1, active: true },
          { id: 2, code: 'B', name: 'Retired one', products: 0, active: false },
        ],
      },
    });

    app.openMaster('product');
    const cats = app.renderVals().modal.fields.find((f) => f.key === 'cat').options.map((o) => o.value);
    expect(cats).toEqual(['', 'Still offered']);
  });

  it('maintains categories and brands from the settings screen', async () => {
    const { app } = await mountApp();
    app.setState({ screen: 'settings', setSec: 'classify' });
    const groups = app.renderVals().setClassify;

    expect(groups.map((g) => g.title)).toEqual(['Product categories', 'Brands']);
    expect(groups[0].rows.length).toBe(app.settingsData().categories.length);
    // Each row says what would be left behind if it were retired.
    expect(groups[0].rows[0].d).toContain('product');
    expect(groups[0].addLabel).toBe('Add category');
    expect(groups[1].addLabel).toBe('Add brand');
  });

  it('says so when nothing has been set up yet', async () => {
    const { app } = await mountApp();
    app.setState({
      screen: 'settings', setSec: 'classify',
      settings: { ...app.settingsData(), categories: [], brands: [] },
    });
    const groups = app.renderVals().setClassify;
    expect(groups[0].isEmpty).toBe(true);
    expect(groups[0].emptyNote).toContain('appears on the product form');
  });

  it('sends a new product with the names the server resolves', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.createMaster = async (kind, body) => {
      sent.push([kind, body]);
      return { id: 7, code: 'P-1007', ...body };
    };

    app.openMaster('product');
    app.onMasterField('name')({ target: { value: 'Amistar Top 325 SC 50ml' } });
    app.onMasterField('pur')({ target: { value: '420' } });
    app.onMasterField('sale')({ target: { value: '510' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent[0][0]).toBe('product');
    // Unit code, category and brand names -- not ids the screen has no reason
    // to know.
    expect(sent[0][1]).toMatchObject({ name: 'Amistar Top 325 SC 50ml', pur: 420, sale: 510 });
    expect(typeof sent[0][1].unit).toBe('string');
    expect(app.state.toast.msg).toContain('P-1007');
  });

  it('builds the warehouse screen from what each godown holds', async () => {
    const { app } = await mountApp();
    app.loadMasterList('warehouse');
    await new Promise((r) => setTimeout(r, 40));

    const wh = app.renderVals().wh;
    expect(wh.table.rows.length).toBeGreaterThan(0);
    expect(wh.table.rows[0].cells.slice(-1)[0].actions.map((a) => a.label)).toEqual([
      'Edit',
      'Retire',
    ]);
    expect(wh.table.footNote).toMatch(/warehouses?$/);
  });

  it('renders the employee directory from the repository, not a fixed list', async () => {
    const { app } = await mountApp();
    app.loadMasterList('employee');
    await new Promise((r) => setTimeout(r, 40));

    const team = app.renderVals().team;
    const rows = app.state.masterRows.employee;
    // The footer counts what is actually listed, including its departments.
    const departments = new Set(rows.map((e) => e.department));
    expect(team.table.rows).toHaveLength(rows.length);
    expect(team.table.footNote).toBe(
      rows.length + ' employees · ' + departments.size + ' departments'
    );
  });

  it('offers only departments that exist', async () => {
    const { app } = await mountApp();
    app.loadMasterList('employee');
    await new Promise((r) => setTimeout(r, 40));

    app.openMaster('employee');
    const options = app
      .renderVals()
      .modal.fields.find((f) => f.key === 'department')
      .options.map((o) => o.value);

    const known = app.state.masterRows.employee.map((e) => e.department);
    expect(options.length).toBeGreaterThan(0);
    options.forEach((d) => expect(known).toContain(d));
  });

  it('refuses a joining date in the future', async () => {
    const { app } = await mountApp();
    app.openMaster('employee');
    app.onMasterField('name')({ target: { value: 'Tanvir Ahmed' } });
    app.onMasterField('joined')({ target: { value: '2099-01-01' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.state.master.error).toMatch(/future/i);
  });

  it('sends a warehouse without asking for a mobile number it has no use for', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.createMaster = async (kind, body) => {
      sent.push([kind, body]);
      return { id: 5, code: 'WH-05', ...body };
    };

    app.openMaster('warehouse');
    app.onMasterField('name')({ target: { value: 'Sherpur Transit Store' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent[0][0]).toBe('warehouse');
    expect(sent[0][1]).toMatchObject({ name: 'Sherpur Transit Store' });
    expect(app.state.toast.msg).toContain('WH-05');
  });

  it('lists cash and bank accounts with edit and retire', async () => {
    const { app } = await mountApp();
    app.loadMasterList('account');
    await new Promise((r) => setTimeout(r, 40));

    const acct = app.renderVals().acct;
    expect(acct.addAccount.canAdd).toBe(true);
    expect(acct.cash.rows[0].cells.slice(-1)[0].actions.map((a) => a.label)).toEqual([
      'Edit',
      'Retire',
    ]);
    expect(acct.cash.footNote).toBe(acct.cash.rows.length + ' accounts');
  });

  it('gives expense categories their own tab', async () => {
    const { app } = await mountApp();
    app.loadMasterList('category');
    await new Promise((r) => setTimeout(r, 40));

    const acct = app.renderVals().acct;
    expect(acct.tabs.map((t) => t.l)).toContain('Categories');
    expect(acct.cats.rows.length).toBeGreaterThan(0);
    expect(acct.cats.rows[0].cells.slice(-1)[0].actions).toHaveLength(2);
  });

  it('checks a chosen code before sending it', async () => {
    const { app } = await mountApp();
    let sent = false;
    app.repository.createMaster = async () => { sent = true; return {}; };

    app.openMaster('account');
    app.onMasterField('name')({ target: { value: 'City Bank' } });
    app.onMasterField('code')({ target: { value: 'bank city' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toBe(false);
    expect(app.state.master.error).toMatch(/capitals, digits and dashes/i);
  });

  it('omits an empty code so the server allocates one', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.createMaster = async (kind, body) => {
      sent.push([kind, body]);
      // The server allocates the code, so it comes back on the response.
      return { ...body, id: 8, code: 'EXP-01' };
    };

    app.openMaster('category');
    app.onMasterField('name')({ target: { value: 'Fuel' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent[0][0]).toBe('category');
    expect(sent[0][1].code).toBeUndefined();
    expect(app.state.toast.msg).toContain('EXP-01');
  });

  it('reads permissions from the module that owns each master', async () => {
    // Two kinds do not own a top-level code: expense.category.* and
    // payment.method.*. Checking `category.create` or `method.edit` finds
    // nothing and silently hides every control on those screens.
    const { app } = await mountApp({
      permissions: ['expense.category.create', 'payment.method.edit', 'crop.create'],
    });
    expect(app.mayMaster('category', 'create')).toBe(true);
    expect(app.mayMaster('category', 'delete')).toBe(false);
    expect(app.mayMaster('method', 'edit')).toBe(true);
    expect(app.mayMaster('method', 'create')).toBe(false);
    expect(app.mayMaster('crop', 'create')).toBe(true);
    expect(app.mayMaster('account', 'create')).toBe(false);
  });

  it('shows the payment method controls to a user who holds the codes', async () => {
    const { app } = await mountApp({
      permissions: ['payment.method.create', 'payment.method.edit', 'payment.method.delete'],
    });
    app.loadMasterList('method');
    await new Promise((r) => setTimeout(r, 40));

    const vals = app.renderVals();
    expect(vals.addMethod.canAdd).toBe(true);
    expect(vals.setPay[0].canEdit).toBe(true);
    expect(vals.setPay[0].canToggle).toBe(true);
  });

  it('renders payment methods from data, with a switch that does something', async () => {
    const { app } = await mountApp();
    app.loadMasterList('method');
    await new Promise((r) => setTimeout(r, 40));

    const vals = app.renderVals();
    expect(vals.addMethod.canAdd).toBe(true);
    expect(vals.setPay.length).toBeGreaterThan(0);
    // The switch used to be a picture; every row now carries a handler.
    vals.setPay.forEach((p) => expect(typeof p.onToggle).toBe('function'));
  });

  it('retires an active method through the confirmation, and restores a retired one directly', async () => {
    const { app } = await mountApp();
    const calls = [];
    app.repository.retireMaster = async (kind, id) => { calls.push(['retire', kind, id]); return {}; };
    app.repository.restoreMaster = async (kind, id) => { calls.push(['restore', kind, id]); return {}; };

    app.loadMasterList('method');
    await new Promise((r) => setTimeout(r, 40));

    const rows = app.state.masterRows.method;
    const active = rows.findIndex((m) => m.active !== false);
    const retired = rows.findIndex((m) => m.active === false);
    expect(active).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(-1);

    // Retiring asks first...
    app.renderVals().setPay[active].onToggle();
    expect(calls).toHaveLength(0);
    expect(app.state.master.confirm).toBe(true);
    app.closeMaster();

    // ...restoring does not, since it puts something back.
    app.renderVals().setPay[retired].onToggle();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.map((c) => c[0])).toEqual(['restore']);
  });

  it('lets a payment method be created without an account', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.createMaster = async (kind, body) => {
      sent.push([kind, body]);
      return { ...body, id: 7, code: 'PM-01' };
    };

    app.openMaster('method');
    app.onMasterField('name')({ target: { value: 'Upay' } });
    app.submitMaster();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent[0][0]).toBe('method');
    // The column is nullable, so an unsettled account is not a blocker.
    expect(sent[0][1]).toMatchObject({ name: 'Upay', account: '' });
    expect(app.state.toast.msg).toContain('PM-01');
  });

  it('suggests districts the data already uses rather than restricting to them', async () => {
    const { app } = await mountApp();
    app.openMaster('customer');
    const district = app.renderVals().modal.fields.find((f) => f.key === 'district');

    // Typed, not chosen: a district nobody has entered yet could never be
    // picked from a list built out of the ones people have entered.
    expect(district.isSelect).toBe(false);
    expect(district.isText).toBe(true);

    const suggested = district.suggestions.map((o) => o.value);
    const known = app.data.customers
      .concat(app.data.suppliers)
      .concat(app.data.companies)
      .map((p) => p.district);
    expect(suggested.length).toBeGreaterThan(0);
    suggested.forEach((d) => expect(known).toContain(d));
  });

  it('still lets a district be entered when no party has one yet', async () => {
    const { app } = await mountApp();
    app.data.customers = [];
    app.data.suppliers = [];
    app.data.companies = [];

    app.openMaster('warehouse');
    const district = app.renderVals().modal.fields.find((f) => f.key === 'district');

    expect(district.isText).toBe(true);
    expect(district.hasSuggestions).toBe(false);
    expect(district.placeholder).toBeTruthy();
  });
});

describe('derived figures', () => {
  it('states a receivable total that matches the rows above it', async () => {
    const { app } = await mountApp();
    const vals = app.renderVals();
    const kpi = vals.acct.kpis.find((k) => k.k === 'Total receivable').v;
    expect(vals.acct.rec.footTotal).toContain(kpi);
  });

  it('counts the parties it actually lists', async () => {
    const { app } = await mountApp();
    const acct = app.renderVals().acct;
    const listed = acct.rec.rows.length;
    expect(acct.rec.footNote).toBe(
      listed + (listed === 1 ? ' party' : ' parties') + ' with open balance'
    );
  });

  it('counts money owed by buyer companies as receivable, not only customers', async () => {
    const { app } = await mountApp();
    // Crop sales go to buyer companies rather than customers, so a receivable
    // built from customers alone reads zero while the money is genuinely owed.
    const owed = app.data.companies.filter((c) => c.bal < 0);
    expect(owed.length).toBeGreaterThan(0);

    const acct = app.renderVals().acct;
    const expected = owed.reduce((t, c) => t - c.bal, 0)
      + app.data.customers.filter((c) => c.out > 0).reduce((t, c) => t + c.out, 0);

    expect(acct.rec.rows).toHaveLength(
      app.data.customers.filter((c) => c.out > 0).length + owed.length
    );
    expect(acct.rec.footTotal).toContain(money(expected));
    expect(acct.kpis.find((k) => k.k === 'Total receivable').v).toBe(money(expected));
  });

  it('totals the cash accounts it shows rather than repeating a number', async () => {
    const { app } = await mountApp();
    const acct = app.renderVals().acct;
    const kpi = acct.kpis.find((k) => k.k === 'Cash & bank').v;
    expect(acct.cash.footTotal).toContain(kpi);
    expect(acct.cash.footNote).toBe(acct.cash.rows.length + ' accounts');
  });

  it('states an inventory value that matches the stock it lists', async () => {
    const { app } = await mountApp();
    app.setState({ screen: 'inventory' });
    const inv = app.renderVals().inv;

    // Every line on the all-stock tab, valued the way the table values it.
    const listed = inv.table.rows.length;
    expect(listed).toBeGreaterThan(0);

    const crops = app.state.batches.reduce((t, b) => t + b.rem * b.cost, 0);
    const goods = app.data.products.reduce((t, p) => t + p.stock * p.pur, 0);
    expect(inv.kpis.find((k) => k.k === 'Total stock value').v).toBe(money(crops + goods));
    expect(inv.kpis.find((k) => k.k === 'Bulk crop stock').s).toBe(money(crops));
    expect(inv.kpis.find((k) => k.k === 'Dealer product stock').s).toBe(money(goods));
  });

  it('counts the warehouses the stock is actually in', async () => {
    const { app } = await mountApp();
    app.setState({ screen: 'inventory' });
    const held = new Set(app.state.batches.map((b) => b.wh)).size;
    expect(app.renderVals().inv.kpis[0].s).toBe('across ' + held + ' warehouses');
  });

  it('totals the expense vouchers it shows', async () => {
    const { app } = await mountApp();
    app.loadExpenses();
    await new Promise((r) => setTimeout(r, 40));

    const acct = app.renderVals().acct;
    const rows = app.state.expenses.rows;
    expect(acct.exp.rows).toHaveLength(rows.length);
    expect(acct.exp.footNote).toBe(rows.length + ' vouchers');
    expect(acct.exp.footTotal).toBe(
      'Total ' + money(rows.reduce((t, r) => t + r.amount, 0))
    );
  });

  it('takes the margin against total revenue, not one business line', async () => {
    const { app } = await mountApp();
    app.go('accounts')();
    await new Promise((r) => setTimeout(r, 30));
    const kpi = app.renderVals().acct.kpis.find((k) => k.k.startsWith('Net profit'));
    // Both lines together, so the margin cannot read several times high.
    expect(kpi.s).toBe('margin 10.3%');
  });
});

describe('settings', () => {
  /** Open Settings on one panel, with the configuration loaded. */
  async function openSettings(section, props = {}) {
    const { app, root } = await mountApp(props);
    app.setState({ screen: 'settings', setSec: section });
    app.loadSettings();
    await new Promise((r) => setTimeout(r, 20));
    flush(app);
    return { app, root };
  }

  it('reads the company profile from the organisation record', async () => {
    const { app } = await openSettings('company');
    const vals = app.renderVals();
    const org = app.settingsData().organization;

    // Not one field restated in the screen: every row names the record it came
    // from, so changing the record changes the panel.
    expect(vals.setCompany.find((f) => f.k === 'Company name').v).toBe(org.name);
    expect(vals.setCompany.find((f) => f.k === 'Trade licence no').v).toBe(org.tradeLicenceNo);
    expect(vals.setCompany.find((f) => f.k === 'BIN / VAT registration').v).toBe(org.binNo);
  });

  it('saves an edited company profile through the repository', async () => {
    const { app } = await openSettings('company');
    app.openSettings('company', app.settingsData().organization);
    app.onSettingsField('headOffice')({ target: { value: 'Station Road, Bogura' } });
    app.submitSettings();
    await new Promise((r) => setTimeout(r, 30));

    expect(app.state.settingsForm).toBeNull();
    expect(app.settingsData().organization.headOffice).toBe('Station Road, Bogura');
  });

  it('refuses a currency that is not a three-letter code', async () => {
    const { app } = await openSettings('company');
    app.openSettings('company', app.settingsData().organization);
    app.onSettingsField('currency')({ target: { value: 'TAKA' } });
    app.submitSettings();

    expect(app.state.settingsForm.error).toBe('The currency is a three-letter code, like BDT.');
  });

  it('suggests the districts the business already deals in', async () => {
    const { app } = await openSettings('company');
    app.openSettings('company', app.settingsData().organization);
    const field = app.settingsModal().fields.find((f) => f.key === 'defaultDistrict');

    expect(field.isText).toBe(true);
    const known = new Set(
      app.data.customers.concat(app.data.suppliers, app.data.companies).map((p) => p.district)
    );
    const suggested = field.suggestions.map((o) => o.value);
    expect(suggested.length).toBeGreaterThan(0);
    for (const d of suggested) expect(known.has(d)).toBe(true);
  });

  it('lists the financial years on file and what can be done to each', async () => {
    const { app } = await openSettings('fy');
    const years = app.renderVals().setFy;
    const current = years.find((y) => y.tag === 'Current');

    expect(years).toHaveLength(app.settingsData().fiscalYears.length);
    // The year being traded in cannot be closed out from under the business.
    expect(current.canClose).toBe(false);
    expect(years.filter((y) => y.tag === 'Closed').every((y) => y.canReopen)).toBe(true);
  });

  it('refuses to close the current financial year', async () => {
    const { app } = await openSettings('fy');
    const current = app.settingsData().fiscalYears.find((y) => y.current);
    app.changeFiscalYear(current, { closed: true }, 'closed');
    await new Promise((r) => setTimeout(r, 30));

    expect(app.state.toast.tone).toBe('danger');
    expect(app.state.toast.msg).toContain('current financial year');
  });

  it('proposes the next financial year from the latest one on file', async () => {
    const { app } = await openSettings('fy');
    const proposed = app.nextFiscalYear();
    const latest = app
      .settingsData()
      .fiscalYears.map((y) => y.endsOn)
      .sort()
      .slice(-1)[0];

    // The day after the last year ended, not a date typed into the code.
    const next = new Date(new Date(latest).getTime() + 86400000);
    const expected = [
      String(next.getMonth() + 1).padStart(2, '0'),
      String(next.getDate()).padStart(2, '0'),
    ].join('-');
    expect(proposed.nextStart.slice(5)).toBe(expected);
  });

  it('builds each numbering pattern from the prefix and width in force', async () => {
    const { app } = await openSettings('numbering');
    const rows = app.renderVals().setNum;
    const configured = app.settingsData().numbering;

    expect(rows).toHaveLength(configured.length);
    for (const [i, row] of rows.entries()) {
      expect(row.v).toBe(configured[i].prefix + '-YYMM-' + '#'.repeat(configured[i].padding));
    }
  });

  it('refuses a numbering prefix that is not a short code', async () => {
    const { app } = await openSettings('numbering');
    app.openSettings('numbering', app.settingsData().numbering[0]);
    app.onSettingsField('prefix')({ target: { value: 'crop purchase' } });
    app.submitSettings();

    expect(app.state.settingsForm.error).toContain('1 to 6 capitals');
  });

  it('derives unit conversions rather than printing them', async () => {
    const { app } = await openSettings('units');
    const rows = app.renderVals().setUnits;
    const units = app.settingsData().units;

    expect(rows).toHaveLength(units.length);
    // A unit with a base states the conversion; a base states that it is one.
    expect(rows[units.findIndex((u) => u.code === 'Kg')].v).toBe('1 MT = 1,000 Kg');
    expect(rows[units.findIndex((u) => u.code === 'MT')].v).toBe('MT · base unit');
  });

  it('labels each approval limit from the rule rather than a stored sentence', async () => {
    const { app } = await openSettings('limits');
    const rows = app.renderVals().setLimits;
    const rules = app.settingsData().approvalRules;

    const purchase = rules.findIndex((r) => r.entityType === 'crop_purchases');
    expect(rows[purchase].k).toBe('Crop purchase requiring approval above');
    expect(rows[purchase].v).toBe(money(rules[purchase].threshold));

    // A rule with nothing to compare against has no limit to edit.
    const always = rules.findIndex((r) => r.condition === 'ALWAYS');
    expect(rows[always].v).toBe('always');
    expect(rows[always].canEdit).toBe(false);
  });

  it('moves an approval limit and shows the new figure', async () => {
    const { app } = await openSettings('limits');
    const rule = app.settingsData().approvalRules.find((r) => r.condition === 'AMOUNT_ABOVE');
    app.openSettings('limit', rule);
    app.onSettingsField('threshold')({ target: { value: '750000' } });
    app.submitSettings();
    await new Promise((r) => setTimeout(r, 30));

    const row = app.renderVals().setLimits.find((l) => l.k.startsWith(rule.entityLabel));
    expect(row.v).toBe(money(750000));
  });

  it('reads each notification rule with its own threshold in place', async () => {
    const { app } = await openSettings('notif');
    const rows = app.renderVals().setNotif;
    const rules = app.settingsData().notificationRules;

    const large = rules.findIndex((r) => r.code === 'LARGE_TRANSACTION');
    expect(rows[large].d).toBe('any single transaction above ' + money(rules[large].threshold));
    // A rule with no threshold reads as its own condition.
    const overdue = rules.findIndex((r) => r.code === 'CUSTOMER_OVERDUE');
    expect(rows[overdue].d).toBe(rules[overdue].description);
    expect(rows[overdue].canEdit).toBe(false);
  });

  it('switches a notification rule off', async () => {
    const { app } = await openSettings('notif');
    const rule = app.settingsData().notificationRules[0];
    app.toggleNotification(rule);
    await new Promise((r) => setTimeout(r, 30));

    expect(app.settingsData().notificationRules[0].active).toBe(false);
    expect(app.renderVals().setNotif[0].tag).toBe('Off');
  });

  it('draws the permission matrix from the grants, one column per role', async () => {
    const { app } = await openSettings('roles');
    const matrix = app.renderVals().matrix;
    const permissions = app.settingsData().permissions;

    expect(matrix.cols).toEqual(['Module'].concat(permissions.roles));
    expect(matrix.rows).toHaveLength(permissions.modules.length);
    // Every cell is a level the payload actually reported for that role.
    for (const [i, row] of matrix.rows.entries()) {
      expect(row.cells[0].t).toBe(permissions.modules[i].label);
      permissions.roles.forEach((role, r) => {
        expect(row.cells[r + 1].t).toBe(permissions.modules[i].levels[role]);
      });
    }
  });

  it('saves the valuation method rather than only colouring a button', async () => {
    const { app } = await openSettings('valuation');
    expect(app.renderVals().valTabs[0].on).toBe(true);

    app.setValuation('Weighted Average');
    await new Promise((r) => setTimeout(r, 30));

    expect(app.settingsData().organization.valuation).toBe('WEIGHTED_AVERAGE');
    expect(app.renderVals().valTabs[1].on).toBe(true);
  });

  it('hides every control from a user who may not change settings', async () => {
    const { app } = await openSettings('company', { permissions: ['settings.view'] });
    const vals = app.renderVals();

    expect(vals.companyEdit.canEdit).toBe(false);
    expect(vals.addFy.canAdd).toBe(false);
    expect(vals.setNum.every((n) => !n.canEdit)).toBe(true);
    expect(vals.setLimits.every((l) => !l.canEdit)).toBe(true);
    expect(vals.setNotif.every((n) => !n.canToggle)).toBe(true);
  });
});

describe('roles and permissions', () => {
  /** Open the roles panel with the roles and logins loaded. */
  async function openRoles(props = {}) {
    const { app, root } = await mountApp(props);
    app.setState({ screen: 'settings', setSec: 'roles' });
    app.loadSettings();
    app.loadAccessControl();
    await new Promise((r) => setTimeout(r, 20));
    flush(app);
    return { app, root };
  }

  const moduleRow = (app, label) =>
    app.renderVals().matrix.rows.find((r) => r.cells[0].t === label);

  it('builds the matrix from the grants each role holds', async () => {
    const { app } = await openRoles();
    const vals = app.renderVals();

    expect(vals.matrix.cols[0]).toBe('Module');
    expect(vals.matrix.cols).toContain('Admin');

    const admin = vals.matrix.cols.indexOf('Admin');
    const sales = vals.matrix.cols.indexOf('Sales');
    // Admin holds all of settings; Sales holds none of it, and not seeing
    // profit is a state with a name rather than a blank.
    expect(moduleRow(app, 'Settings').cells[admin].t).toBe('Full');
    expect(moduleRow(app, 'Settings').cells[sales].t).toBe('—');
    expect(moduleRow(app, 'Profit figures').cells[sales].t).toBe('Hidden');
  });

  it('lists the roles with what they are for and who holds them', async () => {
    const { app } = await openRoles();
    const rows = app.renderVals().roleRows;

    const admin = rows.find((r) => r.k === 'Admin');
    expect(admin.d).toContain('permissions');
    expect(admin.tag).toBe('1 user');
    // The roles the system is set up around cannot be deleted, held or not.
    expect(admin.canRemove).toBe(false);
  });

  it('moves a grant from the cell it is shown in', async () => {
    const { app } = await openRoles();
    const sales = app.renderVals().matrix.cols.indexOf('Sales');

    expect(moduleRow(app, 'Expenses').cells[sales].t).toBe('—');
    moduleRow(app, 'Expenses').cells[sales].onClick();
    expect(app.state.settingsForm.kind).toBe('grants');
    expect(app.state.settingsForm.row.roleName).toBe('Sales');

    // The switches are the module's permissions; grant both.
    app.onSettingsToggle('granted', 'expense.view');
    app.onSettingsToggle('granted', 'expense.create');
    app.submitSettings();
    await new Promise((r) => setTimeout(r, 30));
    flush(app);

    expect(app.state.settingsForm).toBeNull();
    expect(moduleRow(app, 'Expenses').cells[sales].t).toBe('Full');
  });

  it('adds a role and offers it as a column of its own', async () => {
    const { app } = await openRoles();
    app.openSettings('role', {});
    app.onSettingsField('name')({ target: { value: 'Branch manager' } });
    app.onSettingsField('code')({ target: { value: 'BranchManager' } });
    app.submitSettings();
    await new Promise((r) => setTimeout(r, 30));
    flush(app);

    expect(app.renderVals().matrix.cols).toContain('BranchManager');
    const added = app.renderVals().roleRows.find((r) => r.k === 'Branch manager');
    expect(added.tag).toBe('0 users');
    // Nobody holds it, so it can go again.
    expect(added.canRemove).toBe(true);
  });

  it('names the role before it will save one', async () => {
    const { app } = await openRoles();
    app.openSettings('role', {});
    app.submitSettings();

    expect(app.state.settingsForm.error).toBe('Give the role a name.');
  });

  it('refuses a change that would leave nobody able to change roles back', async () => {
    const { app } = await openRoles();
    const admin = app.permissionData().roleList.find((r) => r.code === 'Admin');

    app.openSettings('grants', {
      roleId: admin.id,
      roleName: admin.name,
      moduleLabel: 'Roles and logins',
      permissions: [
        { code: 'user.manage', label: 'Logins' },
        { code: 'role.edit', label: 'Roles' },
      ],
      granted: ['user.manage', 'role.edit'],
    });
    app.onSettingsToggle('granted', 'role.edit');
    app.submitSettings();
    await new Promise((r) => setTimeout(r, 30));

    expect(app.state.settingsForm.error).toContain('no active user able to change roles');
    // And the refusal left nothing half-applied.
    expect(app.permissionData().roleList.find((r) => r.code === 'Admin').granted)
      .toContain('role.edit');
  });

  it('hides every control from a user who may not cut the roles', async () => {
    const { app } = await openRoles({
      // Enough to read the screen, not to change it.
      permissions: ['dashboard.view', 'settings.view', 'employee.view'],
    });
    const vals = app.renderVals();

    expect(vals.addRole.canAdd).toBe(false);
    expect(vals.roleRows.every((r) => !r.canEdit && !r.canRemove)).toBe(true);
    // The cells are text rather than buttons.
    expect(moduleRow(app, 'Settings').cells[1].onClick).toBeNull();
    expect(vals.rolesNote).toContain('the rule rather than a description');
  });
});

describe('logins', () => {
  async function openEmployees(props = {}) {
    const { app, root } = await mountApp(props);
    app.setState({ screen: 'employees' });
    app.loadAccessControl();
    await new Promise((r) => setTimeout(r, 20));
    flush(app);
    return { app, root };
  }

  const rowFor = (app, code) =>
    app.employees().table.rows.find((r) => r.cells[0].text === code);

  it('shows the roles a person actually signs in with', async () => {
    const { app } = await openEmployees();
    expect(rowFor(app, 'EMP-01').cells[5].text).toBe('Admin');
  });

  it('offers the login controls to whoever may maintain logins', async () => {
    const { app } = await openEmployees();
    const actions = rowFor(app, 'EMP-04').cells[7].actions.map((a) => a.label);

    expect(actions).toContain('Change role');
    expect(actions).toContain('Reset password');
    expect(actions).toContain('Disable login');
  });

  it('withholds them from someone who may only read the directory', async () => {
    const { app } = await openEmployees({ permissions: ['dashboard.view', 'employee.view'] });
    const actions = rowFor(app, 'EMP-04').cells[7].actions.map((a) => a.label);

    expect(actions).not.toContain('Change role');
    expect(actions).not.toContain('Reset password');
    expect(app.employees().login.canAdd).toBe(false);
  });

  it('changes the roles on a login', async () => {
    const { app } = await openEmployees();
    const account = app.accountsData().find((a) => a.employeeCode === 'EMP-09');

    app.openSettings('roleAssign', {
      ...account,
      roleOptions: app.permissionData().roleList,
    });
    app.onSettingsToggle('roles', 'Sales');
    app.onSettingsToggle('roles', 'Warehouse');
    app.submitSettings();
    await new Promise((r) => setTimeout(r, 30));
    flush(app);

    expect(app.state.settingsForm).toBeNull();
    expect(rowFor(app, 'EMP-09').cells[5].text).toBe('Warehouse');
  });

  it('will not leave a login with no role at all', async () => {
    const { app } = await openEmployees();
    const account = app.accountsData().find((a) => a.employeeCode === 'EMP-09');

    app.openSettings('roleAssign', { ...account, roleOptions: app.permissionData().roleList });
    app.onSettingsToggle('roles', account.roles[0]);
    app.submitSettings();

    expect(app.state.settingsForm.error).toContain('at least one role');
  });
});

describe('permission-driven navigation', () => {
  /** The sidebar labels this set of permissions reaches. */
  async function navFor(permissions) {
    const { root } = await mountApp({ permissions });
    return [...root.querySelectorAll('aside nav button')].map((b) => b.textContent.trim());
  }

  it('offers a screen when the permission behind it is held', async () => {
    const labels = await navFor(['dashboard.view', 'dealer.sale.view', 'customer.view']);

    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Dealer Sales');
    expect(labels).toContain('Customers');
    expect(labels).not.toContain('Settings');
    expect(labels).not.toContain('Crop Purchase');
  });

  it('offers a screen the moment its permission is granted, whatever the role', async () => {
    // A role the business cut itself: no name a hard-coded list could have
    // anticipated, and the sidebar still follows what it holds.
    const labels = await navFor(['dashboard.view', 'audit.view', 'settings.view']);

    expect(labels).toContain('Audit Trail');
    expect(labels).toContain('Settings');
    expect(labels).not.toContain('Dealer Sales');
  });

  it('shows profit only to a session holding report.profit', async () => {
    const { app: withIt } = await mountApp({ permissions: ['dashboard.view', 'report.profit'] });
    const { app: without } = await mountApp({ permissions: ['dashboard.view'] });

    expect(withIt.canProfit()).toBe(true);
    expect(without.canProfit()).toBe(false);
  });
});

describe('audit trail', () => {
  async function openAudit() {
    const { app } = await mountApp();
    app.setState({ screen: 'audit' });
    app.loadAudit();
    await new Promise((r) => setTimeout(r, 30));
    return app;
  }

  it('lists one row per field that changed, from the recorded entries', async () => {
    const app = await openAudit();
    const table = app.renderVals().audit;
    const entries = app.state.auditRows;
    expect(entries.length).toBeGreaterThan(0);

    const expected = entries.reduce(
      (t, e) => t + Math.max(1, Object.keys(e.newValue || e.oldValue || {}).length),
      0
    );
    expect(table.rows).toHaveLength(expected);
    expect(table.footNote).toContain(entries.length + ' entries');
  });

  it('names the document a change was made to', async () => {
    const app = await openAudit();
    // The summary names the document; the table shows that rather than a table
    // name and a row id.
    const records = app.renderVals().audit.rows.map((r) => r.cells[3].text);
    expect(records).toContain('PC-2608-014');
  });

  it('says nothing has been recorded rather than showing a fixture', async () => {
    const { app } = await mountApp();
    app.setState({ screen: 'audit', auditRows: [] });

    const table = app.renderVals().audit;
    expect(table.rows).toHaveLength(0);
    expect(table.emptyTitle).toBe('Nothing recorded yet');
  });
});

describe('the account menu', () => {
  /** A repository that records what the account actions asked it to do. */
  function withAccount(overrides = {}) {
    const calls = [];
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    // `report` is how the app tells a real backend from the bundled data.
    repository.report = async () => ({ rows: [] });
    repository.changePassword = async (current, next) => {
      calls.push(['changePassword', current, next]);
      return { changed: true };
    };
    Object.assign(repository, overrides);
    return { repository, calls };
  }

  it('offers signing out and changing a password against a server', async () => {
    const { repository } = withAccount();
    const { app } = await mountApp({ repository });
    expect(app.renderVals().account.canManage).toBe(true);
  });

  it('offers neither when there is no server to sign out of', async () => {
    const { app } = await mountApp();
    expect(app.renderVals().account.canManage).toBe(false);
  });

  it('hands the sign-out back to whatever started the app', async () => {
    let signedOut = 0;
    const { repository } = withAccount();
    const { app } = await mountApp({ repository, onSignOut: () => { signedOut += 1; } });

    app.setState({ userOpen: true });
    app.renderVals().account.onSignOut();

    expect(signedOut).toBe(1);
    // The menu closes with it, rather than hanging over the sign-in card.
    expect(app.state.userOpen).toBe(false);
  });

  it('sends a changed password through the repository', async () => {
    const { repository, calls } = withAccount();
    const { app } = await mountApp({ repository });

    app.openPassword();
    app.onPasswordField('current')({ target: { value: 'OneTimeKey!7' } });
    app.onPasswordField('next')({ target: { value: 'a-longer-secret' } });
    app.onPasswordField('repeat')({ target: { value: 'a-longer-secret' } });
    app.submitPassword();
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toEqual([['changePassword', 'OneTimeKey!7', 'a-longer-secret']]);
    expect(app.state.password).toBeNull();
    expect(app.state.toast.msg).toBe('Password changed');
  });

  it('refuses a new password that is too short, mistyped, or unchanged', async () => {
    const { repository, calls } = withAccount();
    const { app } = await mountApp({ repository });

    const attempt = (current, next, repeat) => {
      app.openPassword();
      app.onPasswordField('current')({ target: { value: current } });
      app.onPasswordField('next')({ target: { value: next } });
      app.onPasswordField('repeat')({ target: { value: repeat } });
      app.submitPassword();
      return app.state.password.error;
    };

    expect(attempt('', 'a-longer-secret', 'a-longer-secret')).toContain('current password');
    expect(attempt('now', 'short', 'short')).toContain('at least 10');
    expect(attempt('now', 'a-longer-secret', 'a-longer-secre')).toContain('do not match');
    expect(attempt('a-longer-secret', 'a-longer-secret', 'a-longer-secret')).toContain('same as');

    // Nothing reached the server while the form was wrong.
    expect(calls).toHaveLength(0);
  });

  it('reports a refusal from the server in the form', async () => {
    const { repository } = withAccount({
      changePassword: async () => { throw new Error('Your current password is not correct.'); },
    });
    const { app } = await mountApp({ repository });

    app.openPassword();
    app.onPasswordField('current')({ target: { value: 'wrong-one' } });
    app.onPasswordField('next')({ target: { value: 'a-longer-secret' } });
    app.onPasswordField('repeat')({ target: { value: 'a-longer-secret' } });
    app.submitPassword();
    await new Promise((r) => setTimeout(r, 20));

    expect(app.state.password.error).toBe('Your current password is not correct.');
    expect(app.state.password.busy).toBe(false);
  });

  it('masks all three password fields', async () => {
    const { repository } = withAccount();
    const { app } = await mountApp({ repository });
    app.openPassword();
    for (const f of app.renderVals().modal.fields) expect(f.inputType).toBe('password');
  });
});

describe('the account menu in the DOM', () => {
  it('draws Sign out and Change password when the menu is open', async () => {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    const { app, root } = await mountApp({ repository });

    expect(root.textContent).not.toContain('Sign out');

    app.setState({ userOpen: true });
    flush(app);

    expect(root.textContent).toContain('Sign out');
    expect(root.textContent).toContain('Change password');
  });

  it('draws neither without a server behind the app', async () => {
    const { app, root } = await mountApp();
    app.setState({ userOpen: true });
    flush(app);

    expect(root.textContent).not.toContain('Sign out');
    expect(root.textContent).not.toContain('Change password');
  });

  it('signs out when the button is clicked', async () => {
    let signedOut = 0;
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    const { app, root } = await mountApp({ repository, onSignOut: () => { signedOut += 1; } });

    app.setState({ userOpen: true });
    flush(app);

    const button = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sign out');
    expect(button).toBeTruthy();
    button.click();

    expect(signedOut).toBe(1);
  });
});

describe('classification lists against a server', () => {
  /** The app as it is a moment after loading, before settings have arrived. */
  async function beforeSettingsArrive() {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    // Never resolves: this is the window the product form used to fill with
    // the bundled demo categories.
    repository.settings = () => new Promise(() => {});
    return mountApp({ repository });
  }

  it('offers no category at all rather than four the server never heard of', async () => {
    const { app } = await beforeSettingsArrive();
    // A catalogue with nothing in it, which is where this business starts.
    app.data.products = [];

    app.openMaster('product');
    const options = app.renderVals().modal.fields
      .find((f) => f.key === 'cat')
      .options.map((o) => o.value);

    // Blank only. Picking a bundled name here would be refused on save.
    expect(options).toEqual(['']);
  });

  it('still offers the bundled lists with no backend behind the app', async () => {
    const { app } = await mountApp();
    app.openMaster('product');
    const options = app.renderVals().modal.fields
      .find((f) => f.key === 'cat')
      .options.map((o) => o.value);

    expect(options.length).toBeGreaterThan(1);
  });

  it('fetches the lists when the products screen is opened', async () => {
    const asked = [];
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    repository.settings = async () => { asked.push('settings'); return { categories: [], brands: [] }; };
    const { app } = await mountApp({ repository });

    asked.length = 0;
    app.go('products')();
    await new Promise((r) => setTimeout(r, 20));

    // Opening Products must not depend on Settings having been visited first.
    expect(asked).toContain('settings');
  });
});

describe('invoices', () => {
  /** One posted invoice, in the shape the API returns it. */
  const INVOICE = {
    id: 7,
    no: 'DS-2608-221',
    date: '28 Aug 2026',
    status: 'POSTED',
    terms: 'Credit 15 days',
    dueDate: '12 Sep 2026',
    warehouse: 'Bogura Depot',
    salesperson: 'Shamim Reza',
    customer: {
      code: 'CUS-003', name: 'Nabin Krishi Bitan', bn: 'নবীন কৃষি বিতান',
      mobile: '01911-450288', address: 'Mohadevpur, Naogaon', creditDays: 21,
    },
    org: {
      name: 'Imtiaz Tredars', tradeLicenceNo: 'BOG-TL-2019-04471', binNo: '003912847-0201',
      headOffice: 'Sherpur Road, Bogura', mobile: '01711-330099',
      email: 'accounts@example.com', currency: 'BDT',
    },
    lines: [
      { lineNo: 1, code: 'P-1001', name: 'Ridomil Gold', brand: 'Syngenta', unit: 'Pcs',
        quantity: 120, bonus: 4, rate: 295, discountPct: 2, amount: 34692 },
    ],
    totals: { gross: 35400, discount: 708, net: 34692, paid: 10000, due: 24692 },
  };

  function withInvoices(rows = [], detail = INVOICE) {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    repository.invoices = async () => ({ rows, meta: { total: rows.length } });
    repository.invoice = async () => detail;
    return repository;
  }

  const ROW = {
    id: 7, no: 'DS-2608-221', date: '2026-08-28', customer: 'Nabin Krishi Bitan',
    items: 2, amount: 34692, paid: 10000, due: 24692, status: 'POSTED',
  };

  it('lists the invoices raised, newest first as the server sent them', async () => {
    const { app } = await mountApp({ repository: withInvoices([ROW]) });
    app.go('dealer-sales')();
    await new Promise((r) => setTimeout(r, 20));

    const table = app.renderVals().invoices;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].cells[0].text).toBe('DS-2608-221');
    expect(table.rows[0].cells[4].text).toBe(money(34692));
    expect(table.footTotal).toBe('Outstanding ' + money(24692));
  });

  it('says nothing has been raised rather than showing an empty grid', async () => {
    const { app } = await mountApp({ repository: withInvoices([]) });
    app.go('dealer-sales')();
    await new Promise((r) => setTimeout(r, 20));

    const table = app.renderVals().invoices;
    expect(table.rows).toHaveLength(0);
    expect(table.emptyTitle).toBe('No invoices yet');
  });

  it('opens the document when Print is used on a row', async () => {
    const opened = [];
    const { app } = await mountApp({ repository: withInvoices([ROW]) });
    app.go('dealer-sales')();
    await new Promise((r) => setTimeout(r, 20));

    const written = [];
    const fakeWindow = {
      document: { write: (html) => written.push(html), close: () => {} },
    };
    const original = window.open;
    // @ts-ignore -- standing in for the browser's own window
    window.open = (...args) => { opened.push(args); return fakeWindow; };

    app.renderVals().invoices.rows[0].cells[8].actions[0].onClick();
    await new Promise((r) => setTimeout(r, 20));
    window.open = original;

    expect(opened).toHaveLength(1);
    expect(written[0]).toContain('DS-2608-221');
    expect(app.state.toast.msg).toContain('opened for printing');
  });

  it('says so when the browser blocks the window rather than failing silently', async () => {
    const { app } = await mountApp({ repository: withInvoices([ROW]) });
    app.go('dealer-sales')();
    await new Promise((r) => setTimeout(r, 20));

    const original = window.open;
    // @ts-ignore -- a blocked pop-up returns null
    window.open = () => null;
    app.renderVals().invoices.rows[0].cells[8].actions[0].onClick();
    await new Promise((r) => setTimeout(r, 20));
    window.open = original;

    expect(app.state.toast.msg).toContain('pop-ups');
    expect(app.state.toast.tone).toBe('warn');
  });
});

describe('the date a document is posted with', () => {
  it('is the one chosen on the form, not the day the design was drawn', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.postDealerSale = async (payload) => {
      sent.push(payload.intent.date);
      return { txnNo: 'DS-9999-010', status: 'POSTED' };
    };

    app.setState({ ds: { ...app.state.ds, date: '2026-09-14' } });
    app.calcDS().onPost();
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual(['2026-09-14']);
  });

  it('carries the chosen date through a dealer purchase too', async () => {
    const { app } = await mountApp();
    const sent = [];
    app.repository.postDealerPurchase = async (payload) => {
      sent.push(payload.intent.date);
      return { txnNo: 'DP-9999-010', status: 'POSTED' };
    };

    app.setState({ dp: { ...app.state.dp, date: '2026-09-02' } });
    app.calcDP().onPost();
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual(['2026-09-02']);
  });
});

describe('where stock actually is', () => {
  /** Two warehouses holding the same product, as the stock table reports it. */
  const STOCK = [
    { kind: 'dealer', name: 'Ridomil Gold', sub: 'Syngenta · Agrochemical', warehouse: 'Main Godown',
      qty: 40, unit: 'Pcs', cost: 240, value: 9600, age: null, date: null, flagged: false },
    { kind: 'dealer', name: 'Ridomil Gold', sub: 'Syngenta · Agrochemical', warehouse: 'Sherpur Store',
      qty: 10, unit: 'Pcs', cost: 240, value: 2400, age: null, date: null, flagged: true },
    { kind: 'crop', name: 'Maize', sub: 'Batch BC-2608-001 · A', warehouse: 'Main Godown',
      qty: 12, unit: 'MT', cost: 30000, value: 360000, age: 20, date: '2026-08-11', flagged: false },
  ];

  function withStock(rows = STOCK) {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    repository.inventory = async () => ({ rows, meta: { total: rows.length } });
    return repository;
  }

  async function openInventory(repository) {
    const { app } = await mountApp({ repository });
    app.go('inventory')();
    await new Promise((r) => setTimeout(r, 20));
    return app;
  }

  it('names the warehouse each line is really in', async () => {
    const app = await openInventory(withStock());
    const rows = app.renderVals().inv.table.rows;

    const warehouses = rows.map((r) => r.cells[2].text);
    expect(warehouses).toContain('Main Godown');
    expect(warehouses).toContain('Sherpur Store');
    // The name that used to be written into the code for every dealer line.
    expect(warehouses).not.toContain('Bogura Depot');
  });

  it('shows one product held in two godowns as two lines', async () => {
    const app = await openInventory(withStock());
    const ridomil = app.renderVals().inv.table.rows.filter((r) => r.cells[0].text === 'Ridomil Gold');
    expect(ridomil).toHaveLength(2);
  });

  it('values the stock from the lines the server sent', async () => {
    const app = await openInventory(withStock());
    const kpis = app.renderVals().inv.kpis;
    expect(kpis.find((k) => k.k === 'Total stock value').v).toBe(money(9600 + 2400 + 360000));
    expect(kpis.find((k) => k.k === 'Bulk crop stock').s).toBe(money(360000));
    expect(kpis.find((k) => k.k === 'Dealer product stock').s).toBe(money(12000));
  });

  it('counts the godowns stock is in, not the ones on file', async () => {
    const app = await openInventory(withStock());
    expect(app.renderVals().inv.kpis[0].s).toBe('across 2 warehouses');
  });

  it('takes the low-stock flag from the server rather than recomputing it', async () => {
    const app = await openInventory(withStock());
    const flagged = app.renderVals().inv.kpis.find((k) => k.k === 'Low stock / dead stock');
    expect(flagged.v).toBe('1 item');
  });

  it('narrows to one kind of stock on the tabs', async () => {
    const app = await openInventory(withStock());
    app.setState({ invTab: 'crop' });
    const rows = app.renderVals().inv.table.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].cells[0].text).toBe('Maize');
  });

  it('falls back to the bundled derivation with no server behind it', async () => {
    const { app } = await mountApp();
    app.setState({ screen: 'inventory' });
    const rows = app.renderVals().inv.table.rows;
    expect(rows.length).toBeGreaterThan(0);

    // The dealer lines are the ones that had no warehouse of their own and
    // were labelled with a name written into the code. They now take a real
    // godown from the data. (Crop lines carry the warehouse of their batch.)
    const dealerRows = rows.filter((r) => r.cells[1].text === 'Dealer');
    expect(dealerRows.length).toBeGreaterThan(0);
    for (const row of dealerRows) expect(app.data.warehouses).toContain(row.cells[2].text);
  });
});

describe('inventory is driven by the stock table', () => {
  const LINE = (over = {}) => ({
    kind: 'dealer', name: 'Ridomil Gold', sub: 'Syngenta · Agrochemical',
    warehouse: 'Main Godown', qty: 40, unit: 'Pcs', cost: 240, value: 9600,
    age: null, date: null, flagged: false, ...over,
  });

  /** A repository answering /inventory with the given pages. */
  function serving(pages, calls = []) {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    repository.inventory = async (params) => {
      calls.push(params);
      const page = pages[(params.page || 1) - 1] || [];
      const total = pages.reduce((t, p) => t + p.length, 0);
      return { rows: page, meta: { total } };
    };
    return repository;
  }

  async function open(repository) {
    const { app } = await mountApp({ repository });
    app.go('inventory')();
    await new Promise((r) => setTimeout(r, 30));
    return app;
  }

  it('calls GET /inventory when a backend is available', async () => {
    const calls = [];
    await open(serving([[LINE()]], calls));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].page).toBe(1);
  });

  it('shows one product in one warehouse as one line', async () => {
    const app = await open(serving([[LINE()]]));
    const rows = app.renderVals().inv.table.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].cells[2].text).toBe('Main Godown');
  });

  it('shows one product in two warehouses as two lines, each with its own', async () => {
    const app = await open(serving([[
      LINE(),
      LINE({ warehouse: 'Sherpur Store', qty: 10, value: 2400 }),
    ]]));
    const rows = app.renderVals().inv.table.rows;

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.cells[2].text).sort()).toEqual(['Main Godown', 'Sherpur Store']);
    // Same product, so the split is by warehouse and nothing else.
    expect(new Set(rows.map((r) => r.cells[0].text)).size).toBe(1);
  });

  it('values stock from the served lines, warehouse by warehouse', async () => {
    const app = await open(serving([[
      LINE(),
      LINE({ warehouse: 'Sherpur Store', qty: 10, value: 2400 }),
      LINE({ kind: 'crop', name: 'Maize', warehouse: 'Main Godown', qty: 12, unit: 'MT',
        cost: 30000, value: 360000, age: 20, date: '2026-08-11' }),
    ]]));
    const inv = app.renderVals().inv;

    expect(inv.kpis.find((k) => k.k === 'Total stock value').v).toBe(money(9600 + 2400 + 360000));
    expect(inv.kpis.find((k) => k.k === 'Dealer product stock').s).toBe(money(12000));
    expect(inv.kpis.find((k) => k.k === 'Bulk crop stock').s).toBe(money(360000));
    expect(inv.table.footTotal).toBe('Total ' + money(372000));
  });

  it('counts the warehouses holding stock, not the ones on file', async () => {
    const app = await open(serving([[LINE(), LINE({ warehouse: 'Sherpur Store' })]]));
    expect(app.renderVals().inv.kpis[0].s).toBe('across 2 warehouses');
  });

  it('takes low stock from the served flag rather than recomputing it', async () => {
    const app = await open(serving([[LINE({ flagged: true }), LINE({ warehouse: 'B' })]]));
    const inv = app.renderVals().inv;
    expect(inv.kpis.find((k) => k.k === 'Low stock / dead stock').v).toBe('1 item');
    expect(inv.table.rows.find((r) => r.cells[2].text === 'Main Godown').cells[7].text)
      .toBe('Low stock');
  });

  it('shows a dash where a stock line carries no warehouse', async () => {
    const app = await open(serving([[LINE({ warehouse: '' })]]));
    const rows = app.renderVals().inv.table.rows;
    expect(rows[0].cells[2].text).toBe('—');
    // A line with no godown cannot be counted as a godown holding stock.
    expect(app.renderVals().inv.kpis[0].s).toBe('across 0 warehouses');
  });

  it('follows the pages so a big inventory is not silently truncated', async () => {
    const first = Array.from({ length: 200 }, (_, i) => LINE({ warehouse: `WH-${i}`, value: 100 }));
    const second = [LINE({ warehouse: 'WH-200', value: 100 })];
    const calls = [];
    const app = await open(serving([first, second], calls));

    expect(calls.map((c) => c.page)).toEqual([1, 2]);
    expect(app.renderVals().inv.table.rows).toHaveLength(201);
    expect(app.renderVals().inv.kpis[0].v).toBe(money(20100));
  });

  it('never derives stock from the product master while a server is answering', async () => {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    repository.inventory = () => new Promise(() => {}); // still in flight
    const { app } = await mountApp({ repository });
    app.go('inventory')();
    await new Promise((r) => setTimeout(r, 20));

    const inv = app.renderVals().inv;
    // The product master would give 12 lines and a seven-figure valuation.
    expect(inv.table.rows).toHaveLength(0);
    expect(inv.kpis[0].v).toBe(money(0));
    expect(inv.table.emptyTitle).toBe('Loading stock…');
  });

  it('says stock could not be loaded rather than reporting none', async () => {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    repository.inventory = async () => { throw new Error('gateway down'); };
    const { app } = await mountApp({ repository });
    app.go('inventory')();
    await new Promise((r) => setTimeout(r, 30));

    const table = app.renderVals().inv.table;
    expect(table.emptyTitle).toBe('Stock could not be loaded');
    expect(table.emptyNote).toBe('gateway down');
    // A failed load must never read as a valuation of nothing.
    expect(table.footTotal).toBe('');
    expect(table.footNote).toBe('Figures unavailable');
  });

  it('says the shelves are empty when they genuinely are', async () => {
    const app = await open(serving([[]]));
    const table = app.renderVals().inv.table;
    expect(table.rows).toHaveLength(0);
    expect(table.emptyTitle).toBe('No stock on hand');
    expect(table.emptyNote).toContain('Adjust stock');
  });

  it('still derives from the bundled data with no backend at all', async () => {
    const { app } = await mountApp();
    app.go('inventory')();
    await new Promise((r) => setTimeout(r, 20));

    const inv = app.renderVals().inv;
    expect(inv.table.rows.length).toBeGreaterThan(0);
    // And every warehouse it names is one the demo actually has.
    const dealerRows = inv.table.rows.filter((r) => r.cells[1].text === 'Dealer');
    for (const row of dealerRows) expect(app.data.warehouses).toContain(row.cells[2].text);
  });
});

describe('the profit and loss', () => {
  /** The statement as the ledger reports it. */
  const STATEMENT = {
    lines: [
      { label: 'Dealer sales — Dealer business', amount: 82660 },
      { label: 'Crop sales — Bulk crop business', amount: 865200 },
      { label: 'Total revenue', amount: 947860, bold: true },
      { label: 'Cost of goods sold — Dealer business', amount: -69109.9 },
      { label: 'Cost of goods sold — Bulk crop business', amount: -512536.38 },
      { label: 'Gross profit', amount: 366213.72, bold: true, good: true },
      { label: 'Selling expenses — Bulk crop business', amount: -40000 },
      { label: 'Total operating expense', amount: -40000, bold: true },
      { label: 'Net profit', amount: 326213.72, bold: true, big: true, good: true },
    ],
    totals: {
      revenue: 947860, costOfSales: 581646.28, grossProfit: 366213.72,
      operatingExpense: 40000, netProfit: 326213.72, marginPct: 34.4,
    },
    period: { from: '2026-08-01', to: '2026-08-31', businessType: null },
    isEmpty: false,
  };

  function serving(/** @type {any} */ statement = STATEMENT) {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.report = async () => ({ rows: [] });
    repository.profitAndLoss = async () => {
      if (statement instanceof Error) throw statement;
      return statement;
    };
    return repository;
  }

  async function openAccounts(repository) {
    const { app, root } = await mountApp({ repository });
    app.go('accounts')();
    await new Promise((r) => setTimeout(r, 30));
    // The statement lives behind its own tab, the way a reader reaches it.
    app.renderVals().acct.tabs.find((t) => t.l === 'Profit & Loss').onClick();
    app.renderNow();
    return { app, root };
  }

  it('renders the statement the ledger returned, line for line', async () => {
    const { app } = await openAccounts(serving());
    const pl = app.renderVals().acct.pl;

    expect(pl).toHaveLength(STATEMENT.lines.length);
    expect(pl[0].k).toBe('Dealer sales — Dealer business');
    expect(pl.find((r) => r.k === 'Total revenue').v).toBe(money(947860));
    expect(pl.find((r) => r.k === 'Net profit').v).toBe(money(326213.72));
  });

  it('puts those lines on the page, not just in the view model', async () => {
    const { root } = await openAccounts(serving());
    const text = root.textContent;

    expect(text).toContain('Crop sales — Bulk crop business');
    expect(text).toContain(money(366213.72)); // gross profit
    expect(text).toContain(money(326213.72)); // net profit
    // The fixture's figures are gone from the page entirely.
    expect(text).not.toContain(money(4030000));
  });

  it('takes the net profit KPI and margin from the same statement', async () => {
    const { app } = await openAccounts(serving());
    const kpi = app.renderVals().acct.kpis.find((k) => k.k.startsWith('Net profit'));

    expect(kpi.v).toBe(money(326213.72));
    // The margin is against total revenue, not one business line.
    expect(kpi.s).toBe('margin 34.4%');
  });

  it('totals the cash it is actually showing', async () => {
    const { app } = await openAccounts(serving());
    const acct = app.renderVals().acct;
    const kpi = acct.kpis.find((k) => k.k === 'Cash & bank');

    // The accounts the screen loads and the accounts that carry balances were
    // two separate fixtures, so the table, its footer and this tile all read
    // zero while the dashboard reported the real total.
    const shown = acct.cash.rows.reduce(
      (t, r) => t + Number(String(r.cells[4].text).replace(/[^0-9.-]/g, '')),
      0
    );
    expect(shown).toBeGreaterThan(0);
    expect(kpi.v).toBe(money(shown));
    expect(acct.cash.footTotal).toBe('Total ' + money(shown));
  });

  it('counts the cash accounts it is actually showing', async () => {
    const { app } = await openAccounts(serving());
    const acct = app.renderVals().acct;
    const kpi = acct.kpis.find((k) => k.k === 'Cash & bank');

    // The value read real accounts while the count read a fixture; they could
    // disagree on screen, and on an empty database always did.
    expect(kpi.s).toBe(`${acct.cash.rows.length} accounts`);
  });

  it('says nothing has been posted rather than reporting a profit of nothing', async () => {
    const empty = {
      lines: [{ label: 'Net profit', amount: 0, bold: true, big: true }],
      totals: { revenue: 0, costOfSales: 0, grossProfit: 0, operatingExpense: 0, netProfit: 0, marginPct: 0 },
      isEmpty: true,
    };
    const { app, root } = await openAccounts(serving(empty));
    const acct = app.renderVals().acct;

    expect(acct.plNote).toContain('Nothing has been posted');
    expect(root.textContent).toContain('Nothing has been posted');
    expect(acct.kpis.find((k) => k.k.startsWith('Net profit')).s).toBe('margin —');
  });

  it('names the span it is reporting on', async () => {
    const { app } = await openAccounts(serving());
    expect(app.renderVals().acct.plTitle).toBe('Profit & loss — August 2026');
  });

  it('reports a failure to load rather than showing a fixture', async () => {
    const { app, root } = await openAccounts(serving(new Error('ledger unavailable')));
    const acct = app.renderVals().acct;

    expect(acct.plNote).toBe('ledger unavailable');
    expect(acct.kpis.find((k) => k.k.startsWith('Net profit')).s).toBe('margin —');
    // A specimen statement in place of a real one would report a profit the
    // business never made — the worst thing this screen could do.
    expect(acct.pl).toHaveLength(0);
    expect(acct.kpis.find((k) => k.k.startsWith('Net profit')).v).toBe('—');
    expect(root.textContent).not.toContain(money(34440000));
  });

  it('still shows the bundled statement with no backend at all', async () => {
    const { app } = await mountApp();
    app.go('accounts')();
    await new Promise((r) => setTimeout(r, 30));

    const pl = app.renderVals().acct.pl;
    expect(pl.length).toBeGreaterThan(0);
    expect(pl.some((r) => /net profit/i.test(r.k))).toBe(true);
  });
});

describe('returns and credit notes', () => {
  /** Two posted returns and the notes they raised, as the API reports them. */
  const RETURNS = [
    {
      id: 1, txnNo: 'SR-2608-001', txnDate: '2026-08-30', businessType: 'DEALER',
      sourceType: 'dealer_sales', sourceNo: 'DS-2608-014', sourceLabel: 'Dealer sale',
      direction: 'SALE', partyType: 'CUSTOMER', partyId: 1, partyName: 'Messrs. Rahman Traders',
      warehouse: 'Bogura Central Godown', reason: 'Four bags arrived torn',
      netAmount: 5200, costAmount: 4000, status: 'POSTED',
      noteNo: 'CN-2608-001', noteType: 'CREDIT', noteAmount: 5200, noteOnAccount: 0,
    },
    {
      id: 2, txnNo: 'PR-2608-001', txnDate: '2026-08-29', businessType: 'DEALER',
      sourceType: 'dealer_purchases', sourceNo: 'DP-2608-009', sourceLabel: 'Dealer purchase',
      direction: 'PURCHASE', partyType: 'COMPANY', partyId: 3, partyName: 'ACI Agrochemicals Ltd.',
      warehouse: 'Bogura Central Godown', reason: 'Failed the incoming quality check',
      netAmount: 2000, costAmount: 2000, status: 'POSTED',
      noteNo: 'DN-2608-001', noteType: 'DEBIT', noteAmount: 2000, noteOnAccount: 0,
    },
    {
      id: 3, txnNo: 'SR-2608-002', txnDate: '2026-08-28', businessType: 'DEALER',
      sourceType: 'dealer_sales', sourceNo: 'DS-2608-011', sourceLabel: 'Dealer sale',
      direction: 'SALE', partyType: 'CUSTOMER', partyId: 2, partyName: 'Bhai Bhai Agro Store',
      warehouse: 'Bogura Central Godown', reason: 'Raised against the wrong invoice',
      netAmount: 900, costAmount: 700, status: 'CANCELLED',
      noteNo: null, noteType: null, noteAmount: null, noteOnAccount: null,
    },
  ];

  const NOTES = [
    {
      id: 1, noteNo: 'CN-2608-001', noteDate: '2026-08-30', noteType: 'CREDIT',
      partyName: 'Messrs. Rahman Traders', returnNo: 'SR-2608-001', sourceNo: 'DS-2608-014',
      reason: 'Four bags arrived torn', amount: 5200, appliedAmount: 5200, onAccount: 0,
      status: 'POSTED',
    },
    {
      id: 2, noteNo: 'CN-2608-002', noteDate: '2026-08-29', noteType: 'CREDIT',
      partyName: 'Sonar Bangla Enterprise', returnNo: null, sourceNo: null,
      reason: 'Price agreed after the invoice went out', amount: 1500,
      appliedAmount: 0, onAccount: 1500, status: 'POSTED',
    },
  ];

  const RETURNABLE_DOCS = [
    {
      sourceType: 'dealer_sales', sourceId: 14, txnNo: 'DS-2608-014',
      txnDate: '2026-08-30', partyName: 'Messrs. Rahman Traders',
      sourceLabel: 'Dealer sale', direction: 'SALE', netAmount: 13000,
    },
    {
      sourceType: 'dealer_sales', sourceId: 11, txnNo: 'DS-2608-011',
      txnDate: '2026-08-28', partyName: 'Bhai Bhai Agro Store',
      sourceLabel: 'Dealer sale', direction: 'SALE', netAmount: 9000,
    },
  ];

  const RETURNABLE_LINES = {
    header: { id: 14, txnNo: 'DS-2608-014', sourceLabel: 'Dealer sale', noteType: 'CREDIT' },
    lines: [
      {
        sourceItemId: 16, lineNo: 1, itemType: 'PRODUCT', productId: 1, batchId: null,
        description: 'Ridomil Gold MZ 72 WP 100g (P-1001)', quantity: 10, rate: 1300,
        discountPct: 0, unitCost: 1000, quantityReturned: 0, quantityReturnable: 10,
      },
      {
        sourceItemId: 17, lineNo: 2, itemType: 'PRODUCT', productId: 2, batchId: null,
        description: 'Autostin 50 WDG 100g (P-1002)', quantity: 6, rate: 900,
        discountPct: 0, unitCost: 700, quantityReturned: 6, quantityReturnable: 0,
      },
    ],
  };

  /** A repository that answers the returns screen the way the API does. */
  function serving(overrides = {}) {
    const repository = /** @type {any} */ (new Repository({ latency: 0 }));
    repository.returns = async () => ({ rows: RETURNS, meta: { total: RETURNS.length } });
    repository.creditNotes = async () => ({ rows: NOTES, meta: { total: NOTES.length } });
    repository.returnableDocuments = async () => RETURNABLE_DOCS;
    repository.returnable = async () => RETURNABLE_LINES;
    repository.createReturn = async () => ({ id: 9, txnNo: 'SR-2608-003', status: 'POSTED' });
    repository.cancelReturn = async () => ({ id: 1, status: 'CANCELLED' });
    return Object.assign(repository, overrides);
  }

  async function openReturns(repository = serving(), props = {}) {
    const { app, root } = await mountApp({ repository, ...props });
    app.go('returns')();
    await new Promise((r) => setTimeout(r, 30));
    app.renderNow();
    return { app, root };
  }

  /** Open the return form and wait for its document and lines to arrive. */
  async function openReturnForm(app) {
    app.renderVals().ret.actions.find((a) => a.l === 'Record a return').onClick();
    await new Promise((r) => setTimeout(r, 40));
    app.renderNow();
  }

  it('lists what came back with the note each return raised', async () => {
    const { app, root } = await openReturns();
    const rows = app.renderVals().ret.list.rows;

    expect(rows).toHaveLength(RETURNS.length);
    expect(root.textContent).toContain('SR-2608-001');
    expect(root.textContent).toContain('CN-2608-001');
    // The document it came from, so a return is never orphaned on screen.
    expect(root.textContent).toContain('DS-2608-014');
  });

  it('counts only posted returns towards the totals', async () => {
    const { app } = await openReturns();
    const ret = app.renderVals().ret;
    const kpi = (name) => ret.kpis.find((k) => k.k === name);

    // The cancelled return took nothing back, so it counts towards nothing.
    expect(kpi('Sales returned').v).toBe(money(5200));
    expect(kpi('Sales returned').s).toBe('1 return');
    expect(kpi('Purchases returned').v).toBe(money(2000));
    expect(kpi('Stock value back').v).toBe(money(4000));
  });

  it('counts credit still on account, not credit already used', async () => {
    const { app } = await openReturns();
    const kpi = app.renderVals().ret.kpis.find((k) => k.k === 'Credit on account');

    // CN-2608-001 was absorbed by its invoice; only CN-2608-002 is still owed.
    expect(kpi.v).toBe(money(1500));
    expect(kpi.s).toBe('1 open note');
  });

  it('shows the notes on their own tab', async () => {
    const { app, root } = await openReturns();
    app.renderVals().ret.tabs.find((t) => t.l === 'Credit & debit notes').onClick();
    app.renderNow();

    expect(root.textContent).toContain('CN-2608-002');
    expect(root.textContent).toContain('Price agreed after the invoice went out');
    // A note raised without a return says so rather than showing a blank.
    expect(root.textContent).toContain('On account');
  });

  it('says a list failed to load rather than showing none came back', async () => {
    const { app } = await openReturns(
      serving({
        returns: async () => {
          throw new Error('returns unavailable');
        },
      })
    );
    const list = app.renderVals().ret.list;

    expect(list.rows).toHaveLength(0);
    expect(list.emptyTitle).toBe('Returns could not be loaded');
    expect(list.emptyNote).toBe('returns unavailable');
  });

  it('offers only the lines that still have something to come back', async () => {
    const { app } = await openReturns();
    await openReturnForm(app);

    const rows = app.renderVals().modal.allocation.rows;
    // The second line was returned in full already, so it is not offered.
    expect(rows).toHaveLength(1);
    expect(rows[0].invoiceNo).toBe('Ridomil Gold MZ 72 WP 100g (P-1001)');
    expect(rows[0].balanceText).toBe('10');
  });

  it('flags a line asking for more than is left', async () => {
    const { app } = await openReturns();
    await openReturnForm(app);

    app.onReturnLine('16', '12');
    app.renderNow();

    // Flagged where it is typed, not only when the server refuses the document.
    const row = app.renderVals().modal.allocation.rows[0];
    expect(row.border).not.toBe('#E3E0DA');
  });

  it('takes back everything left in one click', async () => {
    const { app } = await openReturns();
    await openReturnForm(app);

    app.renderVals().modal.allocation.onAuto();
    app.renderNow();

    expect(app.state.modal.form.quantities).toEqual({ 16: 10 });
    // Only what is still returnable; the fully-returned line stays out.
    expect(app.state.modal.form.quantities['17']).toBeUndefined();
  });

  it('will not post a return with no reason and no quantity', async () => {
    const { app } = await openReturns();
    await openReturnForm(app);

    app.submitForm();
    expect(app.state.modal.error).toBe('Say why the goods came back.');

    app.onFormField('reason')({ target: { value: 'Damaged in transit' } });
    app.submitForm();
    expect(app.state.modal.error).toContain('how much of at least one line');
  });

  it('sends the document, the reason and only the filled lines', async () => {
    /** @type {any} */
    let sent = null;
    const { app } = await openReturns(
      serving({
        createReturn: async (body) => {
          sent = body;
          return { id: 9, txnNo: 'SR-2608-003', status: 'POSTED' };
        },
      })
    );
    await openReturnForm(app);

    app.onFormField('reason')({ target: { value: 'Four bags arrived torn' } });
    app.onReturnLine('16', '4');
    app.submitForm();
    await new Promise((r) => setTimeout(r, 40));

    expect(sent.sourceType).toBe('dealer_sales');
    expect(sent.sourceId).toBe(14);
    expect(sent.reason).toBe('Four bags arrived torn');
    expect(sent.lines).toEqual([{ sourceItemId: 16, quantity: 4 }]);
    // Posted outright: a return that sits in draft has not put the stock back.
    expect(sent.action).toBe('POST');
  });

  it('states what the return will credit before it is posted', async () => {
    const { app } = await openReturns();
    await openReturnForm(app);

    app.onReturnLine('16', '4');
    app.renderNow();

    const summary = app.renderVals().modal.summary;
    expect(summary.find((r) => r.k === 'Credit note').v).toBe(money(4 * 1300));
    expect(summary.find((r) => r.k === 'Customer will owe').v).toBe(money(5200) + ' less');
  });

  it('opens a return already pointed at the invoice it came from', async () => {
    const repository = serving();
    repository.invoices = async () => ({
      rows: [
        {
          id: 14, no: 'DS-2608-014', date: '2026-08-30', customer: 'Messrs. Rahman Traders',
          items: 1, amount: 13000, paid: 0, due: 13000, status: 'POSTED',
        },
      ],
    });
    const { app } = await mountApp({ repository });
    app.go('dealer-sales')();
    await new Promise((r) => setTimeout(r, 30));
    app.renderNow();

    const cells = app.renderVals().invoices.rows[0].cells;
    const actions = cells[cells.length - 1].actions;
    const returnAction = actions.find((a) => a.label === 'Return');
    expect(returnAction, 'a Return action on a posted invoice').toBeTruthy();

    returnAction.onClick();
    await new Promise((r) => setTimeout(r, 40));
    expect(app.state.modal.kind).toBe('return');
    expect(app.state.modal.form.source).toBe('dealer_sales:14');
  });

  it('hides the actions a role may not take', async () => {
    const { app } = await openReturns(serving(), { permissions: ['return.view'] });
    const ret = app.renderVals().ret;
    const cells = ret.list.rows[0].cells;

    // Viewing is not raising, and the row action goes with the permission.
    expect(ret.actions).toHaveLength(0);
    expect(cells[cells.length - 1].actions).toHaveLength(0);
  });

  it('offers cancelling only on a posted return', async () => {
    const { app } = await openReturns(serving(), {
      permissions: ['return.view', 'return.create', 'return.cancel', 'credit.note.create'],
    });
    const rows = app.renderVals().ret.list.rows;
    const last = (row) => row.cells[row.cells.length - 1].actions;

    expect(last(rows[0]).map((a) => a.label)).toEqual(['Cancel']);
    // Nothing to undo on one that was already cancelled.
    expect(last(rows[2])).toHaveLength(0);
  });

  it('cancels a return only once a reason has been given', async () => {
    /** @type {any} */
    let cancelled = null;
    const repository = serving({
      cancelReturn: async (id, reason) => {
        cancelled = { id, reason };
        return { id, status: 'CANCELLED' };
      },
    });
    const { app } = await openReturns(repository);
    const cancelAction = () => {
      const row = app.renderVals().ret.list.rows[0];
      return row.cells[row.cells.length - 1].actions[0];
    };

    app.ask = () => '';
    cancelAction().onClick();
    expect(cancelled, 'nothing cancelled without a reason').toBeNull();

    app.ask = () => 'Raised against the wrong invoice';
    cancelAction().onClick();
    await new Promise((r) => setTimeout(r, 40));
    expect(cancelled).toEqual({ id: 1, reason: 'Raised against the wrong invoice' });
  });

  it('says so plainly when there is no backend to return against', async () => {
    const { app } = await mountApp();
    app.go('returns')();
    await new Promise((r) => setTimeout(r, 30));
    app.renderNow();

    const list = app.renderVals().ret.list;
    expect(list.rows).toHaveLength(0);
    expect(list.emptyTitle).toBe('Nothing has come back');
  });
});
