import { describe, it, expect, beforeEach } from 'vitest';
import appTemplate from '../src/templates/app.html?raw';
import dataTableTemplate from '../src/templates/dataTable.html?raw';
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
  app.mount(root, appTemplate, { DataTable: dataTableTemplate });
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
