import { Router } from 'express';
import { z } from 'zod';
import { handler, ok, created, parseBody, parseParams, idParamSchema } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { conflict } from '../lib/errors.js';
import {
  loadPermissionMatrix,
  createRole,
  updateRole,
  deleteRole,
  setRolePermissions,
} from '../services/roleService.js';

/**
 * Roles and what they may do.
 *
 * Reading rides on `settings.view`, which Management holds: a director should
 * be able to see how access is cut without being able to re-cut it. Every
 * write needs `role.edit`, which only Admin starts with -- and which can be
 * given to another role from this very screen, so long as somebody is left
 * holding it.
 */
const router = Router();

router.get(
  '/',
  requirePermission('settings.view'),
  handler(async (_req, res) => {
    ok(res, await loadPermissionMatrix());
  })
);

/**
 * A role's code is what `user.role` prints and what the seed and migrations
 * refer to, so it is a name rather than free text: letters, digits and spaces,
 * beginning with a letter.
 */
const roleSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z][A-Za-z0-9 _-]*$/, 'Use letters, digits, spaces, dashes or underscores.'),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(240).optional().default(''),
  permissions: z.array(z.string().trim().max(80)).optional(),
});

router.post(
  '/',
  requirePermission('role.edit'),
  handler(async (req, res) => {
    const body = parseBody(roleSchema, req);
    const id = await createRole(body, req.actor);
    const matrix = await loadPermissionMatrix();
    created(res, { id, role: matrix.roleList.find((r) => r.id === id), permissions: matrix });
  })
);

const rolePatchSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(240).optional(),
});

router.patch(
  '/:id',
  requirePermission('role.edit'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    await updateRole(id, parseBody(rolePatchSchema, req), req.actor);
    ok(res, await loadPermissionMatrix());
  })
);

router.delete(
  '/:id',
  requirePermission('role.edit'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    await deleteRole(id, req.actor);
    ok(res, await loadPermissionMatrix());
  })
);

/**
 * Grant and revoke, one module at a time.
 *
 * `scope` is the set of codes the caller is deciding -- a module's worth --
 * and `permissions` the ones inside it that should end up granted. Sending the
 * scope rather than the whole role's grants is what lets two people edit two
 * modules of one role without either erasing the other's work.
 */
const grantSchema = z
  .object({
    scope: z.array(z.string().trim().max(80)).min(1),
    permissions: z.array(z.string().trim().max(80)).default([]),
  })
  .refine((v) => v.permissions.every((code) => v.scope.includes(code)), {
    message: 'Every permission being granted has to be inside the scope being decided.',
    path: ['permissions'],
  });

router.put(
  '/:id/permissions',
  requirePermission('role.edit'),
  handler(async (req, res) => {
    const { id } = parseParams(idParamSchema, req);
    const body = parseBody(grantSchema, req);

    // Revoking your own right to change roles, in the same request, would
    // leave the screen you are looking at refusing you. The guardrail in the
    // service only asks whether *somebody* is left; this asks whether it is
    // still you, because doing it by accident is easy and undoing it is not.
    if (
      body.scope.includes('role.edit') &&
      !body.permissions.includes('role.edit') &&
      req.user.roles.length === 1 &&
      req.user.permissions.includes('role.edit')
    ) {
      const matrix = await loadPermissionMatrix();
      const role = matrix.roleList.find((r) => r.id === id);
      if (role && req.user.roles.includes(role.code)) {
        throw conflict(
          'WOULD_REVOKE_OWN_ACCESS',
          `${role.code} is your own role. Revoking it here would take away your access to ` +
            'this screen. Grant the permission to another role you hold first.'
        );
      }
    }

    await setRolePermissions(id, body, req.actor);
    ok(res, await loadPermissionMatrix());
  })
);

export default router;
