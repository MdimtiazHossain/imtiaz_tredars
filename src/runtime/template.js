/**
 * Minimal template runtime for the `.dc.html` dialect used by the imported
 * Claude Design project.
 *
 * Supported directives (this is the complete set the design uses):
 *   {{ path }}                              interpolation, in text and attributes
 *   <sc-for list="{{ path }}" as="name">    scoped iteration
 *   <sc-if value="{{ path }}">              conditional
 *   <dc-import name="X" t="{{ path }}">     child component with props
 *   style-hover="css"                       hover-only style overlay
 *   onClick / onChange                      event bindings resolved from scope
 *   value="{{ path }}"                      form-control value binding
 *
 * Templates are parsed as XML rather than HTML because `<sc-for>` appears
 * inside `<tr>`/`<tbody>`, where the HTML parser would foster-parent unknown
 * elements out of the table and destroy the structure.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const INTERP = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Resolve a dotted path such as `a.b.c` against a scope object. */
export function resolve(scope, path) {
  if (path === 'true') return true;
  if (path === 'false') return false;
  let cur = scope;
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Split a string into literal / interpolation parts. */
function splitParts(text) {
  const parts = [];
  let last = 0;
  INTERP.lastIndex = 0;
  let m;
  while ((m = INTERP.exec(text))) {
    if (m.index > last) parts.push({ lit: text.slice(last, m.index) });
    parts.push({ path: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ lit: text.slice(last) });
  return parts;
}

/** Return the single interpolated path when the value is exactly one `{{ }}`. */
function soleInterp(text) {
  const m = /^\{\{\s*([^}]*?)\s*\}\}$/.exec(text.trim());
  return m ? m[1] : null;
}

function renderParts(parts, scope) {
  let out = '';
  for (const p of parts) {
    if (p.lit !== undefined) {
      out += p.lit;
    } else {
      const v = resolve(scope, p.path);
      out += v == null ? '' : String(v);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ compile */

function compileNode(node, ns) {
  if (node.nodeType === 3) {
    const text = node.nodeValue;
    if (!text.trim() && !text.includes('{{')) return null;
    return { k: 'text', parts: splitParts(text) };
  }
  if (node.nodeType !== 1) return null;

  const tag = node.tagName;

  if (tag === 'sc-for') {
    return {
      k: 'for',
      listPath: soleInterp(node.getAttribute('list') || '') || '',
      as: node.getAttribute('as') || 'it',
      children: compileChildren(node, ns),
    };
  }
  if (tag === 'sc-if') {
    return {
      k: 'if',
      valPath: soleInterp(node.getAttribute('value') || '') || '',
      children: compileChildren(node, ns),
    };
  }
  if (tag === 'dc-import') {
    const props = {};
    for (const a of Array.from(node.attributes)) {
      if (a.name === 'name' || a.name.startsWith('hint-')) continue;
      props[a.name] = soleInterp(a.value);
    }
    return { k: 'import', name: node.getAttribute('name'), props };
  }

  const childNs = tag === 'svg' ? SVG_NS : ns;
  const el = {
    k: 'el',
    tag,
    ns: childNs,
    attrs: [],
    events: [],
    hover: null,
    valuePath: null,
    checkedPath: null,
  };

  for (const a of Array.from(node.attributes)) {
    const name = a.name;
    const value = a.value;
    if (name.startsWith('hint-')) continue;
    if (name === 'style-hover') {
      el.hover = value;
      continue;
    }
    if (name === 'onClick' || name === 'onChange') {
      el.events.push({
        type: name === 'onClick' ? 'click' : 'change',
        path: soleInterp(value),
      });
      continue;
    }
    if (name === 'value' && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      el.valuePath = soleInterp(value);
      if (el.valuePath === null) el.attrs.push({ name, parts: splitParts(value) });
      continue;
    }
    if (name === 'checked' && tag === 'input') {
      el.checkedPath = soleInterp(value);
      continue;
    }
    const sole = soleInterp(value);
    el.attrs.push(sole !== null ? { name, path: sole } : { name, parts: splitParts(value) });
  }

  el.children = compileChildren(node, childNs);
  return el;
}

function compileChildren(node, ns) {
  const out = [];
  for (const child of Array.from(node.childNodes)) {
    const c = compileNode(child, ns);
    if (c) out.push(c);
  }
  return out;
}

/** Compile a template string into an instruction tree. */
export function compile(source) {
  const doc = new DOMParser().parseFromString('<root>' + source + '</root>', 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('Template parse error: ' + err.textContent.slice(0, 300));
  return compileChildren(doc.documentElement, null);
}

/* ------------------------------------------------------------------- render */

/**
 * Turn an instruction tree into a vnode tree.
 * `components` maps a `dc-import` name to a compiled instruction tree.
 */
export function render(nodes, scope, components) {
  const out = [];
  for (const n of nodes) emit(n, scope, components, out);
  return out;
}

function emit(n, scope, components, out) {
  if (n.k === 'text') {
    const v = renderParts(n.parts, scope);
    if (v) out.push({ t: '#text', v });
    return;
  }

  if (n.k === 'if') {
    if (resolve(scope, n.valPath)) {
      for (const c of n.children) emit(c, scope, components, out);
    }
    return;
  }

  if (n.k === 'for') {
    const list = resolve(scope, n.listPath);
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const inner = Object.create(scope);
      inner[n.as] = item;
      for (const c of n.children) emit(c, inner, components, out);
    }
    return;
  }

  if (n.k === 'import') {
    const tree = components && components[n.name];
    if (!tree) return;
    const inner = {};
    for (const key of Object.keys(n.props)) {
      const path = n.props[key];
      inner[key] = path === null ? null : resolve(scope, path);
    }
    for (const c of tree) emit(c, inner, components, out);
    return;
  }

  const vnode = {
    t: n.tag,
    ns: n.ns,
    attrs: {},
    on: {},
    hover: n.hover,
    value: undefined,
    checked: undefined,
    children: render(n.children, scope, components),
  };

  for (const a of n.attrs) {
    const v = a.path !== undefined ? resolve(scope, a.path) : renderParts(a.parts, scope);
    if (v !== undefined && v !== null && v !== false) vnode.attrs[a.name] = String(v);
  }
  for (const e of n.events) {
    const fn = e.path === null ? null : resolve(scope, e.path);
    if (typeof fn === 'function') vnode.on[e.type] = fn;
  }
  if (n.valuePath !== null && n.valuePath !== undefined) {
    const v = resolve(scope, n.valuePath);
    vnode.value = v == null ? '' : String(v);
  }
  if (n.checkedPath !== null && n.checkedPath !== undefined) {
    vnode.checked = !!resolve(scope, n.checkedPath);
  }

  out.push(vnode);
}

/* -------------------------------------------------------------------- patch */

function createEl(vnode) {
  const el = vnode.ns
    ? document.createElementNS(vnode.ns, vnode.t)
    : document.createElement(vnode.t);
  el.__vn = null;
  return el;
}

/**
 * Attach a stable listener that dispatches to the latest handler, so
 * re-rendering never detaches and reattaches listeners.
 */
function bindEvent(el, type) {
  if (!el.__on) el.__on = {};
  if (!el.__bound) el.__bound = {};
  if (el.__bound[type]) return;
  el.__bound[type] = true;
  const domType = type === 'change' && el.tagName !== 'SELECT' ? 'input' : type;
  el.addEventListener(domType, (ev) => {
    const fn = el.__on && el.__on[type];
    if (fn) fn(ev);
  });
}

function applyHover(el, css) {
  el.__hoverCss = css;
  if (el.__hoverBound) return;
  el.__hoverBound = true;
  el.addEventListener('mouseenter', () => {
    if (!el.__hoverCss) return;
    el.__baseStyle = el.getAttribute('style') || '';
    el.setAttribute('style', el.__baseStyle + ';' + el.__hoverCss);
  });
  el.addEventListener('mouseleave', () => {
    if (el.__baseStyle !== undefined) el.setAttribute('style', el.__baseStyle);
  });
}

function patchEl(el, vnode) {
  const prev = el.__vn || { attrs: {}, on: {} };

  for (const k of Object.keys(vnode.attrs)) {
    if (prev.attrs[k] !== vnode.attrs[k]) el.setAttribute(k, vnode.attrs[k]);
  }
  for (const k of Object.keys(prev.attrs)) {
    if (!(k in vnode.attrs)) el.removeAttribute(k);
  }

  if (!el.__on) el.__on = {};
  for (const type of Object.keys(vnode.on)) {
    el.__on[type] = vnode.on[type];
    bindEvent(el, type);
  }
  for (const type of Object.keys(el.__on)) {
    if (!(type in vnode.on)) el.__on[type] = null;
  }

  if (vnode.hover) applyHover(el, vnode.hover);

  patchChildren(el, vnode.children);

  // Set after children so a <select> can match a freshly rendered <option>,
  // and never while focused so typing is not interrupted.
  if (vnode.value !== undefined && el.value !== vnode.value && document.activeElement !== el) {
    el.value = vnode.value;
  }
  if (vnode.checked !== undefined && el.checked !== vnode.checked) {
    el.checked = vnode.checked;
  }

  el.__vn = vnode;
}

/** Patch a list of vnodes onto a parent element, reusing nodes by position. */
export function patchChildren(parent, vnodes) {
  const dom = parent.childNodes;

  for (let i = 0; i < vnodes.length; i++) {
    const vn = vnodes[i];
    let node = dom[i];
    const isText = vn.t === '#text';

    // HTML elements report an uppercase tagName while the XML-parsed template
    // preserves the source casing, so compare case-insensitively -- otherwise
    // every element is replaced on each render and focus is lost while typing.
    const matches =
      node &&
      (isText
        ? node.nodeType === 3
        : node.nodeType === 1 && node.tagName.toLowerCase() === vn.t.toLowerCase());

    if (!matches) {
      const fresh = isText ? document.createTextNode(vn.v) : createEl(vn);
      if (node) parent.replaceChild(fresh, node);
      else parent.appendChild(fresh);
      node = fresh;
    }

    if (isText) {
      if (node.nodeValue !== vn.v) node.nodeValue = vn.v;
    } else {
      patchEl(node, vn);
    }
  }

  while (dom.length > vnodes.length) parent.removeChild(dom[dom.length - 1]);
}
