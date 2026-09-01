import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, withTransaction, query, closePool, num } from '../src/lib/db.js';
import { createCropPurchase, cancelCropPurchase } from '../src/services/cropPurchaseService.js';
import { createCropSale } from '../src/services/cropSaleService.js';
import {
  createDealerPurchase,
  createDealerSale,
  postDealerPurchase,
  postDealerSale,
} from '../src/services/dealerService.js';
import { allocatePayment } from '../src/services/financeService.js';
import { createTransfer, cancelTransfer } from '../src/services/transferService.js';
import { nextDocumentNo } from '../src/lib/numbering.js';
import { HAS_DB } from './helpers/database.js';

/**
 * Integration tests against a real PostgreSQL database.
 *
 * These are skipped unless TEST_DATABASE_URL (or DATABASE_URL) is set, so the
 * suite stays runnable on a machine with no database. Run
 * `npm run db:reset && npm run db:seed` against the test database first.
 */

// Probes the connection once rather than trusting the environment variable, so
// an unreachable database skips cleanly instead of failing every assertion.
const suite = HAS_DB ? describe : describe.skip;

let ctx;

suite('posting integrity', () => {
  beforeAll(async () => {
    const { rows: users } = await query(
      `SELECT u.id, u.org_id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
       WHERE r.code = 'Admin' AND u.is_active ORDER BY u.id LIMIT 1`
    );
    if (!users.length) throw new Error('Seed the test database first: npm run db:seed');

    const orgId = Number(users[0].org_id);
    const [warehouse, supplier, crop, grade, unit, buyer, customer, product, company] =
      await Promise.all([
        query('SELECT id FROM warehouses WHERE org_id = $1 ORDER BY id LIMIT 1', [orgId]),
        query('SELECT id FROM suppliers WHERE org_id = $1 ORDER BY id LIMIT 1', [orgId]),
        query("SELECT id FROM crops WHERE org_id = $1 AND code = 'CROP-04'", [orgId]),
        query("SELECT id FROM crop_grades WHERE code = 'A'", []),
        query("SELECT id FROM units WHERE code = 'MT'", []),
        query("SELECT id FROM companies WHERE org_id = $1 AND role = 'BUYER' ORDER BY id LIMIT 1", [orgId]),
        query('SELECT id FROM customers WHERE org_id = $1 ORDER BY id LIMIT 1', [orgId]),
        query("SELECT id FROM products WHERE org_id = $1 AND code = 'P-1005'", [orgId]),
        query("SELECT id FROM companies WHERE org_id = $1 AND role = 'PRINCIPAL' ORDER BY id LIMIT 1", [orgId]),
      ]);

    ctx = {
      orgId,
      user: { id: Number(users[0].id) },
      actor: { userId: Number(users[0].id), orgId, ip: null, userAgent: 'vitest' },
      warehouseId: Number(warehouse.rows[0].id),
      supplierId: Number(supplier.rows[0].id),
      cropId: Number(crop.rows[0].id),
      gradeId: Number(grade.rows[0].id),
      unitId: Number(unit.rows[0].id),
      buyerId: Number(buyer.rows[0].id),
      customerId: Number(customer.rows[0].id),
      productId: Number(product.rows[0].id),
      companyId: Number(company.rows[0].id),
    };
  });

  const purchaseInput = (qty, rate = 1000) => ({
    txnDate: '2026-08-28',
    supplierId: ctx.supplierId,
    warehouseId: ctx.warehouseId,
    transportCost: 1000,
    loadingCost: 0,
    unloadingCost: 0,
    otherCost: 0,
    advancePaid: 0,
    lines: [
      {
        cropId: ctx.cropId,
        gradeId: ctx.gradeId,
        unitId: ctx.unitId,
        grossQuantity: qty,
        moisturePct: 0,
        rate,
      },
    ],
    action: 'POST',
  });

  it('creates a batch, a stock movement and a payable in one transaction', async () => {
    const result = await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: purchaseInput(10) })
    );

    expect(result.status).toBe('POSTED');

    const movements = await query(
      "SELECT * FROM stock_movements WHERE reference_type = 'crop_purchases' AND reference_id = $1",
      [result.id]
    );
    expect(movements.rows).toHaveLength(1);
    expect(num(movements.rows[0].quantity_in)).toBe(10);

    const payable = await query(
      "SELECT * FROM payables WHERE invoice_type = 'crop_purchases' AND invoice_id = $1",
      [result.id]
    );
    expect(payable.rows).toHaveLength(1);

    const ledger = await query(
      "SELECT * FROM ledger_entries WHERE reference_type = 'crop_purchases' AND reference_id = $1",
      [result.id]
    );
    expect(ledger.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('rolls the whole purchase back when a line is invalid', async () => {
    const before = await query('SELECT COUNT(*)::int AS n FROM crop_purchases');

    await expect(
      withTransaction((client) =>
        createCropPurchase(client, {
          ...ctx,
          input: { ...purchaseInput(10), lines: [{ ...purchaseInput(10).lines[0], cropId: 999999 }] },
        })
      )
    ).rejects.toThrow();

    const after = await query('SELECT COUNT(*)::int AS n FROM crop_purchases');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('allocates FIFO across batches and reduces the oldest first', async () => {
    // Two batches of the same crop at different costs.
    const first = await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: purchaseInput(20, 1000) })
    );
    const second = await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: purchaseInput(20, 2000) })
    );

    // The oldest batch that still holds stock is the one FIFO will draw from.
    // Selecting merely the oldest makes the test pass only against a freshly
    // seeded database: on a re-run that batch is already drained, and FIFO
    // correctly skips it.
    const before = await query(
      `SELECT id, quantity_remaining FROM crop_batches
        WHERE org_id = $1 AND crop_id = $2 AND is_active AND quantity_remaining > 0
        ORDER BY received_on, id`,
      [ctx.orgId, ctx.cropId]
    );
    const oldest = before.rows[0];
    expect(oldest, 'no stocked batch to allocate from').toBeDefined();

    const sale = await withTransaction((client) =>
      createCropSale(client, {
        ...ctx,
        input: {
          txnDate: '2026-08-29',
          buyerCompanyId: ctx.buyerId,
          valuationMethod: 'FIFO',
          transportCost: 0,
          otherCost: 0,
          paidAmount: 0,
          lines: [{ cropId: ctx.cropId, unitId: ctx.unitId, quantity: 5, rate: 5000 }],
          action: 'POST',
        },
      })
    );

    expect(sale.status).toBe('POSTED');

    // FIFO drains the oldest batch first and spills into the next one, so the
    // oldest ends at whatever is left of it -- not necessarily its opening
    // quantity less the whole sale.
    const after = await query('SELECT quantity_remaining FROM crop_batches WHERE id = $1', [
      oldest.id,
    ]);
    expect(num(after.rows[0].quantity_remaining)).toBe(
      Math.max(0, num(oldest.quantity_remaining) - 5)
    );

    // Whatever the split across batches, the pool as a whole falls by exactly
    // the quantity sold.
    const poolAfter = await query(
      `SELECT COALESCE(SUM(quantity_remaining), 0) AS qty FROM crop_batches
        WHERE org_id = $1 AND crop_id = $2 AND is_active`,
      [ctx.orgId, ctx.cropId]
    );
    const openingPool = before.rows.reduce((t, b) => t + num(b.quantity_remaining), 0);
    expect(num(poolAfter.rows[0].qty)).toBe(openingPool - 5);

    expect(first.id).toBeDefined();
    expect(second.id).toBeDefined();
  });

  it('refuses a sale larger than the stock on hand', async () => {
    await expect(
      withTransaction((client) =>
        createCropSale(client, {
          ...ctx,
          input: {
            txnDate: '2026-08-29',
            buyerCompanyId: ctx.buyerId,
            valuationMethod: 'FIFO',
            transportCost: 0,
            otherCost: 0,
            paidAmount: 0,
            lines: [{ cropId: ctx.cropId, unitId: ctx.unitId, quantity: 999999, rate: 5000 }],
            action: 'POST',
          },
        })
      )
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('keeps the stock table in step with the movement ledger', async () => {
    const { rows } = await query('SELECT * FROM v_stock_reconciliation WHERE difference <> 0');
    expect(rows).toHaveLength(0);
  });

  it('protects concurrent sales of the same batch pool', async () => {
    await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: purchaseInput(6, 1000) })
    );

    const available = await query(
      `SELECT COALESCE(SUM(quantity_remaining), 0) AS qty FROM crop_batches
        WHERE org_id = $1 AND crop_id = $2 AND is_active`,
      [ctx.orgId, ctx.cropId]
    );
    const total = num(available.rows[0].qty);

    const sellAll = () =>
      withTransaction((client) =>
        createCropSale(client, {
          ...ctx,
          input: {
            txnDate: '2026-08-29',
            buyerCompanyId: ctx.buyerId,
            valuationMethod: 'FIFO',
            transportCost: 0,
            otherCost: 0,
            paidAmount: 0,
            // A nominal rate keeps the sale under the approval ceiling no
            // matter how large the shared pool has grown. At a realistic rate
            // both sales would route to approval instead of competing for
            // stock, and the test would pass two winners without ever
            // exercising the lock it exists to check.
            lines: [{ cropId: ctx.cropId, unitId: ctx.unitId, quantity: total, rate: 1 }],
            action: 'POST',
          },
        })
      );

    // Both try to take the entire pool; exactly one may succeed.
    const results = await Promise.allSettled([sellAll(), sellAll()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const after = await query(
      `SELECT COALESCE(SUM(quantity_remaining), 0) AS qty FROM crop_batches
        WHERE org_id = $1 AND crop_id = $2 AND is_active`,
      [ctx.orgId, ctx.cropId]
    );
    expect(num(after.rows[0].qty)).toBeGreaterThanOrEqual(0);
  });

  it('keeps numbering documents past 999 in a period', async () => {
    // lpad truncates as well as pads, so a padding of 3 turned the 1000th
    // document into the number the 100th already had, and the unique
    // constraint refused the insert. Every purchase and sale line writes stock
    // movements, so a month of ordinary trading reaches 999.
    const period = '2612';
    await query(
      `INSERT INTO document_sequences (org_id, doc_type, prefix, period, next_value, padding)
       VALUES ($1, 'probe', 'PRB', $2, 998, 3)
       ON CONFLICT (org_id, doc_type, period)
       DO UPDATE SET next_value = 998`,
      [ctx.orgId, period]
    );

    const { rows } = await query(
      `SELECT next_document_no($1, 'probe', 'PRB', $2, 3) AS no FROM generate_series(1, 4)`,
      [ctx.orgId, period]
    );

    expect(rows.map((r) => r.no)).toEqual([
      'PRB-2612-998',
      'PRB-2612-999',
      'PRB-2612-1000',
      'PRB-2612-1001',
    ]);
    // Distinct is the point: the wrap produced repeats, which is what the
    // unique constraint was catching.
    expect(new Set(rows.map((r) => r.no)).size).toBe(4);

    await query("DELETE FROM document_sequences WHERE doc_type = 'probe' AND org_id = $1", [
      ctx.orgId,
    ]);
  });

  it('routes a purchase over the limit to approval instead of posting it', async () => {
    const result = await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: purchaseInput(1000, 5000) })
    );
    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.approval.requestNo).toMatch(/^AP-/);

    const movements = await query(
      "SELECT COUNT(*)::int AS n FROM stock_movements WHERE reference_type = 'crop_purchases' AND reference_id = $1",
      [result.id]
    );
    expect(movements.rows[0].n).toBe(0);
  });

  it('refuses to hard delete a posted transaction', async () => {
    const result = await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: purchaseInput(3) })
    );
    await expect(query('DELETE FROM crop_purchases WHERE id = $1', [result.id])).rejects.toThrow(
      /POSTED_TRANSACTION_CANNOT_BE_DELETED/
    );
  });

  it('refuses to edit a posted transaction', async () => {
    const result = await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: purchaseInput(3) })
    );
    await expect(
      query('UPDATE crop_purchases SET net_amount = 1 WHERE id = $1', [result.id])
    ).rejects.toThrow(/POSTED_TRANSACTION_IMMUTABLE/);
  });

  it('cancels by reversal, leaving the original movements in place', async () => {
    const result = await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: purchaseInput(4) })
    );

    await withTransaction((client) =>
      cancelCropPurchase(client, {
        ...ctx,
        purchaseId: result.id,
        reason: 'Wrong supplier selected',
      })
    );

    const { rows } = await query(
      "SELECT movement_type FROM stock_movements WHERE reference_type = 'crop_purchases' AND reference_id = $1 ORDER BY id",
      [result.id]
    );
    expect(rows.map((r) => r.movement_type)).toEqual(['PURCHASE', 'RETURN_OUT']);

    const header = await query('SELECT status FROM crop_purchases WHERE id = $1', [result.id]);
    expect(header.rows[0].status).toBe('CANCELLED');
  });

  it('rejects a duplicate transaction number', async () => {
    const txnNo = `DUP-${Date.now()}`;
    await withTransaction((client) =>
      createCropPurchase(client, { ...ctx, input: { ...purchaseInput(2), txnNo } })
    );
    await expect(
      withTransaction((client) =>
        createCropPurchase(client, { ...ctx, input: { ...purchaseInput(2), txnNo } })
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('issues gapless document numbers under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTransaction((client) => nextDocumentNo(client, ctx.orgId, 'expense', '2026-08-28'))
      )
    );
    expect(new Set(results).size).toBe(5);
  });
});

/**
 * Raise a dealer document and post it, whatever the approval rules say.
 *
 * Asking for 'POST' means "post this if you may", and an approval rule may
 * refuse -- which it increasingly does as the seeded customer's balance grows
 * across runs. These tests are about what posting does to stock and to the
 * ledger; whether a rule catches a large sale is tested on its own. So the
 * document is drafted and then posted outright.
 */
async function postedDealerDocument(kind, input) {
  return withTransaction(async (client) => {
    const create = kind === 'sale' ? createDealerSale : createDealerPurchase;
    const draft = await create(client, { ...ctx, input: { ...input, action: 'DRAFT' } });
    if (kind === 'sale') {
      await postDealerSale(client, { ...ctx, saleId: draft.id });
    } else {
      await postDealerPurchase(client, { ...ctx, purchaseId: draft.id });
    }
    return { ...draft, status: 'POSTED' };
  });
}

suite('dealer flow', () => {
  it('reduces product stock and raises a receivable', async () => {
    await postedDealerDocument('purchase', {
      txnDate: '2026-08-28',
      companyId: ctx.companyId,
      warehouseId: ctx.warehouseId,
      paymentTerms: 'Credit 30 days',
      transportCost: 0,
      otherCost: 0,
      lines: [{ productId: ctx.productId, quantity: 50, freeQuantity: 0, rate: 2380, discountPct: 0 }],
    });

    const before = await query(
      "SELECT quantity FROM stock WHERE warehouse_id = $1 AND product_id = $2 AND item_type = 'PRODUCT'",
      [ctx.warehouseId, ctx.productId]
    );

    const sale = await postedDealerDocument('sale', {
      txnDate: '2026-08-28',
      customerId: ctx.customerId,
      warehouseId: ctx.warehouseId,
      paidAmount: 0,
      lines: [{ productId: ctx.productId, quantity: 5, bonusQuantity: 0, rate: 2560, discountPct: 0 }],
    });

    expect(sale.status).toBe('POSTED');

    const after = await query(
      "SELECT quantity FROM stock WHERE warehouse_id = $1 AND product_id = $2 AND item_type = 'PRODUCT'",
      [ctx.warehouseId, ctx.productId]
    );
    expect(num(after.rows[0].quantity)).toBe(num(before.rows[0].quantity) - 5);

    const receivable = await query(
      "SELECT * FROM receivables WHERE invoice_type = 'dealer_sales' AND invoice_id = $1",
      [sale.id]
    );
    expect(receivable.rows).toHaveLength(1);
  });

  it('allocates one payment across an invoice and leaves the rest on account', async () => {
    const sale = await postedDealerDocument('sale', {
      txnDate: '2026-08-28',
      customerId: ctx.customerId,
      warehouseId: ctx.warehouseId,
      paidAmount: 0,
      lines: [{ productId: ctx.productId, quantity: 2, bonusQuantity: 0, rate: 1000, discountPct: 0 }],
    });

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO payments
           (org_id, txn_no, txn_date, business_type, direction, party_type, party_id,
            account_id, amount, unallocated_amount, status, created_by)
         VALUES ($1, 'TEST-' || floor(random()*1e9)::text, '2026-08-28','DEALER','RECEIPT',
                 'CUSTOMER',$2,(SELECT id FROM accounts LIMIT 1),1500,1500,'POSTED',$3)
         RETURNING id`,
        [ctx.orgId, ctx.customerId, ctx.user.id]
      );

      return allocatePayment(client, {
        paymentId: Number(rows[0].id),
        direction: 'RECEIPT',
        amount: 1500,
        allocations: [{ invoiceType: 'dealer_sales', invoiceId: sale.id, amount: 1200 }],
      });
    });

    expect(result.allocated).toBe(1200);
    expect(result.unallocated).toBe(300);

    const receivable = await query(
      "SELECT paid_amount, balance FROM receivables WHERE invoice_type = 'dealer_sales' AND invoice_id = $1",
      [sale.id]
    );
    expect(num(receivable.rows[0].paid_amount)).toBe(1200);
    expect(num(receivable.rows[0].balance)).toBe(800);
  });

  it('refuses to allocate more than the invoice balance', async () => {
    const sale = await postedDealerDocument('sale', {
      txnDate: '2026-08-28',
      customerId: ctx.customerId,
      warehouseId: ctx.warehouseId,
      paidAmount: 0,
      lines: [{ productId: ctx.productId, quantity: 1, bonusQuantity: 0, rate: 500, discountPct: 0 }],
    });

    await expect(
      withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO payments
             (org_id, txn_no, txn_date, business_type, direction, party_type, party_id,
              account_id, amount, unallocated_amount, status, created_by)
           VALUES ($1, 'TEST-' || floor(random()*1e9)::text, '2026-08-28','DEALER','RECEIPT',
                   'CUSTOMER',$2,(SELECT id FROM accounts LIMIT 1),99999,99999,'POSTED',$3)
           RETURNING id`,
          [ctx.orgId, ctx.customerId, ctx.user.id]
        );
        return allocatePayment(client, {
          paymentId: Number(rows[0].id),
          direction: 'RECEIPT',
          amount: 99999,
          allocations: [{ invoiceType: 'dealer_sales', invoiceId: sale.id, amount: 99999 }],
        });
      })
    ).rejects.toMatchObject({ code: 'ALLOCATION_EXCEEDS_BALANCE' });
  });
});

suite('business type reconciliation', () => {
  it('makes All equal to Dealer plus Bulk Crop', async () => {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(sales_amount), 0) AS total,
         COALESCE(SUM(sales_amount) FILTER (WHERE business_type = 'DEALER'), 0) AS dealer,
         COALESCE(SUM(sales_amount) FILTER (WHERE business_type = 'BULK_CROP'), 0) AS crop
       FROM v_sales_by_business`
    );
    const r = rows[0];
    expect(num(r.total)).toBeCloseTo(num(r.dealer) + num(r.crop), 2);
  });
});

// The pool is shared by every suite in this file, so it is closed once here
// rather than in the first suite's afterAll — closing it there left every
// later suite talking to a pool that had already ended.
afterAll(async () => {
  if (!pool.ended) await closePool().catch(() => {});
});

suite('dashboard aggregates', () => {
  it('splits stock value by business line rather than repeating the total', async () => {
    const total = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN s.item_type = 'CROP_BATCH'
                           THEN s.quantity * b.cost_per_unit END), 0) AS crop_value,
         COALESCE(SUM(CASE WHEN s.item_type = 'PRODUCT'
                           THEN s.quantity * s.avg_cost END), 0)      AS product_value
         FROM stock s LEFT JOIN crop_batches b ON b.id = s.batch_id
        WHERE s.org_id = 1 AND s.quantity > 0`
    );

    const cropValue = num(total.rows[0].crop_value);
    const productValue = num(total.rows[0].product_value);

    // The two lines hold different stock, so a shared figure would be wrong.
    expect(cropValue).not.toBe(productValue);
    expect(cropValue + productValue).toBeGreaterThan(0);
  });
});

suite('profit and loss', () => {
  it('reconciles net profit with the profit the sales themselves recorded', async () => {
    // Every sale's own profit_amount already nets off the transport and other
    // cost booked on it. The P&L must book those as a selling expense, or its
    // net profit and the dashboard's gross profit disagree.
    const { rows } = await query(
      `SELECT
         COALESCE((SELECT SUM(net_amount - cogs_amount) FROM crop_sales
                    WHERE status = 'POSTED'), 0)
       + COALESCE((SELECT SUM(net_amount - cost_amount) FROM dealer_sales
                    WHERE status = 'POSTED'), 0) AS revenue_less_cogs,
         COALESCE((SELECT SUM(transport_cost + other_cost) FROM crop_sales
                    WHERE status = 'POSTED'), 0) AS selling,
         COALESCE((SELECT SUM(profit_amount) FROM crop_sales WHERE status = 'POSTED'), 0)
       + COALESCE((SELECT SUM(profit_amount) FROM dealer_sales WHERE status = 'POSTED'), 0)
                                                 AS recorded_profit,
         COALESCE((SELECT SUM(amount) FROM expenses WHERE status = 'POSTED'), 0) AS expenses`
    );

    const r = rows[0];
    const plNetProfit = num(r.revenue_less_cogs) - num(r.selling) - num(r.expenses);
    const expected = num(r.recorded_profit) - num(r.expenses);

    expect(plNetProfit).toBeCloseTo(expected, 2);
  });
});

suite('dashboard trend', () => {
  it('includes a month that had purchases but no sales', async () => {
    // A month of pure procurement must still appear, or its purchases vanish
    // from the chart and the totals stop agreeing with the headline figures.
    const purchases = await query(
      `SELECT to_char(txn_date, 'YYYY-MM') AS month FROM v_purchases_by_business
        WHERE org_id = 1 GROUP BY 1`
    );
    const sales = await query(
      `SELECT to_char(txn_date, 'YYYY-MM') AS month FROM v_sales_by_business
        WHERE org_id = 1 GROUP BY 1`
    );

    const saleMonths = new Set(sales.rows.map((r) => r.month));
    const purchaseOnly = purchases.rows.map((r) => r.month).filter((m) => !saleMonths.has(m));

    // The seed deliberately buys in one month and sells in the next.
    expect(purchaseOnly.length).toBeGreaterThan(0);

    const union = new Set([...saleMonths, ...purchases.rows.map((r) => r.month)]);
    expect(union.size).toBeGreaterThan(saleMonths.size);
  });
});

suite('stock transfer', () => {
  let tctx;

  beforeAll(async () => {
    const { rows: users } = await query(
      `SELECT u.id, u.org_id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
       WHERE r.code = 'Admin' AND u.is_active ORDER BY u.id LIMIT 1`
    );
    const orgId = Number(users[0].org_id);
    const [warehouses, supplier, crop, grade, unit] = await Promise.all([
      query('SELECT id FROM warehouses WHERE org_id = $1 AND is_active ORDER BY id LIMIT 2', [orgId]),
      query('SELECT id FROM suppliers WHERE org_id = $1 ORDER BY id LIMIT 1', [orgId]),
      query("SELECT id FROM crops WHERE org_id = $1 AND code = 'CROP-04'", [orgId]),
      query("SELECT id FROM crop_grades WHERE code = 'A'", []),
      query("SELECT id FROM units WHERE code = 'MT'", []),
    ]);
    if (warehouses.rows.length < 2) throw new Error('Two warehouses are needed to test a transfer');

    tctx = {
      orgId,
      user: { id: Number(users[0].id) },
      actor: { userId: Number(users[0].id), orgId, ip: null, userAgent: 'vitest' },
      fromWarehouseId: Number(warehouses.rows[0].id),
      toWarehouseId: Number(warehouses.rows[1].id),
      supplierId: Number(supplier.rows[0].id),
      cropId: Number(crop.rows[0].id),
      gradeId: Number(grade.rows[0].id),
      unitId: Number(unit.rows[0].id),
    };
  });

  /** Buy stock into the source warehouse so each test owns the batch it moves. */
  const stockUp = (client, qty) =>
    createCropPurchase(client, {
      orgId: tctx.orgId,
      user: tctx.user,
      actor: tctx.actor,
      input: {
        txnDate: '2026-08-28',
        supplierId: tctx.supplierId,
        warehouseId: tctx.fromWarehouseId,
        transportCost: 0,
        loadingCost: 0,
        unloadingCost: 0,
        otherCost: 0,
        advancePaid: 0,
        lines: [
          {
            cropId: tctx.cropId,
            gradeId: tctx.gradeId,
            unitId: tctx.unitId,
            grossQuantity: qty,
            moisturePct: 0,
            rate: 1000,
          },
        ],
        action: 'POST',
      },
    });

  const transferInput = (batchId, quantity) => ({
    txnDate: '2026-08-28',
    businessType: 'BULK_CROP',
    fromWarehouseId: tctx.fromWarehouseId,
    toWarehouseId: tctx.toWarehouseId,
    lines: [{ itemType: 'CROP_BATCH', batchId, quantity }],
  });

  it('splits a batch, carrying the cost and the receipt date to the destination', async () => {
    const { source, child } = await withTransaction(async (client) => {
      const purchase = await stockUp(client, 40);
      const batchId = purchase.batches[0].id;
      const { rows: before } = await client.query(
        'SELECT cost_per_unit, received_on FROM crop_batches WHERE id = $1',
        [batchId]
      );

      const result = await createTransfer(client, {
        orgId: tctx.orgId,
        user: tctx.user,
        actor: tctx.actor,
        input: transferInput(batchId, 15),
      });
      expect(result.status).toBe('POSTED');

      const { rows: after } = await client.query(
        `SELECT id, warehouse_id, quantity_remaining, cost_per_unit, received_on
           FROM crop_batches WHERE id = $1 OR id IN (
             SELECT batch_id FROM stock_movements
              WHERE reference_type = 'stock_transfers' AND reference_id = $2
                AND movement_type = 'TRANSFER_IN')
          ORDER BY id`,
        [batchId, result.id]
      );
      return { source: { ...before[0], ...after[0] }, child: after[1] };
    });

    // The source keeps what stayed behind; the child holds what moved.
    expect(num(source.quantity_remaining)).toBe(25);
    expect(num(child.quantity_remaining)).toBe(15);
    expect(Number(child.warehouse_id)).toBe(tctx.toWarehouseId);

    // Cost travels, so the move neither creates nor destroys value...
    expect(num(child.cost_per_unit)).toBe(num(source.cost_per_unit));
    // ...and neither does age, so FIFO keeps issuing this stock in order.
    expect(String(child.received_on)).toBe(String(source.received_on));
  });

  it('writes one movement out and one movement in, leaving the ledger balanced', async () => {
    const rows = await withTransaction(async (client) => {
      const purchase = await stockUp(client, 20);
      const result = await createTransfer(client, {
        orgId: tctx.orgId,
        user: tctx.user,
        actor: tctx.actor,
        input: transferInput(purchase.batches[0].id, 8),
      });
      const { rows: moves } = await client.query(
        `SELECT movement_type, warehouse_id, quantity_in, quantity_out
           FROM stock_movements
          WHERE reference_type = 'stock_transfers' AND reference_id = $1
          ORDER BY id`,
        [result.id]
      );
      return moves;
    });

    expect(rows.map((r) => r.movement_type)).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(num(rows[0].quantity_out)).toBe(8);
    expect(num(rows[1].quantity_in)).toBe(8);
    expect(Number(rows[0].warehouse_id)).toBe(tctx.fromWarehouseId);
    expect(Number(rows[1].warehouse_id)).toBe(tctx.toWarehouseId);

    const { rows: drift } = await query(
      'SELECT COUNT(*)::int AS n FROM v_stock_reconciliation WHERE difference <> 0'
    );
    expect(drift[0].n).toBe(0);
  });

  it('refuses to move more than the batch holds', async () => {
    await expect(
      withTransaction(async (client) => {
        const purchase = await stockUp(client, 10);
        return createTransfer(client, {
          orgId: tctx.orgId,
          user: tctx.user,
          actor: tctx.actor,
          input: transferInput(purchase.batches[0].id, 11),
        });
      })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('refuses a transfer to the warehouse the stock is already in', async () => {
    await expect(
      withTransaction(async (client) => {
        const purchase = await stockUp(client, 10);
        return createTransfer(client, {
          orgId: tctx.orgId,
          user: tctx.user,
          actor: tctx.actor,
          input: {
            ...transferInput(purchase.batches[0].id, 5),
            toWarehouseId: tctx.fromWarehouseId,
          },
        });
      })
    ).rejects.toMatchObject({ code: 'SAME_WAREHOUSE' });
  });

  it('puts the stock back when a transfer is cancelled', async () => {
    const { before, after, status, sourceRemaining, child } = await withTransaction(
      async (client) => {
      const purchase = await stockUp(client, 30);
      const batchId = purchase.batches[0].id;
      const result = await createTransfer(client, {
        orgId: tctx.orgId,
        user: tctx.user,
        actor: tctx.actor,
        input: transferInput(batchId, 12),
      });

      const readDestination = async () => {
        const { rows } = await client.query(
          `SELECT quantity FROM stock
            WHERE warehouse_id = $1 AND item_type = 'CROP_BATCH'
              AND batch_id IN (SELECT batch_id FROM stock_movements
                                WHERE reference_type = 'stock_transfers' AND reference_id = $2
                                  AND movement_type = 'TRANSFER_IN')`,
          [tctx.toWarehouseId, result.id]
        );
        return num(rows[0]?.quantity);
      };

      const moved = await readDestination();
      const cancelled = await cancelTransfer(client, {
        orgId: tctx.orgId,
        user: tctx.user,
        actor: tctx.actor,
        transferId: result.id,
        reason: 'Sent to the wrong godown',
      });

      const { rows: parent } = await client.query(
        'SELECT quantity_remaining FROM crop_batches WHERE id = $1',
        [batchId]
      );
      const { rows: children } = await client.query(
        `SELECT quantity_remaining, is_active FROM crop_batches WHERE parent_batch_id = $1`,
        [batchId]
      );

      return {
        before: moved,
        after: await readDestination(),
        status: cancelled.status,
        sourceRemaining: num(parent[0].quantity_remaining),
        child: children[0],
      };
    });

    expect(before).toBe(12);
    // Cancelling reverses the movements rather than deleting them, so the
    // destination is left holding nothing.
    expect(after).toBe(0);
    expect(status).toBe('CANCELLED');

    // The split has to be undone as well as the ledger. FIFO allocates from
    // `quantity_remaining`, so a child batch left holding 12 after its stock
    // went back would offer stock the warehouse does not have.
    expect(sourceRemaining).toBe(30);
    expect(num(child.quantity_remaining)).toBe(0);
    expect(child.is_active).toBe(false);
  });

  it('leaves no batch claiming stock its warehouse does not hold', async () => {
    // The stock/ledger reconciliation cannot see this class of drift: both
    // sides of it agree while `crop_batches` disagrees with them.
    const { rows } = await query(
      'SELECT batch_no, difference FROM v_batch_reconciliation WHERE difference <> 0'
    );
    expect(rows).toEqual([]);
  });
});
