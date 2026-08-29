import './styles/app.css';
import appTemplate from './templates/app.html?raw';
import dataTableTemplate from './templates/dataTable.html?raw';
import { BusinessApp } from './app/logic.js';
import { createRepository } from './data/repository.js';
import { ApiRepository } from './data/apiRepository.js';
import { renderSignIn } from './app/signIn.js';

/**
 * Application entry point.
 *
 * Boots against whichever repository is configured: the bundled seed data when
 * no API URL is set, or the live backend when one is. With a backend the user
 * signs in first; without one the app opens straight onto the dashboard, which
 * is what the test suite and a no-backend demo rely on.
 */

const repository = createRepository();
const needsAuth = repository instanceof ApiRepository;

/** Props the design exposes as tweakable inputs, overridable via the query string. */
function readProps(user) {
  const q = new URLSearchParams(window.location.search);
  const roles = ['Admin', 'Management', 'Sales', 'Purchase', 'Accounts', 'Warehouse'];
  const requested = q.get('role');
  const showProfit = q.get('showProfit');
  const limit = Number(q.get('approvalLimit'));

  return {
    // With a backend the role comes from the signed-in user and the query
    // string cannot widen it; permissions are enforced server-side regardless.
    role: user?.role || (roles.includes(requested) ? requested : 'Admin'),
    showProfit:
      user?.permissions
        ? user.permissions.includes('report.profit')
        : showProfit === null
          ? true
          : showProfit !== 'false',
    approvalLimit: Number.isFinite(limit) && limit > 0 ? limit : 500000,
    repository,
  };
}

function showBoot(root, message = 'Loading business data…') {
  root.innerHTML =
    '<div class="app-boot"><div class="app-boot-spinner"></div><div></div></div>';
  /** @type {HTMLElement} */ (root.querySelector('.app-boot div:last-child')).textContent = message;
}

function showError(root, err, onRetry) {
  const box = document.createElement('div');
  box.className = 'app-error';

  const title = document.createElement('h1');
  title.textContent = 'The application could not start';

  const body = document.createElement('p');
  body.textContent =
    err?.code === 'NETWORK_ERROR'
      ? 'The server could not be reached. Check that the API is running.'
      : 'Loading the working set failed.';

  const detail = document.createElement('pre');
  detail.textContent = String(err?.message || err);

  box.append(title, body, detail);

  if (onRetry) {
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.style.cssText =
      'margin-top:12px;border:1px solid #E3E0DA;background:#fff;border-radius:7px;' +
      'padding:8px 14px;font-size:13px;cursor:pointer';
    retry.addEventListener('click', onRetry);
    box.append(retry);
  }

  root.replaceChildren(box);
}

/** Load the workspace and mount the app. */
async function mountApp(root, user) {
  showBoot(root);
  const data = await repository.load();
  root.replaceChildren();

  const app = new BusinessApp(readProps(user), data);
  app.mount(root, appTemplate, { DataTable: dataTableTemplate });

  // Debug handle for manual inspection in the browser console.
  /** @type {any} */ (window).__app = app;
  return app;
}

export async function start(root) {
  try {
    if (!needsAuth) return await mountApp(root, null);

    showBoot(root, 'Restoring your session…');
    let user = await repository.restore().catch(() => null);

    if (!user) {
      user = await renderSignIn(root, (username, password) =>
        repository.login(username, password)
      );
    }

    return await mountApp(root, user);
  } catch (err) {
    showError(root, err, () => start(root));
    throw err;
  }
}

const root = document.getElementById('app');
if (root) start(root);
