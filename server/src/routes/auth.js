import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config } from '../lib/config.js';
import { handler, ok, parseBody } from '../lib/http.js';
import { authenticate } from '../middleware/auth.js';
import { login, refresh, logout, changePassword } from '../services/authService.js';
import { loadSignInContext } from '../services/settingsService.js';

const router = Router();

/**
 * Sign-in is rate limited far more tightly than the rest of the API, so a
 * stolen username cannot be brute-forced.
 */
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many sign-in attempts. Please wait a minute and try again.',
    },
  },
});

/**
 * Who this installation belongs to, before anyone has signed in.
 *
 * The sign-in card names the business, and it cannot read the workspace to
 * find out -- that needs a token. This is the only endpoint answering without
 * one, and it carries nothing that is not already on the company's own
 * invoices: the name, and what the system is called.
 */
router.get(
  '/context',
  handler(async (_req, res) => {
    ok(res, await loadSignInContext(config.orgId));
  })
);

const loginSchema = z.object({
  username: z.string().min(1, 'Enter your username').max(64),
  password: z.string().min(1, 'Enter your password').max(200),
});

router.post(
  '/login',
  loginLimiter,
  handler(async (req, res) => {
    const body = parseBody(loginSchema, req);
    const result = await login({
      username: body.username,
      password: body.password,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    ok(res, {
      user: {
        id: result.user.id,
        name: result.user.name,
        username: result.user.username,
        role: result.user.role,
        roles: result.user.roles,
        permissions: result.user.permissions,
        designation: result.user.designation,
      },
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
    });
  })
);

router.post(
  '/refresh',
  handler(async (req, res) => {
    const body = parseBody(z.object({ refreshToken: z.string().min(10) }), req);
    const result = await refresh({ refreshToken: body.refreshToken });
    ok(res, {
      user: {
        id: result.user.id,
        name: result.user.name,
        role: result.user.role,
        permissions: result.user.permissions,
      },
      accessToken: result.accessToken,
    });
  })
);

router.post(
  '/logout',
  handler(async (req, res) => {
    const body = parseBody(z.object({ refreshToken: z.string().optional() }), req);
    await logout({ refreshToken: body.refreshToken, actor: req.actor });
    ok(res, { signedOut: true });
  })
);

/** Who am I — used by the client on boot to restore a session. */
router.get(
  '/me',
  authenticate,
  handler(async (req, res) => {
    ok(res, {
      id: req.user.id,
      name: req.user.name,
      username: req.user.username,
      role: req.user.role,
      roles: req.user.roles,
      permissions: req.user.permissions,
      designation: req.user.designation,
    });
  })
);

router.post(
  '/change-password',
  authenticate,
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(10, 'Choose a password of at least 10 characters'),
      }),
      req
    );
    await changePassword({
      userId: req.user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      actor: req.actor,
    });
    ok(res, { changed: true });
  })
);

export default router;
