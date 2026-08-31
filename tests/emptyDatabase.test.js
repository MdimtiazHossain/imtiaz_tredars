import { describe, it, expect, beforeEach } from 'vitest';
import appTemplate from '../src/templates/app.html?raw';
import dataTableTemplate from '../src/templates/dataTable.html?raw';
import formModalTemplate from '../src/templates/formModal.html?raw';
import { BusinessApp } from '../src/app/logic.js';
import { Repository } from '../src/data/repository.js';

/**
 * The app against a database with nothing in it.
 *
 * This is the state a real business starts in, and every screen was written
 * against a dataset that always had six customers and a warehouse full of
 * stock. Selecting "the first customer" is fine until there is no first
 * customer, at which point the whole app fails to mount -- not the customers
 * screen, the app, because the view model is built in one pass.
 *
 * So this mounts on an empty working set and renders every screen. It is a
 * boot test rather than a display test: what it is really asserting is that
 * nothing here reads a property off a record that does not exist.
 */

const SCREENS = [
  'dashboard', 'crop-purchase', 'crop-sales', 'dealer-purchase', 'dealer-sales',
  'inventory', 'customers', 'suppliers', 'companies', 'warehouses', 'products',
  'crops', 'accounts', 'approvals', 'reports', 'settings', 'employees', 'audit',
  'mobile',
];

/** The working set of a business that has just been created. */
async function emptyData() {
  const repository = new Repository({ latency: 0 });
  const data = await repository.load();

  // Everything the business would enter, removed; the shell config -- the
  // navigation, the screen titles -- is not business data and stays.
  for (const key of [
    'customers', 'suppliers', 'companies', 'products', 'crops', 'warehouses',
    'employees', 'grades', 'buyers', 'batches', 'approvals', 'cropLog',
    'saleLog', 'notifications', 'accounts', 'paymentMethods', 'expenseCategories',
  ]) {
    data[key] = [];
  }
  data.lastRate = {};
  // A unit has to exist before anything can be measured, and the fresh install
  // creates them; nothing else does.
  data.units = ['MT', 'Kg', 'Pcs'];
  return { repository, data };
}

async function mountEmpty(props = {}) {
  const { repository, data } = await emptyData();
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = new BusinessApp(
    { role: 'Admin', showProfit: true, approvalLimit: 500000, repository, ...props },
    data
  );
  app.mount(root, appTemplate, { DataTable: dataTableTemplate, FormModal: formModalTemplate });
  return { app, root };
}

describe('a database with nothing in it', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('mounts', async () => {
    const { root } = await mountEmpty();
    expect(root.textContent).toBeTruthy();
  });

  it('builds every screen without reading a record that is not there', async () => {
    const { app } = await mountEmpty();
    for (const screen of SCREENS) {
      app.setState({ screen });
      expect(() => app.renderNow(), `${screen} should render on an empty database`).not.toThrow();
    }
  });

  it('renders for every role, not only for an administrator', async () => {
    for (const role of ['Admin', 'Management', 'Sales', 'Purchase', 'Accounts', 'Warehouse']) {
      const { app } = await mountEmpty({ role });
      for (const screen of SCREENS) {
        app.setState({ screen });
        expect(() => app.renderNow(), `${screen} as ${role}`).not.toThrow();
      }
    }
  });

  it('opens every form on an empty database', async () => {
    const { app } = await mountEmpty();
    for (const kind of /** @type {const} */ (['payment', 'expense', 'transfer', 'adjustment'])) {
      expect(() => app.openForm(kind), `${kind} form`).not.toThrow();
      expect(() => app.renderNow(), `${kind} form renders`).not.toThrow();
      app.closeForm();
    }
  });

  it('offers the add form for every master with nothing to copy from', async () => {
    const { app } = await mountEmpty();
    for (const kind of [
      'crop', 'product', 'customer', 'supplier', 'company', 'warehouse',
      'employee', 'account', 'category', 'method',
    ]) {
      expect(() => app.openMaster(kind), `new ${kind}`).not.toThrow();
      expect(() => app.renderNow(), `new ${kind} renders`).not.toThrow();
      app.closeMaster();
    }
  });

  it('reports nothing rather than a total of nothing', async () => {
    const { app } = await mountEmpty();
    app.setState({ screen: 'customers' });
    const vals = app.renderVals();

    // The empty state is a sentence, not a table of invented rows.
    expect(vals.cust.list).toHaveLength(0);
    expect(vals.cust.purchases.rows).toHaveLength(0);
    expect(vals.cust.ledger.rows).toHaveLength(0);
    expect(vals.sup.payments.rows).toHaveLength(0);
    expect(vals.acct.rec.rows).toHaveLength(0);
    expect(vals.inv.table.rows).toHaveLength(0);

    // Nothing traded, so nobody is top of anything and no bar is 'NaN%'.
    expect(vals.dash.topCust).toHaveLength(0);
    expect(vals.dash.topCo).toHaveLength(0);
    for (const bucket of vals.dash.aging) expect(bucket.w).toBe('0.0%');
    expect(vals.cust.availW).toBe('0.0%');
  });
});
