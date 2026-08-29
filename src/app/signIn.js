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

/**
 * Render the form and resolve with the signed-in user.
 *
 * @param {HTMLElement} root
 * @param {(username: string, password: string) => Promise<object>} onSubmit
 * @returns {Promise<object>} the authenticated user
 */
export function renderSignIn(root, onSubmit) {
  return new Promise((resolve) => {
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
                    font-weight:700;font-size:16px">M</div>
        <div>
          <div style="font-size:15px;font-weight:700;letter-spacing:-0.01em">Meghna Agro Enterprise</div>
          <div style="font-size:11.5px;color:#8C877F">Business Suite</div>
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
