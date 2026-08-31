import { Router } from 'express';
import { z } from 'zod';
import { handler, ok, created, parseBody, parseParams, idParamSchema } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { hashPassword } from '../services/authService.js';
import {
  loadUserAccounts,
  createUserAccount,
  updateUserAccount,
  resetUserPassword,
} from '../services/roleService.js';

/**
 * User accounts.
 *
 * A role is only worth cutting if somebody can be put in it, and until now
 * nothing could: the Employees screen printed the role a person held and had
 * no way to change it, and the employee retirement rule refused while "the
 * user account is active" without offering anywhere to deactivate one.
 *
 * The whole router needs `user.manage`. A username, when someone last signed
 * in and whether they are still allowed to is not the same information as the
 * team directory, so it is not shown to everyone who can read that.
 */
const router = Router();

router.use(requirePermission('user.manage'));

router.get(
  '/',
  handler(async (req, res) => {
    ok(res, await loadUserAccounts(req.orgId));
  })
);

/**
 * A password set by an administrator is temporary by construction -- the
 * account is flagged as needing a change -- but it still travels to the person
 * it belongs to, so it has to be long enough not to be guessed on the way.
 * Ten characters is the same floor `changePassword` applies.
 */
const passwordField = z
  .string()
  .min(10, 'Choose a password of at least 10 characters.')
  .max(200);

const createSchema = z.object({
  employeeId: z.coerce.number().int().positive(),
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9._-]+$/, 'A username is lowercase letters, digits, dots, dashes or underscores.'),
  email: z.string().trim().email().or(z.literal('')).optional(),
  password: passwordField,
  roles: z.array(z.string().trim().min(1).max(40)).min(1, 'Give the account at least one role.'),
});

router.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(createSchema, req);
    const id = await createUserAccount(
      { ...body, passwordHash: await hashPassword(body.password) },
      req.orgId,
      req.actor
    );
    created(res, { id, accounts: await loadUserAccounts(req.orgId) });
  })
);

const patchSchema = z
  .object({
    roles: z.array(z.string().trim().min(1).max(40)).min(1).optional(),
    active: z.boolean().optional(),
    email: z.string().trim().email().or(z.literal('')).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

router.patch(
  '/:id',
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    await updateUserAccount(id, parseBody(patchSchema, req), req.orgId, req.actor);
    ok(res, await loadUserAccounts(req.orgId));
  })
);

router.post(
  '/:id/password',
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const { password } = parseBody(z.object({ password: passwordField }), req);
    await resetUserPassword(id, await hashPassword(password), req.orgId, req.actor);
    ok(res, await loadUserAccounts(req.orgId));
  })
);

export default router;
