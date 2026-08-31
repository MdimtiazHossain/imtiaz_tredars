import request from 'supertest';
import { expect } from 'vitest';

/**
 * Post a document, and see it through approval if a rule catches it.
 *
 * A create endpoint answers 201 whether the document posted or went to the
 * approval queue, and the queue is not a failure -- it is the system working.
 * A test that asserts only on the status code therefore passes just as
 * happily when nothing was posted at all, which is how a suite comes to
 * report green while the stock never moved and the ledger stayed empty.
 *
 * That is not hypothetical here: the approval rules fire on amount, the
 * suites share a database, and as the seeded customer's balance grows across
 * runs the same sale that posted this morning goes to the queue this
 * afternoon. Tests that need a posted document say so, and this is how they
 * get one.
 *
 * @param {object} app       the express app
 * @param {() => object} auth  headers for an approver
 * @param {string} path      e.g. '/api/dealer/sales'
 * @param {object} body      the document
 * @returns {Promise<object>} the created document's data, once POSTED
 */
export async function postDocument(app, auth, path, body) {
  const res = await request(app).post(path).set(auth()).send(body);
  expect(res.status, `${path}: ${JSON.stringify(res.body.error)}`).toBe(201);

  const created = res.body.data;
  if (created.status !== 'PENDING_APPROVAL') return created;

  const queue = await request(app)
    .get('/api/approvals?status=PENDING&pageSize=200')
    .set(auth());
  // The queue names the document in `reference`, and an approval can also be
  // found by the entity it blocks -- either identifies it.
  const waiting = (queue.body.data || []).find(
    (a) => a.reference === created.txnNo || Number(a.entityId) === Number(created.id)
  );
  expect(waiting, `${created.txnNo} went for approval but is not in the queue`).toBeTruthy();

  const decided = await request(app)
    .post(`/api/approvals/${waiting.id}/decide`)
    .set(auth())
    .send({ approved: true, comment: 'Approved by the test suite' });
  expect(decided.status, JSON.stringify(decided.body.error)).toBe(200);

  return { ...created, status: 'POSTED', approvedFrom: waiting.id };
}
