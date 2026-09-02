import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { masters } from './helpers/fixture.js';

/**
 * The number on a form before anything has been posted.
 *
 * Each document screen shows the number its document is about to be given.
 * They showed a constant -- every crop sale was going to be SC-2608-052 --
 * so a clerk who wrote it on a paper file before posting had recorded a
 * document that would never exist.
 *
 * It is a prediction rather than a reservation, which is the trade being
 * tested here: looking must not consume a number, and posting must get the
 * one that was shown.
 */
const suite = HAS_DB ? describe : describe.skip;

afterAll(async () => {
  await closePool();
});
suite('the number a document is about to be given', () => {
  let app;
  let fx;

  beforeAll(async () => {
    app = createApp();
    fx = await masters(app);
  });

  const peek = (qs = '') =>
    request(app).get(`/api/workspace/document-numbers${qs}`).set(fx.auth);

  it('predicts exactly what the next post is given', async () => {
    // The forms show this before anything exists. It used to be a constant, so
    // the number on screen and the number the document got were unrelated.
    const before = await peek('?date=2026-09-02');
    expect(before.status).toBe(200);
    const predicted = before.body.data.numbers.dealer_purchase;

    const posted = await request(app)
      .post('/api/dealer/purchases')
      .set(fx.auth)
      .send({
        txnDate: '2026-09-02',
        companyId: fx.principal.id,
        warehouseId: fx.warehouse.id,
        lines: [{ productId: fx.product.id, quantity: 1, rate: 10 }],
        action: 'POST',
      });

    expect(posted.body.data.txnNo).toBe(predicted);
  });

  it('moves on once that number is taken', async () => {
    const first = (await peek('?date=2026-09-02')).body.data.numbers.dealer_purchase;
    await request(app)
      .post('/api/dealer/purchases')
      .set(fx.auth)
      .send({
        txnDate: '2026-09-02',
        companyId: fx.principal.id,
        warehouseId: fx.warehouse.id,
        lines: [{ productId: fx.product.id, quantity: 1, rate: 10 }],
        action: 'POST',
      });
    const second = (await peek('?date=2026-09-02')).body.data.numbers.dealer_purchase;

    expect(second).not.toBe(first);
  });

  it('does not consume a number just for looking', async () => {
    // Reserving one would burn a number every time somebody opened a form and
    // thought better of it, leaving holes in the sequence.
    const a = (await peek('?date=2026-09-02')).body.data.numbers.crop_sale;
    const b = (await peek('?date=2026-09-02')).body.data.numbers.crop_sale;
    const c = (await peek('?date=2026-09-02')).body.data.numbers.crop_sale;

    expect([b, c]).toEqual([a, a]);
  });

  it('numbers a back-dated document into its own month', async () => {
    const september = (await peek('?date=2026-09-15')).body.data.numbers.crop_purchase;
    const october = (await peek('?date=2026-10-15')).body.data.numbers.crop_purchase;

    expect(september).toContain('-2609-');
    expect(october).toContain('-2610-');
  });

  it('answers for every type a form shows one for', async () => {
    const { numbers } = (await peek()).body.data;
    expect(Object.keys(numbers).sort()).toEqual(
      ['crop_batch', 'crop_purchase', 'crop_sale', 'dealer_purchase', 'dealer_sale'].sort()
    );
    for (const [type, no] of Object.entries(numbers)) {
      expect(no, type).toMatch(/^[A-Z]+-\d{4}-\d+$/);
    }
  });
});
