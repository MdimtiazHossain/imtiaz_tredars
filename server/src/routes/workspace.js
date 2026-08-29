import { Router } from 'express';
import { handler, ok } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { loadWorkspace } from '../services/workspaceService.js';

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

export default router;
