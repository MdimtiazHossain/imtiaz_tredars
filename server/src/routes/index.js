import { Router } from 'express';
import { authenticate, requirePasswordChange } from '../middleware/auth.js';
import authRoutes from './auth.js';
import workspaceRoutes from './workspace.js';
import masterRoutes from './masters.js';
import dealerRoutes from './dealer.js';
import cropRoutes from './crops.js';
import inventoryRoutes from './inventory.js';
import financeRoutes from './finance.js';
import returnRoutes from './returns.js';
import approvalRoutes from './approvals.js';
import reportRoutes from './reports.js';
import auditRoutes from './audit.js';
import settingsRoutes from './settings.js';
import roleRoutes from './roles.js';
import userRoutes from './users.js';

/**
 * API surface.
 *
 * `/api/auth` is public up to sign-in; everything after `authenticate` requires
 * a valid token, and each route additionally declares the permission it needs.
 */
const router = Router();

router.use('/auth', authRoutes);

router.use(authenticate);

// An account still holding the password it was created with may do nothing but
// replace it. `/auth` is mounted above this, so changing it is still reachable.
router.use(requirePasswordChange);

router.use('/workspace', workspaceRoutes);
router.use('/', masterRoutes);
router.use('/dealer', dealerRoutes);
router.use('/crops', cropRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/', financeRoutes);
router.use('/', returnRoutes);
router.use('/approvals', approvalRoutes);
router.use('/reports', reportRoutes);
router.use('/audit', auditRoutes);
router.use('/settings', settingsRoutes);
router.use('/roles', roleRoutes);
router.use('/users', userRoutes);

export default router;
