import { describe, it, expect } from 'vitest';
import {
  landedCost,
  availableBatches,
  averageCost,
  allocateFifo,
  cropSaleResult,
  dealerSaleTotals,
  dealerPurchaseTotals,
  effectiveRate,
} from '../src/domain/calculations.js';

describe('landedCost', () => {
  it('absorbs incidental expense into the per-unit cost', () => {
    // The worked example the design's crop purchase screen opens on.
    const r = landedCost({
      qty: 100,
      moisture: 1.5,
      rate: 30000,
      transport: 50000,
      loading: 12000,
      unloading: 8000,
      other: 0,
    });

    expect(r.net).toBe(98.5);
    expect(r.purchaseValue).toBe(2955000);
    expect(r.additional).toBe(70000);
    expect(r.total).toBe(3025000);
    expect(r.costPerUnit).toBeCloseTo(30710.66, 2);
  });

  it('is safe on an empty form rather than dividing by zero', () => {
    const r = landedCost({});
    expect(r.net).toBe(0);
    expect(r.costPerUnit).toBe(0);
  });

  it('raises the per-unit cost above the quoted rate', () => {
    const r = landedCost({ qty: 10, rate: 100, transport: 50 });
    expect(r.costPerUnit).toBeGreaterThan(100);
  });
});

describe('batch pool', () => {
  const batches = [
    { id: 'A', crop: 'Maize', rem: 10, cost: 100, age: 5 },
    { id: 'B', crop: 'Maize', rem: 20, cost: 200, age: 30 },
    { id: 'C', crop: 'Maize', rem: 0, cost: 300, age: 90 },
    { id: 'D', crop: 'Wheat', rem: 5, cost: 400, age: 2 },
  ];

  it('lists only stocked batches of the crop, oldest first', () => {
    const pool = availableBatches(batches, 'Maize');
    expect(pool.map((b) => b.id)).toEqual(['B', 'A']);
  });

  it('weights average cost by remaining quantity', () => {
    const pool = availableBatches(batches, 'Maize');
    // (200*20 + 100*10) / 30
    expect(averageCost(pool)).toBeCloseTo(166.67, 2);
  });

  it('returns zero average for an empty pool', () => {
    expect(averageCost([])).toBe(0);
  });
});

describe('allocateFifo', () => {
  const pool = [
    { id: 'old', rem: 20, cost: 100 },
    { id: 'new', rem: 30, cost: 120 },
  ];

  it('draws from the oldest batch first', () => {
    const { allocations, shortfall } = allocateFifo(pool, 25);
    expect(allocations).toEqual({ old: 20, new: 5 });
    expect(shortfall).toBe(0);
  });

  it('reports a shortfall when demand exceeds stock', () => {
    const { allocations, shortfall } = allocateFifo(pool, 80);
    expect(allocations).toEqual({ old: 20, new: 30 });
    expect(shortfall).toBe(30);
  });

  it('allocates nothing for a zero target', () => {
    expect(allocateFifo(pool, 0).allocations).toEqual({});
  });
});

describe('cropSaleResult', () => {
  const pool = [
    { id: 'old', rem: 20, cost: 100, age: 40 },
    { id: 'new', rem: 30, cost: 200, age: 5 },
  ];

  it('costs each batch at its own landed cost under FIFO', () => {
    const r = cropSaleResult({
      pool,
      allocations: { old: 10, new: 10 },
      rate: 300,
      valuation: 'FIFO',
    });
    expect(r.allocatedQty).toBe(20);
    expect(r.cogs).toBe(3000); // 10*100 + 10*200
    expect(r.sales).toBe(6000);
    expect(r.profit).toBe(3000);
    expect(r.margin).toBeCloseTo(50, 5);
  });

  it('costs every batch at the pool average under weighted average', () => {
    const r = cropSaleResult({
      pool,
      allocations: { old: 10, new: 10 },
      rate: 300,
      valuation: 'Weighted Average',
    });
    // average = (100*20 + 200*30) / 50 = 160
    expect(r.cogs).toBeCloseTo(3200, 5);
  });

  it('subtracts sale expenses from profit', () => {
    const r = cropSaleResult({
      pool,
      allocations: { old: 10 },
      rate: 300,
      transport: 200,
      other: 100,
      valuation: 'FIFO',
    });
    expect(r.expenses).toBe(300);
    expect(r.profit).toBe(3000 - 1000 - 300);
  });

  it('flags an allocation that exceeds remaining stock', () => {
    const r = cropSaleResult({ pool, allocations: { old: 999 }, rate: 300, valuation: 'FIFO' });
    expect(r.over).toBe(true);
  });

  it('does not flag an allocation within stock', () => {
    const r = cropSaleResult({ pool, allocations: { old: 20 }, rate: 300, valuation: 'FIFO' });
    expect(r.over).toBe(false);
  });
});

describe('dealerSaleTotals', () => {
  const products = { P1: { pur: 100 }, P2: { pur: 50 } };
  const resolve = (id) => products[id];

  it('nets line discount off gross and derives margin against cost', () => {
    const r = dealerSaleTotals(
      [
        { pid: 'P1', qty: 10, rate: 200, disc: 10 },
        { pid: 'P2', qty: 4, rate: 100, disc: 0 },
      ],
      resolve,
      500
    );
    expect(r.gross).toBe(2400); // 2000 + 400
    expect(r.discount).toBe(200);
    expect(r.net).toBe(2200);
    expect(r.cost).toBe(1200); // 10*100 + 4*50
    expect(r.profit).toBe(1000);
    expect(r.due).toBe(1700);
  });

  it('returns zero margin on an empty invoice instead of NaN', () => {
    const r = dealerSaleTotals([], resolve, 0);
    expect(r.margin).toBe(0);
    expect(r.net).toBe(0);
  });
});

describe('dealerPurchaseTotals', () => {
  it('adds incidental cost on top of the discounted bill', () => {
    const r = dealerPurchaseTotals(
      [{ qty: 100, rate: 10, disc: 5, free: 4 }],
      200,
      50
    );
    expect(r.gross).toBe(1000);
    expect(r.discount).toBe(50);
    expect(r.additional).toBe(250);
    expect(r.freeQty).toBe(4);
    expect(r.net).toBe(1200);
  });
});

describe('effectiveRate', () => {
  it('spreads discount across the free issue', () => {
    // 100 units at 10, less 5%, delivered as 104 units.
    expect(effectiveRate({ qty: 100, rate: 10, disc: 5, free: 4 })).toBeCloseTo(9.13, 2);
  });

  it('is zero when no units are received', () => {
    expect(effectiveRate({ qty: 0, rate: 10, free: 0 })).toBe(0);
  });
});
