import { query, withTransaction } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { notFound, unprocessable, conflict } from '../lib/errors.js';

/**
 * Roles, and what each one may do.
 *
 * The permission model was real from the first migration -- `authenticate`
 * loads a user's grants from the database on every request, so the API has
 * always refused what a role does not hold. What it had no way of doing was
 * changing. The six roles and their grants were written once by the seed
 * script and after that the only way to let the accounts officer record an
 * expense was an INSERT by hand.
 *
 * This is the administration the model was missing: the permission catalogue
 * grouped into the modules the Settings screen draws, the roles holding them,
 * and the writes that move a grant from one to the other. Every write is
 * audited, and every one of them checks afterwards that somebody is still left
 * who can undo it.
 */

/* ------------------------------------------------------------- the catalogue */

/**
 * How permissions group into the rows of the matrix.
 *
 * Each module lists its permissions weakest first with the word the matrix
 * shows for it. A role holding all of them reads 'Full', one holding none
 * reads the module's empty label, and anything between reads the strongest it
 * actually holds -- so 'Create' means create and view, as the ladder implies.
 *
 * The list is a presentation order, not the source of truth: any permission a
 * later migration adds and this list does not mention is still granted and
 * revoked, under a module of its own at the end, rather than becoming a code
 * no screen can reach.
 */
const MODULES = [
  { key: 'dashboard', label: 'Dashboard', permissions: [['dashboard.view', 'View']] },
  {
    key: 'crop_purchase',
    label: 'Crop purchase',
    permissions: [
      ['crop.purchase.view', 'View'], ['crop.purchase.create', 'Create'],
      ['crop.purchase.post', 'Post'], ['crop.purchase.cancel', 'Cancel'],
    ],
  },
  {
    key: 'crop_sale',
    label: 'Crop sales',
    permissions: [
      ['crop.sale.view', 'View'], ['crop.sale.create', 'Create'],
      ['crop.sale.post', 'Post'], ['crop.sale.cancel', 'Cancel'],
    ],
  },
  {
    key: 'dealer_purchase',
    label: 'Dealer purchase',
    permissions: [
      ['dealer.purchase.view', 'View'], ['dealer.purchase.create', 'Create'],
      ['dealer.purchase.post', 'Post'], ['dealer.purchase.cancel', 'Cancel'],
    ],
  },
  {
    key: 'dealer_sale',
    label: 'Dealer sales',
    permissions: [
      ['dealer.sale.view', 'View'], ['dealer.sale.create', 'Create'],
      ['dealer.sale.post', 'Post'], ['dealer.sale.cancel', 'Cancel'],
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    permissions: [
      ['inventory.view', 'View'], ['inventory.transfer', 'Transfer'],
      ['inventory.adjust', 'Adjust'],
    ],
  },
  {
    key: 'customer',
    label: 'Customers',
    permissions: [
      ['customer.view', 'View'], ['customer.create', 'Create'],
      ['customer.edit', 'Edit'], ['customer.delete', 'Retire'],
    ],
  },
  {
    key: 'supplier',
    label: 'Suppliers',
    permissions: [
      ['supplier.view', 'View'], ['supplier.create', 'Create'],
      ['supplier.edit', 'Edit'], ['supplier.delete', 'Retire'],
    ],
  },
  {
    key: 'company',
    label: 'Companies',
    permissions: [
      ['company.view', 'View'], ['company.create', 'Create'],
      ['company.edit', 'Edit'], ['company.delete', 'Retire'],
    ],
  },
  {
    key: 'crop',
    label: 'Crops',
    permissions: [
      ['crop.view', 'View'], ['crop.create', 'Create'],
      ['crop.edit', 'Edit'], ['crop.delete', 'Retire'],
    ],
  },
  {
    key: 'product',
    label: 'Products',
    permissions: [
      ['product.view', 'View'], ['product.create', 'Create'],
      ['product.edit', 'Edit'], ['product.delete', 'Retire'],
    ],
  },
  {
    key: 'warehouse',
    label: 'Warehouses',
    // Reading the godown list rides on `inventory.view`; these three are what
    // opening, renaming and closing one need.
    permissions: [
      ['warehouse.create', 'Create'], ['warehouse.edit', 'Edit'],
      ['warehouse.delete', 'Close'],
    ],
  },
  {
    key: 'employee',
    label: 'Employees',
    permissions: [
      ['employee.view', 'View'], ['employee.create', 'Create'],
      ['employee.edit', 'Edit'], ['employee.delete', 'Retire'],
    ],
  },
  {
    key: 'payment',
    label: 'Payments',
    permissions: [['payment.view', 'View'], ['payment.create', 'Collect']],
  },
  {
    key: 'payment_method',
    label: 'Payment methods',
    permissions: [
      ['payment.method.create', 'Create'], ['payment.method.edit', 'Edit'],
      ['payment.method.delete', 'Retire'],
    ],
  },
  {
    key: 'expense',
    label: 'Expenses',
    permissions: [['expense.view', 'View'], ['expense.create', 'Record']],
  },
  {
    key: 'expense_category',
    label: 'Expense categories',
    permissions: [
      ['expense.category.create', 'Create'], ['expense.category.edit', 'Edit'],
      ['expense.category.delete', 'Retire'],
    ],
  },
  {
    key: 'account',
    label: 'Cash and bank accounts',
    permissions: [
      ['account.create', 'Create'], ['account.edit', 'Edit'], ['account.delete', 'Close'],
    ],
  },
  {
    key: 'unit',
    label: 'Units of measure',
    permissions: [['unit.create', 'Create'], ['unit.edit', 'Edit'], ['unit.delete', 'Retire']],
  },
  { key: 'report', label: 'Reports', permissions: [['report.view', 'View']] },
  {
    key: 'profit',
    label: 'Profit figures',
    permissions: [['report.profit', 'Full']],
    // Not seeing profit is a deliberate state with a name, not an absence.
    empty: 'Hidden',
  },
  {
    key: 'approval',
    label: 'Approvals',
    permissions: [['approval.view', 'Request'], ['approval.decide', 'Approve']],
  },
  {
    key: 'settings',
    label: 'Settings',
    permissions: [['settings.view', 'View'], ['settings.edit', 'Full']],
  },
  {
    key: 'access',
    label: 'Roles and logins',
    // Neither of these is a step up from the other: one cuts the roles, the
    // other decides who holds them. Holding both reads 'Full'.
    permissions: [['user.manage', 'Logins'], ['role.edit', 'Roles']],
  },
  { key: 'audit', label: 'Audit trail', permissions: [['audit.view', 'View']] },
];

/**
 * Permissions that no role may be left without, expressed as the question they
 * answer: if this change went through, could anyone still undo it?
 *
 * Revoking `role.edit` from the only role that holds it, or deactivating the
 * last login that holds such a role, locks the business out of its own
 * permission screen with no way back except a hand-written UPDATE. So the
 * writes below all end by asking whether an active user still holds each of
 * these, and refuse rather than leave the door shut.
 */
const INDISPENSABLE = [
  ['role.edit', 'change roles and permissions'],
  ['settings.edit', 'change the system settings'],
];

/** Turn the word for a code into a title when the catalogue does not name it. */
const humanise = (code) =>
  code.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * The catalogue: every permission the database defines, in modules.
 *
 * Read from `permissions` rather than from the list above, so a code added by
 * a migration is grantable the moment it exists.
 */
export async function loadPermissionCatalogue() {
  const { rows } = await query('SELECT code, description FROM permissions ORDER BY code');
  const described = new Map(rows.map((r) => [r.code, r.description || '']));
  const known = new Set();

  const modules = MODULES.map((module) => {
    const permissions = module.permissions
      .filter(([code]) => described.has(code))
      .map(([code, label]) => {
        known.add(code);
        return { code, label, description: described.get(code) };
      });
    return { key: module.key, label: module.label, empty: module.empty || '—', permissions };
  }).filter((module) => module.permissions.length);

  // Anything the list above does not mention still has to be reachable.
  const unclaimed = [...described.keys()].filter((code) => !known.has(code));
  if (unclaimed.length) {
    modules.push({
      key: 'other',
      label: 'Other permissions',
      empty: '—',
      permissions: unclaimed.map((code) => ({
        code,
        label: humanise(code),
        description: described.get(code),
      })),
    });
  }

  return modules;
}

/* -------------------------------------------------------------------- roles */

/** Every role, what it holds, and how many people hold it. */
export async function loadRoles() {
  const [roles, grants, holders] = await Promise.all([
    query(
      `SELECT id, code, name, description, is_system,
              to_char(updated_at, 'YYYY-MM-DD') AS updated_on
         FROM roles ORDER BY is_system DESC, id`
    ),
    query(
      `SELECT r.code AS role, p.code AS permission
         FROM role_permissions rp
         JOIN roles r       ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        ORDER BY p.code`
    ),
    query(
      `SELECT ur.role_id,
              COUNT(*)::int                             AS users,
              COUNT(*) FILTER (WHERE u.is_active)::int  AS active_users
         FROM user_roles ur JOIN users u ON u.id = ur.user_id
        GROUP BY ur.role_id`
    ),
  ]);

  const granted = new Map(roles.rows.map((r) => [r.code, []]));
  for (const g of grants.rows) granted.get(g.role)?.push(g.permission);

  const counts = new Map(holders.rows.map((r) => [Number(r.role_id), r]));

  return roles.rows.map((r) => {
    const count = counts.get(Number(r.id));
    return {
      id: Number(r.id),
      code: r.code,
      name: r.name,
      description: r.description || '',
      system: r.is_system,
      users: count ? count.users : 0,
      activeUsers: count ? count.active_users : 0,
      updatedOn: r.updated_on,
      granted: granted.get(r.code) || [],
    };
  });
}

/**
 * The permission matrix, as modules against roles.
 *
 * `roles` and `modules[].levels` are what the matrix table draws; `roleList`
 * and `modules[].permissions` are what editing one needs. One round trip
 * rather than two, because the screen shows both at once.
 */
export async function loadPermissionMatrix() {
  const [roles, catalogue] = await Promise.all([loadRoles(), loadPermissionCatalogue()]);
  const held = new Map(roles.map((r) => [r.code, new Set(r.granted)]));

  return {
    roles: roles.map((r) => r.code),
    roleList: roles,
    modules: catalogue.map((module) => ({
      key: module.key,
      label: module.label,
      empty: module.empty,
      permissions: module.permissions,
      levels: Object.fromEntries(
        roles.map((role) => {
          const set = held.get(role.code) || new Set();
          const owned = module.permissions.filter((p) => set.has(p.code));
          if (!owned.length) return [role.code, module.empty];
          if (owned.length === module.permissions.length) return [role.code, 'Full'];
          return [role.code, owned[owned.length - 1].label];
        })
      ),
    })),
  };
}

/* ----------------------------------------------------------------- guardrails */

/**
 * Refuse a change that would leave nobody able to undo it.
 *
 * Called at the end of every write, inside its transaction, so a change that
 * would close the door rolls back rather than being caught afterwards. It asks
 * about active users rather than about roles: a permission held only by a role
 * nobody holds is as good as not held at all.
 */
async function assertSomebodyCanStillAdminister(client) {
  for (const [code, what] of INDISPENSABLE) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS holders
         FROM users u
         JOIN user_roles ur       ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p       ON p.id = rp.permission_id
        WHERE p.code = $1 AND u.is_active`,
      [code]
    );
    if (!rows[0].holders) {
      throw unprocessable(
        'WOULD_LOCK_EVERYONE_OUT',
        `That would leave no active user able to ${what}. Give the permission to ` +
          'another role, or another role to another user, first.'
      );
    }
  }
}

/** Read one role, locked, or fail with a message naming it. */
async function loadRoleRow(client, id) {
  const { rows } = await client.query('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [id]);
  if (!rows.length) throw notFound('Role');
  return rows[0];
}

/* --------------------------------------------------------------- role writes */

/**
 * Add a role.
 *
 * A new role starts with whatever permissions were asked for, which is
 * normally none: the screen creates it and then grants, so the operator sees
 * exactly what they are handing over as they hand it over.
 */
export async function createRole({ code, name, description, permissions }, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO roles (code, name, description, is_system)
       VALUES ($1,$2,$3,false) RETURNING *`,
      [code, name, description || null]
    );
    const role = rows[0];

    if (permissions?.length) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, p.id FROM permissions p WHERE p.code = ANY($2::text[])`,
        [Number(role.id), permissions]
      );
    }

    await writeAudit(client, {
      actor,
      entityType: 'roles',
      entityId: Number(role.id),
      action: 'CREATE',
      newValue: { code: role.code, name: role.name, permissions: permissions || [] },
      summary: `Role ${role.name} added`,
    });

    return Number(role.id);
  });
}

/** Rename a role or change what it is for. Its code never moves. */
export async function updateRole(id, { name, description }, actor) {
  return withTransaction(async (client) => {
    const before = await loadRoleRow(client, id);

    const changes = [];
    if (name !== undefined) changes.push(['name', name]);
    if (description !== undefined) changes.push(['description', description || null]);
    if (!changes.length) return Number(before.id);

    const { rows } = await client.query(
      `UPDATE roles SET ${changes.map(([c], i) => `${c} = $${i + 1}`).join(', ')}
        WHERE id = $${changes.length + 1} RETURNING *`,
      [...changes.map(([, v]) => v), id]
    );

    await writeAudit(client, {
      actor,
      entityType: 'roles',
      entityId: id,
      action: 'UPDATE',
      oldValue: { name: before.name, description: before.description },
      newValue: { name: rows[0].name, description: rows[0].description },
      summary: `Role ${before.name} updated`,
    });

    return id;
  });
}

/**
 * Remove a role.
 *
 * The six seeded roles stay: the sign-in header, the Employees screen and the
 * nav all read a user's role by name, and a business that no longer wants one
 * can leave it unheld rather than delete it. Anything else goes once nobody
 * holds it -- deleting a held role would silently strip whoever held it.
 */
export async function deleteRole(id, actor) {
  return withTransaction(async (client) => {
    const role = await loadRoleRow(client, id);

    if (role.is_system) {
      throw unprocessable(
        'ROLE_IS_SYSTEM',
        `${role.name} is one of the roles the system is set up around, so it cannot be ` +
          'deleted. Change what it may do instead, or move its users to another role.'
      );
    }

    const { rows: held } = await client.query(
      'SELECT COUNT(*)::int AS users FROM user_roles WHERE role_id = $1',
      [id]
    );
    if (held[0].users) {
      throw conflict(
        'ROLE_IN_USE',
        `${role.name} is held by ${held[0].users} ` +
          `${held[0].users === 1 ? 'user' : 'users'}. Move them to another role first.`
      );
    }

    await client.query('DELETE FROM roles WHERE id = $1', [id]);
    await writeAudit(client, {
      actor,
      entityType: 'roles',
      entityId: id,
      action: 'DELETE',
      oldValue: { code: role.code, name: role.name },
      summary: `Role ${role.name} deleted`,
    });

    await assertSomebodyCanStillAdminister(client);
    return id;
  });
}

/**
 * Replace what a role holds, for one module or for all of it.
 *
 * The screen edits a module at a time -- a cell of the matrix is one role
 * against one module -- so `scope` is the set of codes being decided and
 * `permissions` the ones inside it that should end up granted. Anything
 * outside the scope is left alone, which is what makes two people editing two
 * different modules of the same role not overwrite each other.
 */
export async function setRolePermissions(id, { permissions, scope }, actor) {
  return withTransaction(async (client) => {
    const role = await loadRoleRow(client, id);

    const { rows: valid } = await client.query(
      'SELECT id, code FROM permissions WHERE code = ANY($1::text[])',
      [scope]
    );
    if (valid.length !== scope.length) {
      const known = new Set(valid.map((p) => p.code));
      throw notFound(`Permission ${scope.find((c) => !known.has(c))}`);
    }

    const wanted = new Set(permissions);
    const grant = valid.filter((p) => wanted.has(p.code));
    const revoke = valid.filter((p) => !wanted.has(p.code));

    const { rows: before } = await client.query(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 AND p.code = ANY($2::text[]) ORDER BY p.code`,
      [id, scope]
    );

    if (revoke.length) {
      await client.query(
        'DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = ANY($2::bigint[])',
        [id, revoke.map((p) => Number(p.id))]
      );
    }
    if (grant.length) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`,
        [id, grant.map((p) => Number(p.id))]
      );
    }

    const had = before.map((r) => r.code);
    const has = grant.map((p) => p.code).sort();
    if (had.join() !== has.join()) {
      // `updated_at` is what the roles list shows as "last changed"; the grant
      // rows live in another table, so touching the role itself is what
      // records that this role changed.
      await client.query('UPDATE roles SET updated_at = now() WHERE id = $1', [id]);
      await writeAudit(client, {
        actor,
        entityType: 'roles',
        entityId: id,
        action: 'UPDATE',
        oldValue: { permissions: had },
        newValue: { permissions: has },
        summary:
          `${role.name}: ` +
          (has.length > had.length
            ? `granted ${has.filter((c) => !had.includes(c)).join(', ')}`
            : has.length < had.length
              ? `revoked ${had.filter((c) => !has.includes(c)).join(', ')}`
              : 'permissions changed'),
      });
    }

    await assertSomebodyCanStillAdminister(client);
    return id;
  });
}

/* -------------------------------------------------------------- user accounts */

/** The logins, and the roles each one holds. */
export async function loadUserAccounts(orgId) {
  const { rows } = await query(
    `SELECT u.id, u.username, u.email, u.is_active, u.must_change_pw,
            to_char(u.last_login_at, 'YYYY-MM-DD HH24:MI') AS last_login,
            e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
            e.designation, e.is_active AS employee_active,
            COALESCE(
              array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}'
            ) AS roles
       FROM users u
       LEFT JOIN employees e   ON e.id = u.employee_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r       ON r.id = ur.role_id
      WHERE u.org_id = $1
      GROUP BY u.id, e.id
      ORDER BY e.code NULLS LAST, u.username`,
    [orgId]
  );

  return rows.map((r) => ({
    id: Number(r.id),
    username: r.username,
    email: r.email || '',
    active: r.is_active,
    mustChangePassword: r.must_change_pw,
    lastLogin: r.last_login || '',
    employeeId: r.employee_id ? Number(r.employee_id) : null,
    employeeCode: r.employee_code || '',
    name: r.employee_name || r.username,
    designation: r.designation || '',
    employeeActive: r.employee_active ?? true,
    roles: r.roles,
    role: r.roles[0] || '',
    status: r.is_active ? 'Active' : 'Disabled',
  }));
}

/** Resolve role codes to ids, failing on one that does not exist. */
async function roleIds(client, codes) {
  const { rows } = await client.query('SELECT id, code FROM roles WHERE code = ANY($1::text[])', [
    codes,
  ]);
  if (rows.length !== codes.length) {
    const known = new Set(rows.map((r) => r.code));
    throw notFound(`Role ${codes.find((c) => !known.has(c))}`);
  }
  return rows.map((r) => Number(r.id));
}

/**
 * Create a login for an employee.
 *
 * The password is supplied by whoever is setting the account up and the
 * account is marked as needing a change, so the person it belongs to picks
 * their own on first sign-in and the administrator never knows the one they
 * end up with.
 */
export async function createUserAccount(
  { employeeId, username, email, passwordHash, roles },
  orgId,
  actor
) {
  return withTransaction(async (client) => {
    const { rows: employee } = await client.query(
      'SELECT id, name, is_active FROM employees WHERE id = $1 AND org_id = $2',
      [employeeId, orgId]
    );
    if (!employee.length) throw notFound('Employee');
    if (!employee[0].is_active) {
      throw unprocessable(
        'EMPLOYEE_RETIRED',
        `${employee[0].name} is retired. Restore the employee before giving them a login.`
      );
    }

    const ids = await roleIds(client, roles);

    const { rows } = await client.query(
      `INSERT INTO users (org_id, employee_id, username, email, password_hash,
                          must_change_pw, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`,
      [orgId, employeeId, username, email || null, passwordHash, actor?.userId ?? null]
    );
    const userId = Number(rows[0].id);

    await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::bigint[])`,
      [userId, ids]
    );

    await writeAudit(client, {
      actor,
      entityType: 'users',
      entityId: userId,
      action: 'CREATE',
      newValue: { username, employee: employee[0].name, roles },
      summary: `Login ${username} created for ${employee[0].name} as ${roles.join(', ')}`,
    });

    return userId;
  });
}

/**
 * Change a login: the roles it holds, whether it works, the address on it.
 *
 * Deactivating is how access is taken away -- the account, its audit trail and
 * the documents it raised all stay -- so this is the write the guardrail
 * matters most for.
 */
export async function updateUserAccount(id, { roles, active, email }, orgId, actor) {
  return withTransaction(async (client) => {
    // Locked on its own: PostgreSQL will not take a row lock through a
    // GROUP BY, so the roles the account holds are read in a second statement
    // inside the same transaction rather than aggregated alongside it.
    const { rows: before } = await client.query(
      `SELECT u.*, e.name AS employee_name
         FROM users u LEFT JOIN employees e ON e.id = u.employee_id
        WHERE u.id = $1 AND u.org_id = $2
        FOR UPDATE OF u`,
      [id, orgId]
    );
    if (!before.length) throw notFound('User account');
    const user = before[0];
    const who = user.employee_name || user.username;

    const { rows: heldRows } = await client.query(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 ORDER BY r.code`,
      [id]
    );
    const heldRoles = heldRows.map((r) => r.code);

    if (active === false && Number(id) === Number(actor?.userId)) {
      throw unprocessable(
        'CANNOT_DISABLE_SELF',
        'You cannot disable your own login. Ask another administrator to do it.'
      );
    }

    if (roles) {
      const ids = await roleIds(client, roles);
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      await client.query(
        'INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::bigint[])',
        [id, ids]
      );
    }

    const changes = [];
    if (active !== undefined) changes.push(['is_active', active]);
    if (email !== undefined) changes.push(['email', email || null]);
    if (changes.length) {
      await client.query(
        `UPDATE users SET ${changes.map(([c], i) => `${c} = $${i + 1}`).join(', ')}
          WHERE id = $${changes.length + 1}`,
        [...changes.map(([, v]) => v), id]
      );
    }

    // A disabled account keeps no live session: the access token would go on
    // working until it expired otherwise, which is half an hour of an account
    // that is supposed to be shut.
    if (active === false) {
      await client.query(
        'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [id]
      );
    }

    const summary =
      active === false
        ? `Login ${user.username} disabled`
        : active === true
          ? `Login ${user.username} enabled`
          : roles
            ? `${who} is now ${roles.join(', ')}`
            : `Login ${user.username} updated`;

    await writeAudit(client, {
      actor,
      entityType: 'users',
      entityId: id,
      action: 'UPDATE',
      oldValue: { roles: heldRoles, active: user.is_active, email: user.email },
      newValue: { roles: roles || heldRoles, active: active ?? user.is_active, email },
      summary,
    });

    await assertSomebodyCanStillAdminister(client);
    return id;
  });
}

/**
 * Set a new password on someone else's account.
 *
 * The account is marked as needing a change and every session on it is
 * revoked, so a reset is a reset: whoever was signed in is signed out, and the
 * temporary password the administrator knows is replaced by one they do not on
 * the next sign-in.
 */
export async function resetUserPassword(id, passwordHash, orgId, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT u.id, u.username, e.name AS employee_name
         FROM users u LEFT JOIN employees e ON e.id = u.employee_id
        WHERE u.id = $1 AND u.org_id = $2 FOR UPDATE OF u`,
      [id, orgId]
    );
    if (!rows.length) throw notFound('User account');

    await client.query(
      'UPDATE users SET password_hash = $1, must_change_pw = true WHERE id = $2',
      [passwordHash, id]
    );
    await client.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [id]
    );

    await writeAudit(client, {
      actor,
      entityType: 'users',
      entityId: id,
      action: 'RESET_PASSWORD',
      summary: `Password reset for ${rows[0].employee_name || rows[0].username}; sessions signed out`,
    });

    return id;
  });
}
