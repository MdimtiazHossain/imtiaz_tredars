/**
 * Pure business calculations.
 *
 * Kept free of any DOM or view-model concern so the arithmetic that decides
 * landed cost, stock allocation and invoice margins can be unit tested and
 * reused by any screen.
 */

const num = (v) => Number(v) || 0;

/**
 * Landed cost of a bulk crop purchase.
 *
 * Quantity is reduced by a moisture deduction, then every incidental expense
 * is absorbed into the per-unit cost -- this is the number the trade is run on.
 */
export function landedCost(input) {
  const gross = num(input.qty);
  const deduction = (gross * num(input.moisture)) / 100;
  const net = gross - deduction;
  const purchaseValue = net * num(input.rate);
  const additional =
    num(input.transport) + num(input.loading) + num(input.unloading) + num(input.other);
  const total = purchaseValue + additional;
  return {
    gross,
    deduction,
    net,
    purchaseValue,
    additional,
    total,
    costPerUnit: net ? total / net : 0,
  };
}

/** Batches of one crop that still hold stock, oldest first. */
export function availableBatches(batches, crop) {
  return batches
    .filter((b) => b.crop === crop && b.rem > 0)
    .slice()
    .sort((a, b) => b.age - a.age);
}

/** Weighted-average cost across a batch pool. */
export function averageCost(pool) {
  const qty = pool.reduce((t, b) => t + b.rem, 0);
  return qty ? pool.reduce((t, b) => t + b.cost * b.rem, 0) / qty : 0;
}

/**
 * Allocate a target quantity across batches, oldest stock first.
 * @returns {{allocations: Record<string, number>, shortfall: number}}
 */
export function allocateFifo(pool, target) {
  let left = num(target);
  /** @type {Record<string, number>} */
  const allocations = {};
  for (const b of pool) {
    const take = Math.min(left, b.rem);
    if (take > 0) allocations[b.id] = take;
    left -= take;
  }
  return { allocations, shortfall: Math.max(0, left) };
}

/**
 * Result of a bulk crop sale against an allocation across batches.
 * `valuation` is either `FIFO` (each batch at its own landed cost) or
 * `Weighted Average` (every batch at the pool average).
 */
export function cropSaleResult(input) {
  const pool = input.pool;
  const allocations = input.allocations || {};
  const avgCost = averageCost(pool);
  const useFifo = input.valuation === 'FIFO';

  let allocatedQty = 0;
  let cogs = 0;
  let over = false;

  for (const b of pool) {
    const a = num(allocations[b.id]);
    if (a > b.rem) over = true;
    allocatedQty += a;
    cogs += a * (useFifo ? b.cost : avgCost);
  }

  const sales = allocatedQty * num(input.rate);
  const expenses = num(input.transport) + num(input.other);
  const profit = sales - cogs - expenses;

  return {
    allocatedQty,
    cogs,
    sales,
    expenses,
    profit,
    avgCost,
    over,
    perUnit: allocatedQty ? profit / allocatedQty : 0,
    margin: sales ? (profit / sales) * 100 : 0,
  };
}

/**
 * Totals for a dealer sales invoice.
 * `resolveProduct` maps a line's product id to its master record.
 */
export function dealerSaleTotals(lines, resolveProduct, paid) {
  let gross = 0;
  let discount = 0;
  let cost = 0;

  for (const l of lines) {
    const p = resolveProduct(l.pid);
    const amount = num(l.qty) * num(l.rate);
    gross += amount;
    discount += (amount * num(l.disc)) / 100;
    cost += num(l.qty) * (p ? p.pur : 0);
  }

  const net = gross - discount;
  const profit = net - cost;
  return {
    gross,
    discount,
    net,
    cost,
    profit,
    margin: net ? (profit / net) * 100 : 0,
    due: net - num(paid),
  };
}

/** Totals for a dealer purchase bill, including free-issue quantity. */
export function dealerPurchaseTotals(lines, transport, other) {
  let gross = 0;
  let discount = 0;
  let freeQty = 0;

  for (const l of lines) {
    const amount = num(l.qty) * num(l.rate);
    gross += amount;
    discount += (amount * num(l.disc)) / 100;
    freeQty += num(l.free);
  }

  const additional = num(transport) + num(other);
  return { gross, discount, additional, freeQty, net: gross - discount + additional };
}

/** Effective per-unit rate once discount and free issue are absorbed. */
export function effectiveRate(line) {
  const amount = num(line.qty) * num(line.rate);
  const net = amount - (amount * num(line.disc)) / 100;
  const units = num(line.qty) + num(line.free);
  return units ? net / units : 0;
}
