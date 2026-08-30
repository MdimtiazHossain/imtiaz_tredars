import { describe, it, expect, vi } from 'vitest';
import { cell, column, table } from '../src/components/dataTable.js';

describe('cell', () => {
  it('defaults to plain left-aligned text', () => {
    const c = cell('hello');
    expect(c.align).toBe('left');
    expect(c.plain).toBe(true);
    expect(c.badge).toBe(false);
    expect(c.just).toBe('flex-start');
  });

  it('maps alignment to flex justification', () => {
    expect(cell('x', { align: 'right' }).just).toBe('flex-end');
    expect(cell('x', { align: 'center' }).just).toBe('center');
  });

  it('switches off plain rendering when it is a badge', () => {
    const c = cell('Posted', { badge: true, badgeBg: '#eee', badgeFg: '#111' });
    expect(c.plain).toBe(false);
    expect(c.badgeBg).toBe('#eee');
  });

  it('uses the monospace face for figures', () => {
    expect(cell('123', { mono: true }).font).toContain('Roboto Mono');
    expect(cell('abc').font).toBe('inherit');
  });
});

describe('column', () => {
  it('is not interactive without a handler', () => {
    const c = column('Name');
    expect(c.cursor).toBe('default');
    expect(c.onClick).toBeNull();
  });

  it('becomes clickable when given a handler', () => {
    const c = column('Value', 'right', { onClick: () => {}, sortMark: '  ↓' });
    expect(c.cursor).toBe('pointer');
    expect(c.sortMark).toBe('  ↓');
  });
});

describe('table', () => {
  const cols = [column('A'), column('B')];
  const rows = Array.from({ length: 5 }, (_, i) => ({ cells: [cell('r' + i), cell(String(i))] }));

  it('reports the empty state when there are no rows', () => {
    const t = table(cols, []);
    expect(t.isEmpty).toBe(true);
    expect(t.emptyTitle).toBe('Nothing here yet');
  });

  it('carries the footer summary through', () => {
    const t = table(cols, rows, { footNote: '5 lines', footTotal: 'Total ৳100' });
    expect(t.footNote).toBe('5 lines');
    expect(t.footTotal).toBe('Total ৳100');
  });

  it('normalises rows so the template always has a background and cursor', () => {
    const t = table(cols, rows);
    expect(t.rows[0].bg).toBe('#fff');
    expect(t.rows[0].cursor).toBe('default');
  });

  it('marks a row interactive when it has its own handler', () => {
    const t = table(cols, [{ cells: [cell('x')], onClick: () => {} }]);
    expect(t.rows[0].cursor).toBe('pointer');
  });

  it('leaves selection and pagination dormant by default', () => {
    const t = table(cols, rows);
    expect(t.selectable).toBe(false);
    expect(t.pager).toBeNull();
  });

  it('accepts a bare array of cells as a row', () => {
    const t = table(cols, [[cell('a'), cell('b')]]);
    expect(t.rows[0].cells).toHaveLength(2);
  });

  describe('density', () => {
    it('uses comfortable padding by default', () => {
      expect(table(cols, rows).padY).toBe('11px');
    });

    it('tightens padding in compact mode', () => {
      expect(table(cols, rows, { density: 'compact' }).padY).toBe('6px');
    });
  });

  describe('pagination', () => {
    it('slices to the requested page', () => {
      const t = table(cols, rows, { page: { index: 0, size: 2, onPrev: () => {}, onNext: () => {} } });
      expect(t.rows).toHaveLength(2);
      expect(t.pager.label).toBe('Showing 1–2 of 5');
    });

    it('disables previous on the first page and next on the last', () => {
      const first = table(cols, rows, { page: { index: 0, size: 2, onPrev: () => {}, onNext: () => {} } });
      expect(first.pager.onPrev).toBeNull();
      expect(first.pager.onNext).not.toBeNull();

      const last = table(cols, rows, { page: { index: 2, size: 2, onPrev: () => {}, onNext: () => {} } });
      expect(last.pager.onNext).toBeNull();
      expect(last.pager.onPrev).not.toBeNull();
    });

    it('does not re-slice rows that are already one server page', () => {
      const t = table(cols, rows, {
        page: { index: 1, size: 5, total: 42, server: true, onPrev: () => {}, onNext: () => {} },
      });
      // All five rows given are shown, and the label reflects the server total.
      expect(t.rows).toHaveLength(5);
      expect(t.pager.label).toBe('Showing 6–10 of 42');
      expect(t.pager.onNext).not.toBeNull();
    });

    it('disables next on the last server page', () => {
      const t = table(cols, rows, {
        page: { index: 8, size: 5, total: 42, server: true, onPrev: () => {}, onNext: () => {} },
      });
      expect(t.pager.onNext).toBeNull();
      expect(t.pager.onPrev).not.toBeNull();
    });

    it('reports the empty state for a page past the end', () => {
      const t = table(cols, [], { page: { index: 0, size: 2, onPrev: () => {}, onNext: () => {} } });
      expect(t.isEmpty).toBe(true);
      expect(t.pager.label).toBe('Showing 0–0 of 0');
    });
  });

  describe('selection', () => {
    const withIds = rows.map((r, i) => ({ ...r, id: 'row-' + i }));

    it('marks selected rows and counts them', () => {
      const t = table(cols, withIds, {
        selectable: true,
        selected: new Set(['row-1', 'row-3']),
        onSelect: () => {},
      });
      expect(t.selectedCount).toBe(2);
      expect(t.rows[1].selected).toBe(true);
      expect(t.rows[0].selected).toBe(false);
    });

    it('reports allSelected only when every row is selected', () => {
      const all = new Set(withIds.map((r) => r.id));
      expect(table(cols, withIds, { selectable: true, selected: all }).allSelected).toBe(true);
      expect(
        table(cols, withIds, { selectable: true, selected: new Set(['row-0']) }).allSelected
      ).toBe(false);
    });

    it('invokes onSelect with the row id', () => {
      const onSelect = vi.fn();
      const t = table(cols, withIds, { selectable: true, selected: new Set(), onSelect });
      t.rows[2].onSelect();
      expect(onSelect).toHaveBeenCalledWith('row-2');
    });
  });
});
