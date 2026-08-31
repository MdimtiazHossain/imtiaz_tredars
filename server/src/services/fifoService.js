import { num } from '../lib/db.js';
import { unprocessable } from '../lib/errors.js';

/**
 * FIFO batch allocation for bulk crop sales.
 *
 * Two employees selling the same crop at the same moment is the concurrency
 * case that matters most here. The protection is:
 *
 *   1. `SELECT ... FOR UPDATE` takes a row lock on every candidate batch before
 *      any quantity is read, so the second transaction blocks rather than
 *      reading a stale remaining quantity.
 *   2. Batches are always locked in the same order (received_on, id), so two
 *      concurrent sales cannot deadlock by grabbing them in opposite orders.
 *   3. `crop_batches.quantity_remaining >= 0` is a check constraint, so even a
 *      logic error cannot oversell.
 *
 * The arithmetic mirrors `src/domain/calculations.js` on the frontend, which is
 * what keeps the figure previewed on screen equal to the figure posted.
 */

/**
 * Lock and return the batch pool for a crop, oldest first.
 *
 * @param {import('pg').PoolClient} client must be inside a transaction
 * @param {{orgId:number, cropId:number, warehouseId?:number}} filter
 */
export async function lockBatchPool(client, { orgId, cropId, warehouseId }) {
  const params = [orgId, cropId];
  let where = 'b.org_id = $1 AND b.crop_id = $2 AND b.quantity_remaining > 0 AND b.is_active';

  if (warehouseId) {
    params.push(warehouseId);
    where += ` AND b.warehouse_id = $${params.length}`;
  }

  const { rows } = await client.query(
    `SELECT b.id, b.batch_no, b.crop_id, b.grade_id, b.warehouse_id, b.received_on,
            b.quantity_received, b.quantity_remaining, b.cost_per_unit, b.unit_id
       FROM crop_batches b
      WHERE ${where}
      ORDER BY b.received_on ASC, b.id ASC
      FOR UPDATE`,
    params
  );

  return rows.map((b) => ({
    id: Number(b.id),
    batchNo: b.batch_no,
    cropId: Number(b.crop_id),
    gradeId: b.grade_id ? Number(b.grade_id) : null,
    warehouseId: Number(b.warehouse_id),
    receivedOn: b.received_on,
    quantityReceived: num(b.quantity_received),
    quantityRemaining: num(b.quantity_remaining),
    costPerUnit: num(b.cost_per_unit),
    unitId: Number(b.unit_id),
  }));
}

/** Weighted-average cost of a locked pool. */
export function averageCost(pool) {
  const qty = pool.reduce((t, b) => t + b.quantityRemaining, 0);
  return qty ? pool.reduce((t, b) => t + b.costPerUnit * b.quantityRemaining, 0) / qty : 0;
}

/**
 * Round to paisa, which is the precision the columns these figures land in
 * actually hold. Doing it here rather than letting the database do it on the
 * way in is what keeps the total equal to the sum of its parts: the sum of
 * rounded line values and the rounded sum of unrounded ones differ by a paisa
 * often enough that a reconciliation between `crop_batch_allocations` and
 * `crop_sales.cogs_amount` would fail on ordinary data.
 */
const paisa = (n) => Math.round(n * 100) / 100;

/**
 * Plan an allocation across a locked pool without writing anything.
 * Oldest batch first; each batch is costed at its own landed cost under FIFO,
 * or at the pool average under weighted average.
 *
 * @returns {{lines: Array, allocated: number, shortfall: number, cogs: number}}
 */
export function planAllocation(pool, quantity, valuationMethod = 'FIFO') {
  const avg = averageCost(pool);
  const useFifo = valuationMethod !== 'WEIGHTED_AVERAGE';

  let remaining = quantity;
  let cogs = 0;
  const lines = [];

  for (const batch of pool) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.quantityRemaining);
    if (take <= 0) continue;

    const unitCost = useFifo ? batch.costPerUnit : avg;
    const costValue = paisa(take * unitCost);

    lines.push({
      batchId: batch.id,
      batchNo: batch.batchNo,
      warehouseId: batch.warehouseId,
      quantity: take,
      unitCost,
      costValue,
    });

    cogs += costValue;
    remaining -= take;
  }

  return {
    lines,
    allocated: quantity - remaining,
    shortfall: Math.max(0, remaining),
    cogs: paisa(cogs),
    averageCost: avg,
  };
}

/**
 * Consume a planned allocation: decrement each batch under the lock already
 * held by `lockBatchPool`. The conditional WHERE is a second guard -- if the
 * remaining quantity somehow changed, the update affects no row and we fail
 * loudly instead of overselling.
 */
export async function consumeAllocation(client, lines) {
  for (const line of lines) {
    const { rowCount } = await client.query(
      `UPDATE crop_batches
          SET quantity_remaining = quantity_remaining - $1,
              updated_at = now()
        WHERE id = $2 AND quantity_remaining >= $1`,
      [line.quantity, line.batchId]
    );

    if (rowCount !== 1) {
      throw unprocessable(
        'INSUFFICIENT_STOCK',
        `Batch ${line.batchNo} no longer has enough stock. Refresh and try again.`
      );
    }
  }
}

/** Return quantity to batches when a posted crop sale is cancelled. */
export async function restoreAllocation(client, saleId) {
  const { rows } = await client.query(
    `SELECT a.batch_id, a.quantity
       FROM crop_batch_allocations a
       JOIN crop_sale_items i ON i.id = a.sale_item_id
      WHERE i.sale_id = $1
      ORDER BY a.batch_id`,
    [saleId]
  );

  for (const row of rows) {
    await client.query(
      `UPDATE crop_batches
          SET quantity_remaining = LEAST(quantity_received, quantity_remaining + $1),
              updated_at = now()
        WHERE id = $2`,
      [num(row.quantity), row.batch_id]
    );
  }

  return rows.length;
}

/**
 * Allocate in one step: lock, plan, verify, consume.
 * Throws if the pool cannot cover the requested quantity.
 */
export async function allocateForSale(client, { orgId, cropId, warehouseId, quantity, valuationMethod }) {
  const pool = await lockBatchPool(client, { orgId, cropId, warehouseId });
  const plan = planAllocation(pool, quantity, valuationMethod);

  if (plan.shortfall > 0) {
    throw unprocessable(
      'INSUFFICIENT_STOCK',
      `Only ${plan.allocated} available for this crop, but ${quantity} was requested.`
    );
  }

  await consumeAllocation(client, plan.lines);
  return plan;
}
