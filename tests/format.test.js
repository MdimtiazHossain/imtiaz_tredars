import { describe, it, expect } from 'vitest';
import { money, int, dec2, lakh, shortDate, periodLabel } from '../src/domain/format.js';

/**
 * How figures and dates are written down.
 *
 * The formatting is not decoration: money is grouped the way Bangladeshi
 * accounting groups it, and a date is read out of the string rather than
 * through a Date so a midnight timestamp does not slip a day east of
 * Greenwich. Both have been wrong here before.
 */

describe('money', () => {
  it('groups in lakh and crore, as the market writes it', () => {
    expect(money(3020000)).toBe('৳30,20,000');
    expect(money(1000)).toBe('৳1,000');
    expect(money(0)).toBe('৳0');
  });

  it('rounds unless asked for decimals', () => {
    expect(money(1234.56)).toBe('৳1,235');
    expect(money(1234.56, 2)).toBe('৳1,234.56');
  });

  it('reads a missing amount as nothing rather than as NaN', () => {
    expect(money(null)).toBe('৳0');
    expect(money(undefined)).toBe('৳0');
  });
});

describe('int, dec2 and lakh', () => {
  it('groups whole numbers the same way', () => {
    expect(int(2460000)).toBe('24,60,000');
  });

  it('always shows two decimals for a quantity', () => {
    expect(dec2(12.5)).toBe('12.50');
    expect(dec2(0)).toBe('0.00');
  });

  it('condenses to lakh, then to crore', () => {
    expect(lakh(2460000)).toBe('৳24.60 L');
    expect(lakh(18700000)).toBe('৳1.87 Cr');
  });
});

describe('shortDate', () => {
  it('reads the calendar parts out of the string, not out of a Date', () => {
    // Midnight UTC is the previous evening in Dhaka; the date must not move.
    expect(shortDate('2026-08-31T00:00:00.000Z')).toBe('31 Aug');
    expect(shortDate('2026-08-31')).toBe('31 Aug');
  });

  it('has something to say about a missing date', () => {
    expect(shortDate(null)).toBe('—');
    expect(shortDate('')).toBe('—');
  });
});

describe('periodLabel', () => {
  it('names a whole calendar month by its month', () => {
    expect(periodLabel({ from: '2026-08-01', to: '2026-08-31' })).toBe('August 2026');
    expect(periodLabel({ from: '2026-02-01', to: '2026-02-28' })).toBe('February 2026');
  });

  it('handles a leap February, which is a whole month too', () => {
    expect(periodLabel({ from: '2028-02-01', to: '2028-02-29' })).toBe('February 2028');
    expect(periodLabel({ from: '2026-02-01', to: '2026-02-28' })).toBe('February 2026');
  });

  it('does not call a part of a month the whole month', () => {
    expect(periodLabel({ from: '2026-08-01', to: '2026-08-20' })).toBe('1 – 20 August 2026');
  });

  it('states a range within one year once', () => {
    expect(periodLabel({ from: '2026-01-01', to: '2026-03-31' })).toBe('1 Jan – 31 Mar 2026');
  });

  it('spells out a range that crosses a year', () => {
    expect(periodLabel({ from: '2025-11-05', to: '2026-03-31' })).toBe('5 Nov 2025 – 31 Mar 2026');
  });

  it('says what it covers when it was given no dates at all', () => {
    expect(periodLabel({ from: null, to: null })).toBe('all posted transactions');
    expect(periodLabel(null)).toBe('all posted transactions');
  });
});
