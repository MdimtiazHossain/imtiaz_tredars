import './styles/app.css';
import appTemplate from './templates/app.html?raw';
import dataTableTemplate from './templates/dataTable.html?raw';
import { BusinessApp } from './app/logic.js';
import { repository } from './data/repository.js';

/**
 * Application entry point.
 *
 * Boots by loading the working set from the repository, then mounts the screen
 * logic against the design templates. The DataTable is registered as a child
 * template so every `<dc-import name="DataTable">` in the design resolves.
 */

/** Props the design exposes as tweakable inputs, overridable via the query string. */
function readProps() {
  const q = new URLSearchParams(window.location.search);
  const roles = ['Admin', 'Management', 'Sales', 'Purchase', 'Accounts', 'Warehouse'];
  const role = q.get('role');
  const showProfit = q.get('showProfit');
  const limit = Number(q.get('approvalLimit'));

  return {
    role: roles.includes(role) ? role : 'Admin',
    showProfit: showProfit === null ? true : showProfit !== 'false',
    approvalLimit: Number.isFinite(limit) && limit > 0 ? limit : 500000,
    repository,
  };
}

function showBoot(root) {
  root.innerHTML =
    '<div class="app-boot"><div class="app-boot-spinner"></div><div>Loading business data…</div></div>';
}

function showError(root, err) {
  const box = document.createElement('div');
  box.className = 'app-error';
  const title = document.createElement('h1');
  title.textContent = 'The application could not start';
  const body = document.createElement('p');
  body.textContent = 'Loading the working set from the data layer failed.';
  const detail = document.createElement('pre');
  detail.textContent = String((err && err.stack) || err);
  box.append(title, body, detail);
  root.replaceChildren(box);
}

export async function start(root) {
  showBoot(root);
  try {
    const data = await repository.load();
    root.replaceChildren();
    const app = new BusinessApp(readProps(), data);
    app.mount(root, appTemplate, { DataTable: dataTableTemplate });
    // Debug handle for manual inspection in the browser console.
    /** @type {any} */ (window).__app = app;
    return app;
  } catch (err) {
    showError(root, err);
    throw err;
  }
}

const root = document.getElementById('app');
if (root) start(root);
