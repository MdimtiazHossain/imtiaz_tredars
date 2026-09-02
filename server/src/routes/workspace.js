import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { handler, ok, parseQuery } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { loadWorkspace } from '../services/workspaceService.js';
import { peekDocumentNo } from '../lib/numbering.js';

/**
 * The single endpoint the frontend's `Repository.load()` calls on boot.
 * It returns exactly the object the screens have always received, so the
 * repository swap is invisible above this line.
 */
const router = Router();

router.get(
  '/',
  requirePermission('dashboard.view'),
  handler(async (req, res) => {
    const data = await loadWorkspace({ orgId: req.orgId, user: req.user });
    ok(res, data);
  })
);

/** The document types a screen shows a number for before anything is posted. */
const PREVIEWED = ['crop_purchase', 'crop_sale', 'dealer_purchase', 'dealer_sale', 'crop_batch'];

/**
 * The number each document type would get if something were posted today.
 *
 * The forms display the number the document is about to be given. They showed a
 * constant, so every crop sale was going to be SC-2608-052 whatever the
 * sequence actually stood at.
 *
 * The date matters: numbers carry the YYMM of the document, so a purchase
 * back-dated into last month takes last month's series.
 *
 * These are predictions and not reservations -- reserving one would burn a
 * number every time somebody opened a form and thought better of it. Whoever
 * posts first takes it.
 */
router.get(
  '/document-numbers',
  requirePermission('dashboard.view'),
  handler(async (req, res) => {
    const { date } = parseQuery(z.object({ date: z.string().date().optional() }), req);
    const on = date || new Date().toISOString().slice(0, 10);

    const numbers = {};
    for (const docType of PREVIEWED) {
      numbers[docType] = await peekDocumentNo({ query }, req.orgId, docType, on);
    }

    ok(res, { date: on, numbers });
  })
);

export default router;
