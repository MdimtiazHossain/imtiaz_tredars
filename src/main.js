import './styles/app.css';
import appTemplate from './templates/app.html?raw';
import dataTableTemplate from './templates/dataTable.html?raw';
import formModalTemplate from './templates/formModal.html?raw';
import { BusinessApp } from './app/logic.js';
import { createRepository } from './data/repository.js';
import { ApiRepository } from './data/apiRepository.js';
import { renderSignIn, renderPasswordChange } from './app/signIn.js';

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
function readProps(user, workspace) {
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
    // The limit the approval engine actually applies, from the rules table.
    // The query string still overrides it for a no-backend demo, and 5 lakh is
    // the last resort rather than the figure the app believes in.
    approvalLimit:
      Number.isFinite(limit) && limit > 0 ? limit : workspace?.approvalLimit || 500000,
    // What the signed-in user may do, used to decide which master-data
    // controls to draw. The server checks the same codes on every route.
    permissions: user?.permissions || null,
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

  const app = new BusinessApp(
    {
      ...readProps(user, data),
      // Signing out drops the tokens and starts the boot sequence again, which
      // lands on the sign-in card because there is no longer a session to
      // restore. The app does not need to know any of that.
      onSignOut: () =>
        Promise.resolve(
          'logout' in repository ? repository.logout() : null
        )
          .catch(() => {})
          .then(() => start(root)),
    },
    data
  );
  app.mount(root, appTemplate, {
    DataTable: dataTableTemplate,
    FormModal: formModalTemplate,
  });
  // Dashboard totals are aggregated server-side where the repository supports
  // it; this is a no-op against the in-memory repository.
  app.loadDashboard();

  // Debug handle for manual inspection in the browser console.
  /** @type {any} */ (window).__app = app;
  return app;
}

export async function start(root) {
  try {
    if (!needsAuth) return await mountApp(root, null);

    showBoot(root, 'Restoring your session…');
    let user = await repository.restore().catch(() => null);
    // Kept in scope because the password-change card names the business too.
    let context = null;

    if (!user) {
      // Ask who this installation belongs to before drawing the card that
      // names them. It is fetched alongside nothing else, so a slow answer
      // delays only the card and never the session that follows it.
      context = await repository.context();
      user = await renderSignIn(
        root,
        (username, password) => repository.login(username, password),
        context
      );
    }

    // An account still holding the password it was created with may do nothing
    // else, and the API says so: every route but /auth answers 403 until it is
    // replaced. Mounting would show a shell of failed requests, so the change
    // is asked for here instead, in place of the app.
    if (user && user.mustChangePassword) {
      await renderPasswordChange(
        root,
        (current, next) => repository.changePassword(current, next),
        () => {
          Promise.resolve(repository.logout ? repository.logout() : null)
            .catch(() => {})
            .then(() => start(root));
        },
        { name: context?.name, username: user.username }
      );
      // Changing it revokes every session this user had, including this one's
      // refresh token, so the sequence starts again and they sign in with the
      // password they just chose.
      return await start(root);
    }

    return await mountApp(root, user);
  } catch (err) {
    showError(root, err, () => start(root));
    throw err;
  }
}

const root = document.getElementById('app');
if (root) start(root);
