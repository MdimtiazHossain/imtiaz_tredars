import { num } from '../lib/db.js';
import { nextDocumentNo } from '../lib/numbering.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { recordMovement, reverseMovements, availableProductStock } from './inventoryService.js';

/**
 * Stock transfer between warehouses.
 *
 * A product is fungible, so moving it is a quantity leaving one warehouse and
 * the same quantity arriving at another.
 *
 * A crop batch is not. Each batch carries its own landed cost and its own age,
 * and FIFO selects batches by the warehouse they sit in. Moving part of a
 * batch therefore **splits** it: the source batch keeps what stayed behind and
 * a child batch is created at the destination carrying the same cost and the
 * same `received_on`. Carrying the original receipt date over matters — a
 * batch does not become newer stock by being driven to another godown, and
 * FIFO must keep issuing it in the right order.
 *
 * The alternative — moving the stock rows but leaving `crop_batches.warehouse_id`
 * pointing at the origin — would make the batch invisible to a sale from the
 * warehouse that actually holds it.
 */

async function validate(client, orgId, input) {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw badRequest('SAME_WAREHOUSE', 'Choose two different warehouses.');
  }

  const { rows } = await client.query(
    'SELECT id, name FROM warehouses WHERE id = ANY($1::bigint[]) AND org_id = $2 AND is_active',
    [[input.fromWarehouseId, input.toWarehouseId], orgId]
  );
  if (rows.length !== 2) {
    throw badRequest('INVALID_WAREHOUSE', 'Select two valid warehouses.');
  }

  for (const line of input.lines) {
    if (!(num(line.quantity) > 0)) {
      throw unprocessable('INVALID_QUANTITY', 'Quantity must be greater than zero.');
    }
  }

  const byId = new Map(rows.map((r) => [Number(r.id), r.name]));
  return { from: byId.get(input.fromWarehouseId), to: byId.get(input.toWarehouseId) };
}

/**
 * Move part of a crop batch to another warehouse by splitting it.
 * @returns {Promise<{batchId:number, batchNo:string, unitCost:number}>} the child batch
 */
async function splitBatch(client, { orgId, batchId, quantity, toWarehouseId, txnDate }) {
  // Lock the source before reading, so two transfers of the same batch cannot
  // both believe the stock is there.
  const { rows } = await client.query(
    `SELECT * FROM crop_batches WHERE id = $1 AND org_id = $2 AND is_active FOR UPDATE`,
    [batchId, orgId]
  );
  if (!rows.length) throw notFound('Batch');
  const source = rows[0];

  if (num(source.quantity_remaining) < quantity) {
    throw unprocessable(
      'INSUFFICIENT_STOCK',
      `Batch ${source.batch_no} holds ${num(source.quantity_remaining)}, ` +
        `which is less than the ${quantity} requested.`
    );
  }

  const { rowCount } = await client.query(
    `UPDATE crop_batches
        SET quantity_remaining = quantity_remaining - $1, updated_at = now()
      WHERE id = $2 AND quantity_remaining >= $1`,
    [quantity, batchId]
  );
  if (rowCount !== 1) {
    throw unprocessable(
      'INSUFFICIENT_STOCK',
      `Batch ${source.batch_no} no longer holds enough stock. Refresh and try again.`
    );
  }

  const batchNo = await nextDocumentNo(client, orgId, 'crop_batch', txnDate);
  const { rows: child } = await client.query(
    `INSERT INTO crop_batches
       (org_id, batch_no, purchase_item_id, crop_id, grade_id, warehouse_id, supplier_id,
        unit_id, received_on, quantity_received, quantity_remaining, cost_per_unit,
        parent_batch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12)
     RETURNING id, batch_no`,
    [
      orgId,
      batchNo,
      source.purchase_item_id,
      source.crop_id,
      source.grade_id,
      toWarehouseId,
      source.supplier_id,
      source.unit_id,
      // The receipt date travels with the stock, so age and FIFO order survive.
      source.received_on,
      quantity,
      num(source.cost_per_unit),
      // Recorded so cancelling the transfer can find this batch and give the
      // quantity back to the batch it came from.
      batchId,
    ]
  );

  return {
    batchId: Number(child[0].id),
    batchNo: child[0].batch_no,
    unitCost: num(source.cost_per_unit),
    sourceBatchNo: source.batch_no,
  };
}

/**
 * Create and post a stock transfer.
 *
 * Everything happens in the caller's transaction: stock never leaves one
 * warehouse without arriving at the other.
 */
export async function createTransfer(client, { orgId, user, actor, input }) {
  const { from, to } = await validate(client, orgId, input);

  const txnNo = input.txnNo || (await nextDocumentNo(client, orgId, 'transfer', input.txnDate));

  const { rows } = await client.query(
    `INSERT INTO stock_transfers
       (org_id, txn_no, txn_date, business_type, from_warehouse_id, to_warehouse_id,
        note, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8)
     RETURNING id`,
    [
      orgId,
      txnNo,
      input.txnDate,
      input.businessType,
      input.fromWarehouseId,
      input.toWarehouseId,
      input.note ?? null,
      user.id,
    ]
  );

  const transferId = Number(rows[0].id);
  const moved = [];
  let lineNo = 0;

  for (const line of input.lines) {
    lineNo += 1;
    const quantity = num(line.quantity);

    if (line.itemType === 'CROP_BATCH') {
      const child = await splitBatch(client, {
        orgId,
        batchId: line.batchId,
        quantity,
        toWarehouseId: input.toWarehouseId,
        txnDate: input.txnDate,
      });

      await client.query(
        `INSERT INTO stock_transfer_items
           (transfer_id, line_no, item_type, batch_id, quantity, unit_cost)
         VALUES ($1,$2,'CROP_BATCH',$3,$4,$5)`,
        [transferId, lineNo, line.batchId, quantity, child.unitCost]
      );

      await recordMovement(client, {
        orgId,
        movementType: 'TRANSFER_OUT',
        businessType: input.businessType,
        warehouseId: input.fromWarehouseId,
        itemType: 'CROP_BATCH',
        batchId: line.batchId,
        quantity,
        unitCost: child.unitCost,
        referenceType: 'stock_transfers',
        referenceId: transferId,
        movementDate: input.txnDate,
        userId: user.id,
      });

      await recordMovement(client, {
        orgId,
        movementType: 'TRANSFER_IN',
        businessType: input.businessType,
        warehouseId: input.toWarehouseId,
        itemType: 'CROP_BATCH',
        batchId: child.batchId,
        quantity,
        unitCost: child.unitCost,
        referenceType: 'stock_transfers',
        referenceId: transferId,
        movementDate: input.txnDate,
        userId: user.id,
      });

      moved.push(`${child.sourceBatchNo} → ${child.batchNo}`);
      continue;
    }

    // A product moves as a quantity; there is nothing to split.
    const available = await availableProductStock(client, {
      warehouseId: input.fromWarehouseId,
      productId: line.productId,
    });
    if (quantity > available) {
      const { rows: p } = await client.query('SELECT name FROM products WHERE id = $1', [
        line.productId,
      ]);
      throw unprocessable(
        'INSUFFICIENT_STOCK',
        `Only ${available} of ${p[0]?.name || 'this product'} is available in ${from}.`
      );
    }

    const { rows: costRows } = await client.query(
      `SELECT avg_cost FROM stock
        WHERE warehouse_id = $1 AND product_id = $2 AND item_type = 'PRODUCT'`,
      [input.fromWarehouseId, line.productId]
    );
    const unitCost = num(costRows[0]?.avg_cost);

    await client.query(
      `INSERT INTO stock_transfer_items
         (transfer_id, line_no, item_type, product_id, quantity, unit_cost)
       VALUES ($1,$2,'PRODUCT',$3,$4,$5)`,
      [transferId, lineNo, line.productId, quantity, unitCost]
    );

    await recordMovement(client, {
      orgId,
      movementType: 'TRANSFER_OUT',
      businessType: input.businessType,
      warehouseId: input.fromWarehouseId,
      itemType: 'PRODUCT',
      productId: line.productId,
      quantity,
      unitCost,
      referenceType: 'stock_transfers',
      referenceId: transferId,
      movementDate: input.txnDate,
      userId: user.id,
    });

    await recordMovement(client, {
      orgId,
      movementType: 'TRANSFER_IN',
      businessType: input.businessType,
      warehouseId: input.toWarehouseId,
      itemType: 'PRODUCT',
      productId: line.productId,
      quantity,
      // Cost travels with the stock, so the destination's average is not
      // diluted by the move itself.
      unitCost,
      referenceType: 'stock_transfers',
      referenceId: transferId,
      movementDate: input.txnDate,
      userId: user.id,
    });

    moved.push(`${quantity} moved`);
  }

  await client.query(
    `UPDATE stock_transfers SET status = 'POSTED', posted_at = now(), updated_by = $1
      WHERE id = $2`,
    [user.id, transferId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'stock_transfers',
    entityId: transferId,
    action: 'POST',
    newValue: { txnNo, from, to, lines: input.lines.length },
    summary: `Stock transfer ${txnNo}: ${from} to ${to} (${moved.join(', ')})`,
  });

  return { id: transferId, txnNo, status: 'POSTED', from, to, moved };
}

/**
 * Give each split quantity back to the batch it came from and retire the child.
 *
 * Children are found through `parent_batch_id` rather than by re-reading the
 * transfer lines, so a batch that was split more than once still resolves to
 * the right parent.
 */
async function undoSplits(client, { orgId, transferId }) {
  const { rows: children } = await client.query(
    `SELECT b.id, b.parent_batch_id, b.quantity_remaining
       FROM crop_batches b
      WHERE b.org_id = $1
        AND b.parent_batch_id IS NOT NULL
        AND b.id IN (SELECT batch_id FROM stock_movements
                      WHERE reference_type = 'stock_transfers' AND reference_id = $2
                        AND movement_type = 'TRANSFER_IN' AND batch_id IS NOT NULL)
      FOR UPDATE`,
    [orgId, transferId]
  );

  for (const child of children) {
    await client.query(
      `UPDATE crop_batches
          SET quantity_remaining = quantity_remaining + $1, updated_at = now()
        WHERE id = $2`,
      [num(child.quantity_remaining), Number(child.parent_batch_id)]
    );

    // The child is emptied rather than deleted: it carries movement history,
    // and a posted document is never erased.
    await client.query(
      `UPDATE crop_batches
          SET quantity_remaining = 0, is_active = false, updated_at = now()
        WHERE id = $1`,
      [Number(child.id)]
    );
  }

  return children.length;
}

/** Cancel a posted transfer by moving the stock back. */
export async function cancelTransfer(client, { orgId, user, actor, transferId, reason }) {
  const { rows } = await client.query(
    'SELECT * FROM stock_transfers WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [transferId, orgId]
  );
  if (!rows.length) throw notFound('Stock transfer');
  const header = rows[0];

  if (header.status !== 'POSTED') {
    throw unprocessable('NOT_POSTED', 'Only a posted transfer can be cancelled.');
  }

  // A batch created by the transfer may already have been sold from its new
  // warehouse, in which case the move cannot simply be undone.
  const { rows: consumed } = await client.query(
    `SELECT b.batch_no FROM crop_batches b
      WHERE b.warehouse_id = $1
        AND b.quantity_remaining < b.quantity_received
        AND b.id IN (SELECT batch_id FROM stock_movements
                      WHERE reference_type = 'stock_transfers' AND reference_id = $2
                        AND movement_type = 'TRANSFER_IN' AND batch_id IS NOT NULL)`,
    [header.to_warehouse_id, transferId]
  );
  if (consumed.length) {
    throw unprocessable(
      'STOCK_ALREADY_SOLD',
      `Batch ${consumed[0].batch_no} has already been sold from the destination, ` +
        'so this transfer cannot be reversed.'
    );
  }

  await reverseMovements(client, {
    orgId,
    referenceType: 'stock_transfers',
    referenceId: transferId,
    userId: user.id,
    date: new Date().toISOString().slice(0, 10),
  });

  // Reversing the movements restores the `stock` balances, but the split
  // itself lives in `crop_batches`, which the ledger never touches. Undo it
  // here or the child batch is left claiming stock its warehouse no longer
  // holds -- and FIFO allocates from `quantity_remaining`, so it would offer
  // that phantom for sale.
  await undoSplits(client, { orgId, transferId });

  await client.query(
    `UPDATE stock_transfers
        SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1,
            cancellation_reason = $2, updated_by = $1
      WHERE id = $3`,
    [user.id, reason, transferId]
  );

  await writeAudit(client, {
    actor,
    entityType: 'stock_transfers',
    entityId: transferId,
    action: 'CANCEL',
    oldValue: { status: 'POSTED' },
    newValue: { status: 'CANCELLED', reason },
    summary: `Stock transfer ${header.txn_no} cancelled: ${reason}`,
  });

  return { id: transferId, status: 'CANCELLED' };
}
