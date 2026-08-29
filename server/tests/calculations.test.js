import { describe, it, expect } from 'vitest';
import { computeLandedCost } from '../src/services/cropPurchaseService.js';
import { planAllocation, averageCost } from '../src/services/fifoService.js';
import { computePurchaseTotals, computeSaleTotals } from '../src/services/dealerService.js';
import { addDays } from '../src/services/financeService.js';

/**
 * Server-side arithmetic. These run with no database, and deliberately assert
 * the same numbers the frontend's own tests assert, because the figure shown on
 * the form and the figure posted to the ledger must agree.
 */

describe('landed cost', () => {
  it('matches the worked example the purchase screen opens on', () => {
    const result = computeLandedCost({
      lines: [{ cropId: 1, unitId: 1, grossQuantity: 100, moisturePct: 1.5, rate: 30000 }],
      transportCost: 50000,
      loadingCost: 12000,
      unloadingCost: 8000,
      otherCost: 0,
    });

    const line = result.lines[0];
    expect(line.netQuantity).toBe(98.5);
    expect(result.purchaseValue).toBe(2955000);
    expect(result.netAmount).toBe(3025000);
    expect(line.costPerUnit).toBeCloseTo(30710.66, 2);
  });

  it('never uses the static mockup figure of 30,761', () => {
    const { lines } = computeLandedCost({
      lines: [{ grossQuantity: 100, moisturePct: 1.5, rate: 30000 }],
      transportCost: 50000,
      loadingCost: 12000,
      unloadingCost: 8000,
    });
    expect(Math.round(lines[0].costPerUnit)).toBe(30711);
  });

  it('apportions incidental cost across lines by value', () => {
    const result = computeLandedCost({
      lines: [
        { grossQuantity: 100, moisturePct: 0, rate: 300 },
        { grossQuantity: 100, moisturePct: 0, rate: 100 },
      ],
      transportCost: 4000,
    });

    // Line values are 30,000 and 10,000, so freight splits 3:1.
    expect(result.lines[0].allocatedCost).toBeCloseTo(3000, 6);
    expect(result.lines[1].allocatedCost).toBeCloseTo(1000, 6);
    expect(result.netAmount).toBe(44000);
  });

  it('reduces quantity by the moisture deduction', () => {
    const { lines } = computeLandedCost({
      lines: [{ grossQuantity: 200, moisturePct: 2.5, rate: 100 }],
    });
    expect(lines[0].deductionQty).toBe(5);
    expect(lines[0].netQuantity).toBe(195);
  });

  it('does not divide by zero on an empty form', () => {
    const { lines } = computeLandedCost({ lines: [{ grossQuantity: 0, rate: 0 }] });
    expect(lines[0].costPerUnit).toBe(0);
  });
});

describe('FIFO allocation', () => {
  const pool = [
    { id: 1, batchNo: 'B1', warehouseId: 1, quantityRemaining: 100, costPerUnit: 30000 },
    { id: 2, batchNo: 'B2', warehouseId: 1, quantityRemaining: 50, costPerUnit: 32000 },
  ];

  it('draws 120 MT as 100 from the older batch and 20 from the newer', () => {
    const plan = planAllocation(pool, 120, 'FIFO');
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0]).toMatchObject({ batchNo: 'B1', quantity: 100 });
    expect(plan.lines[1]).toMatchObject({ batchNo: 'B2', quantity: 20 });
    expect(plan.shortfall).toBe(0);
  });

  it('costs each batch at its own landed cost', () => {
    const plan = planAllocation(pool, 120, 'FIFO');
    // 100 * 30,000 + 20 * 32,000
    expect(plan.cogs).toBe(3_640_000);
  });

  it('costs everything at the pool average under weighted average', () => {
    const plan = planAllocation(pool, 120, 'WEIGHTED_AVERAGE');
    // (100*30000 + 50*32000) / 150
    expect(averageCost(pool)).toBeCloseTo(30666.67, 2);
    expect(plan.cogs).toBeCloseTo(120 * 30666.666666, 2);
  });

  it('reports a shortfall rather than overselling', () => {
    const plan = planAllocation(pool, 200, 'FIFO');
    expect(plan.allocated).toBe(150);
    expect(plan.shortfall).toBe(50);
  });

  it('takes nothing for a zero quantity', () => {
    expect(planAllocation(pool, 0, 'FIFO').lines).toHaveLength(0);
  });

  it('leaves the older batch empty and the newer partly used', () => {
    const plan = planAllocation(pool, 120, 'FIFO');
    const remaining = new Map(pool.map((b) => [b.batchNo, b.quantityRemaining]));
    for (const line of plan.lines) {
      remaining.set(line.batchNo, remaining.get(line.batchNo) - line.quantity);
    }
    expect(remaining.get('B1')).toBe(0);
    expect(remaining.get('B2')).toBe(30);
  });
});

describe('dealer totals', () => {
  it('adds incidental cost on top of the discounted purchase', () => {
    const t = computePurchaseTotals({
      lines: [{ quantity: 100, rate: 10, discountPct: 5, freeQuantity: 4 }],
      transportCost: 200,
      otherCost: 50,
    });
    expect(t.gross).toBe(1000);
    expect(t.discount).toBe(50);
    expect(t.net).toBe(1200);
    expect(t.freeQuantity).toBe(4);
  });

  it('derives sale profit from the weighted-average cost', () => {
    const t = computeSaleTotals(
      { lines: [{ productId: 1, quantity: 10, rate: 200, discountPct: 10, bonusQuantity: 0 }], paidAmount: 500 },
      () => 100
    );
    expect(t.gross).toBe(2000);
    expect(t.net).toBe(1800);
    expect(t.cost).toBe(1000);
    expect(t.profit).toBe(800);
    expect(t.due).toBe(1300);
  });

  it('charges bonus quantity to cost but not to revenue', () => {
    const t = computeSaleTotals(
      { lines: [{ productId: 1, quantity: 10, rate: 100, discountPct: 0, bonusQuantity: 2 }], paidAmount: 0 },
      () => 50
    );
    expect(t.net).toBe(1000);
    expect(t.cost).toBe(600);
  });

  it('returns zero margin for an empty invoice rather than NaN', () => {
    const t = computeSaleTotals({ lines: [], paidAmount: 0 }, () => 0);
    expect(t.margin).toBe(0);
  });
});

describe('due dates', () => {
  it('adds credit days to the invoice date', () => {
    expect(addDays('2026-08-28', 15)).toBe('2026-09-12');
  });

  it('crosses a year boundary correctly', () => {
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
  });

  it('treats no credit days as due immediately', () => {
    expect(addDays('2026-08-28', 0)).toBe('2026-08-28');
  });
});
