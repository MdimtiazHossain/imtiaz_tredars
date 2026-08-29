import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../lib/config.js';
import { query, withTransaction, num } from '../lib/db.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Authentication.
 *
 * Passwords are bcrypt hashes; refresh tokens are stored only as SHA-256
 * digests, so a database leak cannot be replayed against the API. Access
 * tokens are short-lived JWTs and carry no permissions -- those are loaded
 * from the database on every request, so a role change takes effect
 * immediately rather than when the token expires.
 */

export const hashPassword = (plain) => bcrypt.hash(plain, config.bcryptRounds);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

function signAccessToken(user) {
  return jwt.sign({ sub: String(user.id), org: user.orgId }, config.jwtSecret, {
    expiresIn: config.accessTokenTtl,
    issuer: 'business-suite',
  });
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { issuer: 'business-suite' });
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}

/** Load a user with the permission codes their roles grant. */
export async function loadUser(userId) {
  const { rows } = await query(
    `SELECT u.id, u.org_id, u.username, u.email, u.is_active,
            e.name AS employee_name, e.designation,
            COALESCE(
              array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}'
            ) AS roles,
            COALESCE(
              array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}'
            ) AS permissions
       FROM users u
       LEFT JOIN employees e        ON e.id = u.employee_id
       LEFT JOIN user_roles ur      ON ur.user_id = u.id
       LEFT JOIN roles r            ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p      ON p.id = rp.permission_id
      WHERE u.id = $1
      GROUP BY u.id, e.name, e.designation`,
    [userId]
  );

  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    orgId: Number(r.org_id),
    username: r.username,
    email: r.email,
    isActive: r.is_active,
    name: r.employee_name || r.username,
    designation: r.designation,
    roles: r.roles,
    permissions: r.permissions,
    // The design's screens key off a single role label; the primary role is the
    // first one, matching how the UI has always presented it.
    role: r.roles[0] || 'Admin',
  };
}

/**
 * Sign in. Deliberately returns the same message for an unknown user and a
 * wrong password, so the endpoint cannot be used to enumerate accounts.
 */
export async function login({ username, password, ip, userAgent }) {
  const { rows } = await query(
    'SELECT id, org_id, password_hash, is_active FROM users WHERE lower(username) = lower($1)',
    [username]
  );

  const generic = unauthorized('Username or password is incorrect.');
  if (!rows.length) {
    // Spend comparable time so timing does not reveal whether the user exists.
    await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    throw generic;
  }

  const record = rows[0];
  const okPassword = await verifyPassword(password, record.password_hash);
  if (!okPassword) throw generic;
  if (!record.is_active) {
    throw unauthorized('This account has been deactivated. Contact your administrator.');
  }

  const user = await loadUser(Number(record.id));
  const accessToken = signAccessToken(user);
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO user_sessions (user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, digest(refreshToken), expiresAt, ip ?? null, userAgent ?? null]
    );
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await writeAudit(client, {
      actor: { userId: user.id, orgId: user.orgId, ip, userAgent },
      entityType: 'users',
      entityId: user.id,
      action: 'LOGIN',
      summary: `${user.name} signed in`,
    });
  });

  return { user, accessToken, refreshToken, expiresAt };
}

/** Exchange a refresh token for a new access token. */
export async function refresh({ refreshToken }) {
  if (!refreshToken) throw unauthorized('Please sign in to continue.');

  const { rows } = await query(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at
       FROM user_sessions s
      WHERE s.token_hash = $1`,
    [digest(refreshToken)]
  );

  if (!rows.length || rows[0].revoked_at || new Date(rows[0].expires_at) < new Date()) {
    throw unauthorized('Your session has expired. Please sign in again.');
  }

  const user = await loadUser(Number(rows[0].user_id));
  if (!user || !user.isActive) throw unauthorized('This account is no longer active.');

  return { user, accessToken: signAccessToken(user) };
}

export async function logout({ refreshToken, actor }) {
  if (!refreshToken) return;
  await withTransaction(async (client) => {
    await client.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [digest(refreshToken)]
    );
    if (actor?.userId) {
      await writeAudit(client, {
        actor,
        entityType: 'users',
        entityId: actor.userId,
        action: 'LOGOUT',
        summary: 'Signed out',
      });
    }
  });
}

/** Change a password, verifying the current one first. */
export async function changePassword({ userId, currentPassword, newPassword, actor }) {
  if (!newPassword || newPassword.length < 10) {
    throw badRequest('WEAK_PASSWORD', 'Choose a password of at least 10 characters.');
  }

  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows.length) throw unauthorized();

  const ok = await verifyPassword(currentPassword, rows[0].password_hash);
  if (!ok) throw badRequest('WRONG_PASSWORD', 'Your current password is not correct.');

  const hash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await client.query(
      'UPDATE users SET password_hash = $1, must_change_pw = false WHERE id = $2',
      [hash, userId]
    );
    // Force other devices to sign in again.
    await client.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    await writeAudit(client, {
      actor,
      entityType: 'users',
      entityId: userId,
      action: 'CHANGE_PASSWORD',
      summary: 'Password changed; other sessions signed out',
    });
  });
}

/** Remove expired sessions; safe to run from a scheduled job. */
export async function purgeExpiredSessions() {
  const { rowCount } = await query(
    "DELETE FROM user_sessions WHERE expires_at < now() - interval '30 days'"
  );
  return num(rowCount);
}
