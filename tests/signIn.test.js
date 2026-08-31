import { describe, it, expect, beforeEach } from 'vitest';
import { renderSignIn } from '../src/app/signIn.js';

/**
 * The sign-in card.
 *
 * It is the first thing anyone sees, and the only screen drawn before there is
 * a session to read anything from. The business it names came from a constant
 * until the API grew an endpoint to ask -- which meant an installation for one
 * business greeted its staff with the name of another.
 */

/** Render the card and hand back the pieces the assertions need. */
function mount(context, onSubmit = async () => ({})) {
  const root = document.createElement('div');
  document.body.append(root);
  const signedIn = renderSignIn(root, onSubmit, context);
  return {
    root,
    signedIn,
    form: /** @type {HTMLFormElement} */ (root.querySelector('form')),
    error: /** @type {HTMLElement} */ (root.querySelector('[data-error]')),
    field: (name) =>
      /** @type {HTMLInputElement} */ (root.querySelector(`input[name=${name}]`)),
  };
}

describe('sign-in card', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('names the business the server said it belongs to', async () => {
    const { root } = mount({ name: 'Imtiaz Tredars', systemName: 'Business Suite' });

    expect(root.textContent).toContain('Imtiaz Tredars');
    expect(root.textContent).toContain('Business Suite');
    // The badge is the business's own initial, not a letter left over from
    // whichever business this was first built for.
    expect(root.textContent).not.toContain('Meghna');
    expect(root.querySelector('form > div > div').textContent.trim()).toBe('I');
  });

  it('falls back to something honest when the server could not be asked', async () => {
    // A null context means the endpoint failed, in which case signing in is
    // not going to work either; the card still draws rather than blanking.
    const { root } = mount(null);

    expect(root.querySelector('form')).not.toBeNull();
    expect(root.textContent).toContain('Business Suite');
    expect(root.textContent).not.toContain('undefined');
  });

  it('does not let a business name inject markup into the card', async () => {
    const { root } = mount({ name: '<img src=x onerror="alert(1)">Acme', systemName: 'Suite' });

    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">Acme');
  });

  it('asks for both fields before it tries the server', async () => {
    let called = false;
    const { form, error, field } = mount({ name: 'Imtiaz Tredars' }, async () => {
      called = true;
      return {};
    });

    field('username').value = 'rakib01';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    expect(called).toBe(false);
    expect(error.textContent).toBe('Enter your username and password.');
  });

  it('resolves with the user the sign-in returned', async () => {
    const user = { id: 1, name: 'Rakib Hasan', role: 'Admin' };
    const { form, field, signedIn } = mount({ name: 'Imtiaz Tredars' }, async () => user);

    field('username').value = 'rakib01';
    field('password').value = 'whatever-they-typed';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await expect(signedIn).resolves.toBe(user);
  });

  it('shows what the server said went wrong, and clears the password', async () => {
    const { form, field, error } = mount({ name: 'Imtiaz Tredars' }, async () => {
      throw new Error('Username or password is incorrect.');
    });

    field('username').value = 'rakib01';
    field('password').value = 'the-wrong-one';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(error.textContent).toBe('Username or password is incorrect.');
    // Nothing is left in the field for the next person at the machine.
    expect(field('password').value).toBe('');
  });
});
