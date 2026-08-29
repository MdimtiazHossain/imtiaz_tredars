import { compile, render, patchChildren } from './template.js';

/**
 * Base class for a template-driven screen component.
 *
 * Mirrors the small surface the imported design's logic relies on:
 * `state`, `setState` (object or updater form), `props`, `renderVals()` and
 * `componentWillUnmount()`. Renders are batched onto an animation frame so a
 * burst of `setState` calls repaints once.
 */
export class Component {
  constructor(props) {
    this.props = props || {};
    this.state = {};
    this._root = null;
    this._tree = null;
    this._components = {};
    this._frame = 0;
    this._mounted = false;
  }

  /** Values exposed to the template. Subclasses override this. */
  renderVals() {
    return {};
  }

  /** Optional teardown hook; subclasses override it to clear timers. */
  componentWillUnmount() {}

  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    if (!next) return;
    this.state = Object.assign({}, this.state, next);
    this.scheduleRender();
  }

  scheduleRender() {
    if (!this._mounted || this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this.renderNow();
    });
  }

  /**
   * @param {HTMLElement} root      element the template renders into
   * @param {string} template       the component's own template source
   * @param {Record<string,string>} children  named templates for `dc-import`
   */
  mount(root, template, children) {
    this._root = root;
    this._tree = compile(template);
    this._components = {};
    for (const name of Object.keys(children || {})) {
      this._components[name] = compile(children[name]);
    }
    this._mounted = true;
    this.renderNow();
    return this;
  }

  renderNow() {
    if (!this._root || !this._tree) return;
    const vnodes = render(this._tree, this.renderVals(), this._components);
    patchChildren(this._root, vnodes);
  }

  unmount() {
    this._mounted = false;
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = 0;
    this.componentWillUnmount();
  }
}
