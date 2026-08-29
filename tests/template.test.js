import { describe, it, expect } from 'vitest';
import { compile, render, patchChildren, resolve } from '../src/runtime/template.js';

/** Compile + render + patch a template into a detached container. */
function mount(source, scope, components) {
  const host = document.createElement('div');
  patchChildren(host, render(compile(source), scope, components));
  return host;
}

describe('resolve', () => {
  it('walks a dotted path', () => {
    expect(resolve({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });

  it('returns undefined instead of throwing on a missing branch', () => {
    expect(resolve({ a: null }, 'a.b.c')).toBeUndefined();
  });

  it('understands the literal booleans the design uses in hints', () => {
    expect(resolve({}, 'true')).toBe(true);
    expect(resolve({}, 'false')).toBe(false);
  });
});

describe('interpolation', () => {
  it('substitutes into text mixed with literals', () => {
    const host = mount('<p>{{ a }} · {{ b }}</p>', { a: 'x', b: 'y' });
    expect(host.querySelector('p').textContent).toBe('x · y');
  });

  it('substitutes inside an attribute', () => {
    const host = mount('<div style="height:{{ h }}"></div>', { h: '12px' });
    expect(host.querySelector('div').getAttribute('style')).toBe('height:12px');
  });

  it('renders a missing value as empty rather than "undefined"', () => {
    const host = mount('<p>[{{ nope }}]</p>', {});
    expect(host.querySelector('p').textContent).toBe('[]');
  });
});

describe('sc-for', () => {
  it('repeats children under a scoped alias', () => {
    const host = mount('<ul><sc-for list="{{ xs }}" as="x"><li>{{ x.n }}</li></sc-for></ul>', {
      xs: [{ n: 'a' }, { n: 'b' }, { n: 'c' }],
    });
    expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('renders nothing when the list is absent', () => {
    const host = mount('<ul><sc-for list="{{ missing }}" as="x"><li>x</li></sc-for></ul>', {});
    expect(host.querySelectorAll('li')).toHaveLength(0);
  });

  it('keeps outer scope visible inside the loop', () => {
    const host = mount(
      '<ul><sc-for list="{{ xs }}" as="x"><li>{{ prefix }}{{ x }}</li></sc-for></ul>',
      { prefix: '#', xs: ['1', '2'] }
    );
    expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['#1', '#2']);
  });

  it('survives inside a table body, where HTML parsing would foster-parent it', () => {
    const host = mount(
      '<table><tbody><sc-for list="{{ rows }}" as="r"><tr><td>{{ r }}</td></tr></sc-for></tbody></table>',
      { rows: ['a', 'b'] }
    );
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(host.querySelector('tbody tr td').textContent).toBe('a');
  });
});

describe('sc-if', () => {
  it('renders children only when truthy', () => {
    expect(mount('<sc-if value="{{ on }}"><b>yes</b></sc-if>', { on: true }).querySelector('b')).not.toBeNull();
    expect(mount('<sc-if value="{{ on }}"><b>yes</b></sc-if>', { on: false }).querySelector('b')).toBeNull();
  });

  it('treats an empty string as falsy, matching the design usage', () => {
    expect(mount('<sc-if value="{{ s }}"><b>x</b></sc-if>', { s: '' }).querySelector('b')).toBeNull();
  });
});

describe('dc-import', () => {
  it('renders the named child template with the given props', () => {
    const host = mount('<div><dc-import name="Card" t="{{ model }}"></dc-import></div>', { model: { label: 'hello' } }, {
      Card: compile('<span>{{ t.label }}</span>'),
    });
    expect(host.querySelector('span').textContent).toBe('hello');
  });

  it('renders nothing when the component is not registered', () => {
    const host = mount('<div><dc-import name="Nope" t="{{ m }}"></dc-import></div>', { m: {} }, {});
    expect(host.querySelector('div').children).toHaveLength(0);
  });
});

describe('events and form bindings', () => {
  it('dispatches clicks to the handler resolved from scope', () => {
    let hits = 0;
    const host = mount('<button onClick="{{ go }}">go</button>', { go: () => (hits += 1) });
    host.querySelector('button').click();
    expect(hits).toBe(1);
  });

  it('binds a value onto a form control as a property', () => {
    const host = mount('<input value="{{ v }}" />', { v: 'typed' });
    expect(host.querySelector('input').value).toBe('typed');
  });

  it('binds checked state onto a checkbox', () => {
    const host = mount('<input type="checkbox" checked="{{ on }}" />', { on: true });
    expect(host.querySelector('input').checked).toBe(true);
  });
});

describe('patching', () => {
  it('reuses the same element across renders so focus is not lost', () => {
    const tree = compile('<div><input value="{{ v }}" /></div>');
    const host = document.createElement('div');
    patchChildren(host, render(tree, { v: 'a' }, {}));
    const first = host.querySelector('input');
    patchChildren(host, render(tree, { v: 'b' }, {}));
    expect(host.querySelector('input')).toBe(first);
  });

  it('adds and removes rows as a list grows and shrinks', () => {
    const tree = compile('<ul><sc-for list="{{ xs }}" as="x"><li>{{ x }}</li></sc-for></ul>');
    const host = document.createElement('div');
    patchChildren(host, render(tree, { xs: ['a'] }, {}));
    expect(host.querySelectorAll('li')).toHaveLength(1);
    patchChildren(host, render(tree, { xs: ['a', 'b', 'c'] }, {}));
    expect(host.querySelectorAll('li')).toHaveLength(3);
    patchChildren(host, render(tree, { xs: [] }, {}));
    expect(host.querySelectorAll('li')).toHaveLength(0);
  });

  it('keeps the latest handler after a re-render', () => {
    const tree = compile('<button onClick="{{ go }}">x</button>');
    const host = document.createElement('div');
    let which = '';
    patchChildren(host, render(tree, { go: () => (which = 'first') }, {}));
    patchChildren(host, render(tree, { go: () => (which = 'second') }, {}));
    host.querySelector('button').click();
    expect(which).toBe('second');
  });

  it('creates svg children in the svg namespace', () => {
    const host = mount('<svg><path d="M0 0"></path></svg>', {});
    expect(host.querySelector('path').namespaceURI).toBe('http://www.w3.org/2000/svg');
  });
});
