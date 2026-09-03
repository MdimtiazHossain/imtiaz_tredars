/**
 * Sign-in screen.
 *
 * Shown only when the app is running against the API. It is deliberately the
 * smallest thing that does the job, and reuses the design's own tokens --
 * maroon accent, Instrument Sans, the same card treatment as the KPI tiles --
 * so it reads as part of the product rather than a bolted-on gate.
 */

const FIELD_STYLE =
  'width:100%;padding:10px 12px;border:1px solid #E3E0DA;border-radius:8px;' +
  'background:#FBFAF8;font-size:14px';

const LABEL_STYLE =
  'display:block;font-size:11.5px;font-weight:600;color:#6E6A64;margin-bottom:6px';

/** Escape text going into the card's markup. */
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/**
 * Render the form and resolve with the signed-in user.
 *
 * @param {HTMLElement} root
 * @param {(username: string, password: string) => Promise<object>} onSubmit
 * @param {{name?: string, systemName?: string}} [context] who this
 *   installation belongs to, from `GET /auth/context`
 * @returns {Promise<object>} the authenticated user
 */
export function renderSignIn(root, onSubmit, context) {
  return new Promise((resolve) => {
    // The business naming itself, rather than the name of the one this was
    // first built for. Falls back only when the server could not be asked --
    // in which case signing in is not going to work either, and a wrong name
    // is the smaller of the two problems on screen.
    const name = context?.name || 'Business Suite';
    const systemName = context?.systemName || 'Sign in to continue';
    const initial = (name.trim()[0] || 'B').toUpperCase();

    root.replaceChildren();

    const shell = document.createElement('div');
    shell.style.cssText =
      'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px';

    const card = document.createElement('form');
    card.setAttribute('novalidate', '');
    card.style.cssText =
      'width:100%;max-width:380px;background:#fff;border:1px solid #E3E0DA;' +
      'border-radius:12px;padding:26px 26px 22px;box-shadow:0 14px 40px rgba(26,24,23,.08)';

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:11px;margin-bottom:20px">
        <div style="width:36px;height:36px;flex:none;border-radius:9px;background:#8A2233;
                    color:#fff;display:flex;align-items:center;justify-content:center;
                    font-weight:700;font-size:16px">${escape(initial)}</div>
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:-0.01em">${escape(name)}</div>
          <div style="font-size:11.5px;color:#8C877F">${escape(systemName)}</div>
        </div>
      </div>

      <label style="display:block;margin-bottom:13px">
        <span style="${LABEL_STYLE}">Username</span>
        <input name="username" autocomplete="username" autocapitalize="none"
               spellcheck="false" style="${FIELD_STYLE}" />
      </label>

      <label style="display:block;margin-bottom:18px">
        <span style="${LABEL_STYLE}">Password</span>
        <input name="password" type="password" autocomplete="current-password"
               style="${FIELD_STYLE}" />
      </label>

      <div data-error role="alert" aria-live="polite"
           style="display:none;margin-bottom:14px;padding:9px 11px;border-radius:7px;
                  background:#FBEEF0;color:#B3261E;font-size:12.5px"></div>

      <button type="submit" data-submit
              style="width:100%;border:0;border-radius:8px;background:#8A2233;color:#fff;
                     padding:11px;font-size:13.5px;font-weight:600;cursor:pointer">
        Sign in
      </button>
    `;

    const username = /** @type {HTMLInputElement} */ (card.querySelector('input[name=username]'));
    const password = /** @type {HTMLInputElement} */ (card.querySelector('input[name=password]'));
    const errorBox = /** @type {HTMLElement} */ (card.querySelector('[data-error]'));
    const submit = /** @type {HTMLButtonElement} */ (card.querySelector('[data-submit]'));

    const showError = (message) => {
      errorBox.textContent = message;
      errorBox.style.display = 'block';
    };

    let busy = false;

    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;

      errorBox.style.display = 'none';

      if (!username.value.trim() || !password.value) {
        showError('Enter your username and password.');
        return;
      }

      busy = true;
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      submit.style.opacity = '0.7';

      try {
        const user = await onSubmit(username.value.trim(), password.value);
        resolve(user);
      } catch (err) {
        showError(err?.message || 'Could not sign in. Please try again.');
        password.value = '';
        password.focus();
      } finally {
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Sign in';
        submit.style.opacity = '1';
      }
    });

    shell.append(card);
    root.append(shell);
    username.focus();
  });
}

/**
 * Replace a one-time password before anything else can happen.
 *
 * Every account this system creates is flagged to force this, and the API now
 * refuses everything but `/auth` until it is done -- so this is not a prompt
 * that can be dismissed, and there is nothing behind it to go back to. It is
 * shown in place of the app rather than over it for that reason.
 *
 * There is no cancel. Somebody who does not want to continue signs out, which
 * is offered, because the alternative is a screen with no way off it.
 *
 * @param {HTMLElement} root
 * @param {(current: string, next: string) => Promise<unknown>} onSubmit
 * @param {() => void} onSignOut
 * @param {{name?: string, username?: string}} [who]
 * @returns {Promise<void>} resolves once the password has been changed
 */
export function renderPasswordChange(root, onSubmit, onSignOut, who) {
  return new Promise((resolve) => {
    const name = who?.name || 'Business Suite';
    const initial = (name.trim()[0] || 'B').toUpperCase();

    root.replaceChildren();

    const shell = document.createElement('div');
    shell.style.cssText =
      'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px';

    const card = document.createElement('form');
    card.setAttribute('novalidate', '');
    card.style.cssText =
      'width:100%;max-width:400px;background:#fff;border:1px solid #E3E0DA;' +
      'border-radius:12px;padding:26px 26px 22px;box-shadow:0 14px 40px rgba(26,24,23,.08)';

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:11px;margin-bottom:18px">
        <div style="width:36px;height:36px;flex:none;border-radius:9px;background:#8A2233;
                    color:#fff;display:flex;align-items:center;justify-content:center;
                    font-weight:700;font-size:16px">${escape(initial)}</div>
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:-0.01em">Choose a password</div>
          <div style="font-size:11.5px;color:#8C877F">${escape(who?.username || '')}</div>
        </div>
      </div>

      <p style="margin:0 0 18px;font-size:12.5px;line-height:1.55;color:#6E6A64">
        This account is still using the one-time password it was created with.
        That password was printed once and may have been written down or passed
        on, so it cannot be kept. Nothing else is available until it is replaced.
      </p>

      <label style="display:block;margin-bottom:13px">
        <span style="${LABEL_STYLE}">One-time password</span>
        <input name="current" type="password" autocomplete="current-password"
               style="${FIELD_STYLE}" />
      </label>

      <label style="display:block;margin-bottom:13px">
        <span style="${LABEL_STYLE}">New password</span>
        <input name="next" type="password" autocomplete="new-password" style="${FIELD_STYLE}" />
        <span style="display:block;margin-top:5px;font-size:11px;color:#8C877F">
          At least 10 characters
        </span>
      </label>

      <label style="display:block;margin-bottom:18px">
        <span style="${LABEL_STYLE}">New password again</span>
        <input name="repeat" type="password" autocomplete="new-password" style="${FIELD_STYLE}" />
      </label>

      <div data-error role="alert" aria-live="polite"
           style="display:none;margin-bottom:14px;padding:9px 11px;border-radius:7px;
                  background:#FBEEF0;color:#B3261E;font-size:12.5px"></div>

      <button type="submit" data-submit
              style="width:100%;border:0;border-radius:8px;background:#8A2233;color:#fff;
                     padding:11px;font-size:13.5px;font-weight:600;cursor:pointer">
        Set password and continue
      </button>

      <button type="button" data-signout
              style="width:100%;margin-top:9px;border:0;background:none;color:#8C877F;
                     padding:7px;font-size:12px;cursor:pointer">
        Sign out instead
      </button>
    `;

    const current = /** @type {HTMLInputElement} */ (card.querySelector('input[name=current]'));
    const next = /** @type {HTMLInputElement} */ (card.querySelector('input[name=next]'));
    const repeat = /** @type {HTMLInputElement} */ (card.querySelector('input[name=repeat]'));
    const errorBox = /** @type {HTMLElement} */ (card.querySelector('[data-error]'));
    const submit = /** @type {HTMLButtonElement} */ (card.querySelector('[data-submit]'));
    const signOut = /** @type {HTMLButtonElement} */ (card.querySelector('[data-signout]'));

    const showError = (message) => {
      errorBox.textContent = message;
      errorBox.style.display = 'block';
    };

    signOut.addEventListener('click', () => onSignOut());

    let busy = false;

    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      errorBox.style.display = 'none';

      // The same checks the in-app form makes, so the two agree about what a
      // password has to be.
      const problem = !current.value
        ? 'Enter the one-time password you signed in with.'
        : next.value.length < 10
          ? 'Choose a new password of at least 10 characters.'
          : next.value !== repeat.value
            ? 'The two new passwords do not match.'
            : next.value === current.value
              ? 'The new password is the same as the one-time one.'
              : null;

      if (problem) {
        showError(problem);
        return;
      }

      busy = true;
      submit.disabled = true;
      submit.textContent = 'Setting…';
      submit.style.opacity = '0.7';

      try {
        await onSubmit(current.value, next.value);
        resolve();
      } catch (err) {
        showError(err?.message || 'Could not change the password. Please try again.');
        current.value = '';
        current.focus();
      } finally {
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Set password and continue';
        submit.style.opacity = '1';
      }
    });

    shell.append(card);
    root.append(shell);
    current.focus();
  });
}
