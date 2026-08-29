import { nextDocumentNo } from '../lib/numbering.js';
import { unprocessable } from '../lib/errors.js';
import { num } from '../lib/db.js';

/**
 * Inventory ledger.
 *
 * Stock only ever moves through `recordMovement`. That writes an immutable
 * `stock_movements` row and updates the running `stock` balance in the same
 * statement pair, inside the caller's transaction. There is deliberately no
 * function that changes `stock` on its own -- if stock could move without a
 * movement, the ledger would stop being reconstructable.
 */

/** Movement types that increase stock; everything else decreases it. */
const INBOUND = new Set(['PURCHASE', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'RETURN_IN']);

export const isInbound = (movementType) => INBOUND.has(movementType);

/**
 * Lock the stock row for an item and return its current quantity.
 * Locking before reading is what makes two concurrent sales of the same item
 * serialise rather than both seeing the same "available" figure.
 */
async function lockStockRow(client, { warehouseId, itemType, productId, batchId }) {
  const { rows } = await client.query(
    `SELECT id, quantity, avg_cost
       FROM stock
      WHERE warehouse_id = $1
        AND item_type = $2
        AND product_id IS NOT DISTINCT FROM $3
        AND batch_id   IS NOT DISTINCT FROM $4
      FOR UPDATE`,
    [warehouseId, itemType, productId ?? null, batchId ?? null]
  );
  return rows[0] || null;
}

/**
 * Apply a signed quantity change to the running stock balance.
 * Relies on the `quantity >= 0` check constraint as the final guard: even if a
 * caller miscalculates, the database refuses to go negative.
 */
async function applyStockDelta(client, entry, delta, unitCost) {
  const existing = await lockStockRow(client, entry);

  if (!existing) {
    if (delta < 0) {
      throw unprocessable(
        'INSUFFICIENT_STOCK',
        'There is no stock of this item in the selected warehouse.'
      );
    }
    await client.query(
      `INSERT INTO stock (org_id, warehouse_id, item_type, product_id, batch_id, quantity, avg_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.orgId,
        entry.warehouseId,
        entry.itemType,
        entry.productId ?? null,
        entry.batchId ?? null,
        delta,
        unitCost,
      ]
    );
    return;
  }

  const current = num(existing.quantity);
  const next = current + delta;

  if (next < 0) {
    throw unprocessable(
      'INSUFFICIENT_STOCK',
      `Only ${current} available in this warehouse, but ${Math.abs(delta)} was requested.`
    );
  }

  // Weighted average cost moves only on the way in; issues leave it alone.
  const avgCost =
    delta > 0 && next > 0
      ? (current * num(existing.avg_cost) + delta * unitCost) / next
      : num(existing.avg_cost);

  await client.query(
    'UPDATE stock SET quantity = $1, avg_cost = $2, updated_at = now() WHERE id = $3',
    [next, avgCost, existing.id]
  );
}

/**
 * Record one stock movement and update the running balance.
 *
 * @param {import('pg').PoolClient} client must be inside a transaction
 * @param {object} m
 * @param {number} m.orgId
 * @param {string} m.movementType   PURCHASE | SALE | TRANSFER_IN | ...
 * @param {string} m.businessType   DEALER | BULK_CROP
 * @param {number} m.warehouseId
 * @param {string} m.itemType       PRODUCT | CROP_BATCH
 * @param {number} [m.productId]
 * @param {number} [m.batchId]
 * @param {number} m.quantity       always positive; direction comes from type
 * @param {number} [m.unitCost]
 * @param {string} m.referenceType  e.g. 'dealer_sales'
 * @param {number} m.referenceId
 * @param {string} m.movementDate
 * @param {number} m.userId
 * @returns {Promise<{id:number, movementNo:string}>}
 */
export async function recordMovement(client, m) {
  if (!(m.quantity > 0)) {
    throw unprocessable('INVALID_QUANTITY', 'Quantity must be greater than zero.');
  }

  const inbound = isInbound(m.movementType);
  const unitCost = num(m.unitCost);
  const movementNo = await nextDocumentNo(client, m.orgId, 'movement', m.movementDate);

  // Balance first: it takes the row lock and rejects an impossible issue before
  // an orphan ledger row is written.
  await applyStockDelta(
    client,
    {
      orgId: m.orgId,
      warehouseId: m.warehouseId,
      itemType: m.itemType,
      productId: m.productId,
      batchId: m.batchId,
    },
    inbound ? m.quantity : -m.quantity,
    unitCost
  );

  const { rows } = await client.query(
    `INSERT INTO stock_movements
       (org_id, movement_no, movement_date, movement_type, business_type, warehouse_id,
        item_type, product_id, batch_id, quantity_in, quantity_out, unit_cost,
        reference_type, reference_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id, movement_no`,
    [
      m.orgId,
      movementNo,
      m.movementDate,
      m.movementType,
      m.businessType,
      m.warehouseId,
      m.itemType,
      m.productId ?? null,
      m.batchId ?? null,
      inbound ? m.quantity : 0,
      inbound ? 0 : m.quantity,
      unitCost,
      m.referenceType,
      m.referenceId,
      m.note ?? null,
      m.userId,
    ]
  );

  return { id: Number(rows[0].id), movementNo: rows[0].movement_no };
}

/**
 * Reverse every movement made by a document, used when cancelling a posted
 * transaction. The original rows stay; opposite movements are appended, so the
 * history shows both what happened and that it was undone.
 */
export async function reverseMovements(client, { orgId, referenceType, referenceId, userId, date }) {
  const { rows } = await client.query(
    `SELECT * FROM stock_movements
      WHERE reference_type = $1 AND reference_id = $2
      ORDER BY id`,
    [referenceType, referenceId]
  );

  const OPPOSITE = {
    PURCHASE: 'RETURN_OUT',
    SALE: 'RETURN_IN',
    TRANSFER_IN: 'TRANSFER_OUT',
    TRANSFER_OUT: 'TRANSFER_IN',
    ADJUSTMENT_IN: 'ADJUSTMENT_OUT',
    ADJUSTMENT_OUT: 'ADJUSTMENT_IN',
    RETURN_IN: 'RETURN_OUT',
    RETURN_OUT: 'RETURN_IN',
  };

  for (const original of rows) {
    await recordMovement(client, {
      orgId,
      movementType: OPPOSITE[original.movement_type],
      businessType: original.business_type,
      warehouseId: Number(original.warehouse_id),
      itemType: original.item_type,
      productId: original.product_id ? Number(original.product_id) : undefined,
      batchId: original.batch_id ? Number(original.batch_id) : undefined,
      quantity: num(original.quantity_in) || num(original.quantity_out),
      unitCost: num(original.unit_cost),
      referenceType,
      referenceId,
      movementDate: date,
      userId,
      note: `Reversal of ${original.movement_no}`,
    });
  }

  return rows.length;
}

/** Current quantity of a product in a warehouse. */
export async function availableProductStock(client, { warehouseId, productId }) {
  const { rows } = await client.query(
    `SELECT quantity FROM stock
      WHERE warehouse_id = $1 AND product_id = $2 AND item_type = 'PRODUCT'`,
    [warehouseId, productId]
  );
  return rows.length ? num(rows[0].quantity) : 0;
}
