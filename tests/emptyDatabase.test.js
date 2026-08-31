import { describe, it, expect, beforeEach } from 'vitest';
import appTemplate from '../src/templates/app.html?raw';
import dataTableTemplate from '../src/templates/dataTable.html?raw';
import formModalTemplate from '../src/templates/formModal.html?raw';
import { BusinessApp } from '../src/app/logic.js';
import { InMemoryRepository } from '../src/data/repository.js';
import { NAV, TITLES } from '../src/data/seed.js';

/**
 * The app against a database with nothing in it.
 *
 * This is the state every real installation starts in, and every screen was
 * written against a fixture that always had six customers, four godowns and a
 * warehouse full of stock. Reaching for "the first customer" is fine until
 * there is no first customer -- at which point it is not the customers screen
 * that fails but the whole app, because the view model is built in one pass
 * and one screen's reading of `undefined.name` takes the render with it.
 *
 * So this mounts on an empty working set and visits every screen. It is a boot
 * test rather than a display test: what it asserts is that nothing reads a
 * property off a record that is not there, and that the screens say the
 * business has nothing yet rather than showing a zero they invented.
 */

/** Every screen the navigation offers. */
const SCREENS = Object.keys(TITLES);

/**
 * The working set of a business created five minutes ago.
 *
 * Built from the real one by emptying every collection, so a key added to the
 * payload later is empty here too rather than missing -- a missing key tests
 * something other than an empty database.
 */
async function emptyData() {
  const full = await new InMemoryRepository({ latency: 0 }).load();
  const empty = {};

  for (const [key, value] of Object.entries(full)) {
    empty[key] = Array.isArray(value) ? [] : value && typeof value === 'object' ? {} : value;
  }

  // The shell is configuration rather than business data: a new installation
  // has navigation and screen titles on the first render.
  empty.nav = NAV;
  empty.titles = TITLES;
  empty.company = full.company;
  return empty;
}

/** Mount the real templates against an empty working set. */
async function mountEmpty(props = {}) {
  const repository = new InMemoryRepository({ latency: 0 });
  const data = await emptyData();
  const root = document.createElement('div');
  document.body.append(root);

  const app = new BusinessApp(
    { role: 'Admin', showProfit: true, approvalLimit: 500000, repository, ...props },
    data
  );
  app.mount(root, appTemplate, { DataTable: dataTableTemplate, FormModal: formModalTemplate });
  return { app, root };
}

describe('an empty database', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('mounts at all', async () => {
    const { root } = await mountEmpty();

    expect(root.querySelector('aside')).not.toBeNull();
    expect(root.querySelector('h1')).not.toBeNull();
  });

  it.each(SCREENS)('renders %s without reading a record that is not there', async (screen) => {
    const { app, root } = await mountEmpty();

    app.setState({ screen });
    app.renderNow();

    // The screen drew, and drew itself rather than the one before it.
    expect(root.querySelector('h1').textContent).toBe(TITLES[screen][0]);
    expect(root.textContent).not.toContain('undefined');
    expect(root.textContent).not.toContain('NaN');
  });

  it('builds every view model without throwing', async () => {
    const { app } = await mountEmpty();

    // renderVals assembles all of them in one pass, which is exactly why one
    // screen's missing record used to take the whole app down.
    expect(() => app.renderVals()).not.toThrow();
  });

  it('reports nothing rather than inventing a figure', async () => {
    const { app } = await mountEmpty();
    const vals = app.renderVals();

    for (const card of vals.dash.kpis) {
      expect(card.v).not.toContain('NaN');
      expect(card.v).not.toContain('undefined');
    }
  });

  it('says the tables are empty in words a new user can act on', async () => {
    const { app, root } = await mountEmpty();

    app.setState({ screen: 'customers' });
    app.renderNow();

    // The empty state is the first thing a real business sees on this screen,
    // so it has to say what to do rather than showing an empty grid.
    expect(root.textContent).toContain('No customers');
  });

  it('offers the whole navigation, since permissions do not depend on data', async () => {
    const { root } = await mountEmpty();
    const labels = [...root.querySelectorAll('aside nav button')].map((b) => b.textContent.trim());

    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Customers');
    expect(labels.length).toBe(NAV.flatMap((g) => g.items).length);
  });

  it('lets the first record be created from an empty screen', async () => {
    const { app } = await mountEmpty();

    app.setState({ screen: 'customers' });
    app.renderNow();

    // Every dropdown on this form is drawn from records that do not exist yet,
    // which is the moment a form built around "the existing options" breaks.
    expect(() => app.openMaster('customer')).not.toThrow();
    expect(() => app.masterModal()).not.toThrow();
    expect(app.state.master.kind).toBe('customer');
  });
});

describe('transaction forms on an empty database', () => {
  it('opens on no record rather than on one that does not exist', async () => {
    const { app } = await mountEmpty();
    const { ds, dp, cp, cs } = app.state;

    // The design opened these on a worked example. On a database with none of
    // those records the codes resolve to nothing and the post is refused, so
    // the fields open empty for the operator to choose.
    expect(ds.cust).toBe('');
    expect(ds.wh).toBe('');
    expect(ds.lines).toHaveLength(0);
    expect(dp.co).toBe('');
    expect(dp.lines).toHaveLength(0);
    expect(cp.sup).toBe('');
    expect(cs.buyer).toBe('');
  });

  it('dates a new document today, not the day the design was drawn', async () => {
    const { app } = await mountEmpty();
    const today = new Date();
    const expected = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');

    for (const form of ['ds', 'dp', 'cp', 'cs']) {
      expect(app.state[form].date, form).toBe(expected);
    }
  });

  it('opens a blank invoice with nothing already paid on it', async () => {
    const { app } = await mountEmpty();
    expect(app.state.ds.paid).toBe(0);
    expect(app.state.dp.transport).toBe(0);
    expect(app.state.dp.inv).toBe('');
  });
});

/**
 * The working set of a role that may not see every master.
 *
 * The workspace hands back one payload for every screen, so a list a role may
 * not see comes back empty rather than absent. That is a different shape from
 * an empty database — products and stock are there, the parties are not — and
 * it is the shape a warehouse clerk actually boots into.
 */
describe('a role that may not see every master', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  /** Everything a warehouse clerk gets: goods and stock, no parties. */
  async function mountScoped(props = {}) {
    const repository = new InMemoryRepository({ latency: 0 });
    const full = await repository.load();
    const data = { ...full, customers: [], suppliers: [], companies: [], buyers: [] };

    const root = document.createElement('div');
    document.body.append(root);
    const app = new BusinessApp(
      {
        role: 'Warehouse',
        showProfit: false,
        approvalLimit: 500000,
        repository,
        permissions: [
          'dashboard.view',
          'product.view',
          'inventory.view',
          'inventory.adjust',
          'inventory.transfer',
          'crop.view',
        ],
        ...props,
      },
      data
    );
    app.mount(root, appTemplate, { DataTable: dataTableTemplate, FormModal: formModalTemplate });
    return { app, root };
  }

  it('visits every screen without reading a party that is not there', async () => {
    const { app, root } = await mountScoped();

    for (const screen of SCREENS) {
      app.go(screen)();
      app.renderNow();
      // The render is one pass, so one screen reaching for "the first
      // customer" takes the whole app down, not just its own panel.
      expect(root.querySelector('h1'), screen).not.toBeNull();
    }
  });

  it('searches only what it was given', async () => {
    const { app } = await mountScoped();
    app.setState({ q: 'a' });

    const groups = app.renderVals().sr.groups.map((g) => g.g);
    // The header box reads the payload, so a list the server withheld cannot
    // be searched here either.
    expect(groups).not.toContain('Customers');
    expect(groups).not.toContain('Suppliers');
  });

  it('still shows the goods and the stock it does handle', async () => {
    const { app } = await mountScoped();
    app.go('inventory')();
    app.renderNow();

    expect(app.data.products.length).toBeGreaterThan(0);
    expect(app.renderVals().inv.kpis.length).toBeGreaterThan(0);
  });

  it('offers only the screens the role may reach', async () => {
    const { app } = await mountScoped();
    const labels = app.renderVals().nav.flatMap((g) => g.items.map((i) => i.label));

    expect(labels).toContain('Inventory');
    expect(labels).not.toContain('Customers');
    expect(labels).not.toContain('Accounts & Outstanding');
  });
});
