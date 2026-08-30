import { C, SURFACE, MONO } from '../styles/tokens.js';

/**
 * Model builders for the reusable DataTable component.
 *
 * The component is driven entirely by the plain object `table()` returns, so it
 * is page-agnostic: any screen can build a model and hand it to
 * `<dc-import name="DataTable" t="{{ ... }}">` without the table knowing
 * anything about that screen.
 *
 * Sorting, sticky headers, the empty state and the footer summary are always
 * available. Row selection and pagination are opt-in and stay dormant unless a
 * caller asks for them, so screens that mirror the imported design render
 * exactly as designed.
 */

/**
 * Build one table cell.
 *
 * @param {string|number} text        cell text
 * @param {object} [o]
 * @param {'left'|'right'|'center'} [o.align='left']
 * @param {boolean} [o.mono]          use the monospace face (figures, codes)
 * @param {string}  [o.weight='400']
 * @param {string}  [o.color]
 * @param {string}  [o.size='13px']
 * @param {string}  [o.sub]           secondary line under the value
 * @param {string}  [o.dot]           colour of a leading status dot
 * @param {boolean} [o.badge]         render as a pill instead of plain text
 * @param {string}  [o.badgeBg]
 * @param {string}  [o.badgeFg]
 */
export function cell(text, o) {
  o = o || {};
  const x = {
    text: text,
    align: o.align || 'left',
    plain: !o.badge,
    font: o.mono ? MONO : 'inherit',
    weight: o.weight || '400',
    color: o.color || C.ink,
    size: o.size || '13px',
    sub: o.sub || '',
    dot: o.dot || '',
    badge: !!o.badge,
    badgeBg: o.badgeBg || SURFACE.badgeBg,
    badgeFg: o.badgeFg || SURFACE.badgeFg,
  };
  x.just = x.align === 'right' ? 'flex-end' : x.align === 'center' ? 'center' : 'flex-start';
  return x;
}

/**
 * Build one column header. Passing `onClick` makes the header interactive;
 * `sortMark` is the caller's indicator for the active sort direction.
 */
export function column(label, align, o) {
  o = o || {};
  return {
    label: label,
    align: align || 'left',
    cursor: o.onClick ? 'pointer' : 'default',
    onClick: o.onClick || null,
    sortMark: o.sortMark || '',
  };
}

/** Normalise a row so every field the template reads is present. */
function normaliseRow(row, index, options) {
  const cells = Array.isArray(row) ? row : row.cells;
  const base = Array.isArray(row) ? {} : row;
  const selected = options.selected ? options.selected.has(base.id ?? index) : false;

  return {
    cells: cells,
    id: base.id ?? index,
    bg: selected ? C.accBg : base.bg || '#fff',
    cursor: base.onClick ? 'pointer' : 'default',
    onClick: base.onClick || null,
    selectable: !!options.selectable,
    selected: selected,
    onSelect: options.selectable && options.onSelect ? () => options.onSelect(base.id ?? index) : null,
  };
}

/**
 * Build the table model.
 *
 * @param {Array} cols  columns from `column()`
 * @param {Array} rows  rows as `{cells}` or a bare array of cells
 * @param {object} [o]
 * @param {string}  [o.emptyTitle]
 * @param {string}  [o.emptyNote]
 * @param {string}  [o.footNote]     left-hand footer summary
 * @param {string}  [o.footTotal]    right-hand footer figure
 * @param {string}  [o.maxH='none']  scroll height; the header stays stuck
 * @param {boolean} [o.selectable]   opt in to the checkbox column
 * @param {Set}     [o.selected]     currently selected row ids
 * @param {Function}[o.onSelect]     called with a row id when toggled
 * @param {Function}[o.onSelectAll]
 * @param {object}  [o.page]         `{index, size, onPrev, onNext}`; add
 *                                   `total` and `server: true` when the rows
 *                                   passed in are already one page from a
 *                                   server, so they are not sliced again
 * @param {'comfortable'|'compact'} [o.density='comfortable']
 */
export function table(cols, rows, o) {
  o = o || {};
  const selectable = !!o.selectable;
  const selected = o.selected instanceof Set ? o.selected : null;
  const all = rows.map((r, i) =>
    normaliseRow(r, i, { selectable, selected, onSelect: o.onSelect })
  );

  const page = o.page || null;
  // Server-paged rows are already the page; slicing them again would show a
  // page of a page.
  const visible =
    page && !page.server
      ? all.slice(page.index * page.size, page.index * page.size + page.size)
      : all;
  const pageTotal = page ? (page.total ?? all.length) : all.length;

  const everySelected = selectable && all.length > 0 && all.every((r) => r.selected);

  return {
    cols: cols,
    rows: visible,
    isEmpty: visible.length === 0,
    emptyTitle: o.emptyTitle || 'Nothing here yet',
    emptyNote: o.emptyNote || 'Adjust the filters or create the first record.',
    footNote: o.footNote || '',
    footTotal: o.footTotal || '',
    maxH: o.maxH || 'none',
    padY: o.density === 'compact' ? '6px' : '11px',
    headPadY: o.density === 'compact' ? '7px' : '10px',
    selectable: selectable,
    allSelected: everySelected,
    onSelectAll: selectable && o.onSelectAll ? o.onSelectAll : null,
    selectedCount: selectable ? all.filter((r) => r.selected).length : 0,
    pager: page
      ? {
          label:
            'Showing ' +
            (pageTotal === 0 ? 0 : page.index * page.size + 1) +
            '–' +
            Math.min(pageTotal, (page.index + 1) * page.size) +
            ' of ' +
            pageTotal,
          onPrev: page.index > 0 ? page.onPrev : null,
          onNext: (page.index + 1) * page.size < pageTotal ? page.onNext : null,
          prevColor: page.index > 0 ? C.ink : SURFACE.faint,
          nextColor: (page.index + 1) * page.size < pageTotal ? C.ink : SURFACE.faint,
        }
      : null,
  };
}
