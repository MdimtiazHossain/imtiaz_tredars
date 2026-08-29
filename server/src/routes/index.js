import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import authRoutes from './auth.js';
import workspaceRoutes from './workspace.js';
import masterRoutes from './masters.js';
import dealerRoutes from './dealer.js';
import cropRoutes from './crops.js';
import inventoryRoutes from './inventory.js';
import financeRoutes from './finance.js';
import approvalRoutes from './approvals.js';
import reportRoutes from './reports.js';
import auditRoutes from './audit.js';

/**
 * API surface.
 *
 * `/api/auth` is public up to sign-in; everything after `authenticate` requires
 * a valid token, and each route additionally declares the permission it needs.
 */
const router = Router();

router.use('/auth', authRoutes);

router.use(authenticate);

router.use('/workspace', workspaceRoutes);
router.use('/', masterRoutes);
router.use('/dealer', dealerRoutes);
router.use('/crops', cropRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/', financeRoutes);
router.use('/approvals', approvalRoutes);
router.use('/reports', reportRoutes);
// The dashboard is one of the report aggregates; expose it at its own path too.
router.use('/dashboard', reportRoutes);
router.use('/audit', auditRoutes);

export default router;
