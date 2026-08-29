import { verifyAccessToken, loadUser } from '../services/authService.js';
import { unauthorized, forbidden } from '../lib/errors.js';

/**
 * Authentication and authorisation middleware.
 *
 * Permissions are read from the database on every request rather than trusted
 * from the token, so revoking a role takes effect immediately. This is the only
 * place authorisation is decided: the frontend hides what a user cannot do, but
 * hiding is a convenience, not the control.
 */

/** Attach request metadata used by the audit trail. */
export function requestContext(req, _res, next) {
  req.actor = {
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
  };
  next();
}

/** Require a valid access token and load the user behind it. */
export async function authenticate(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw unauthorized('Please sign in to continue.');

    const claims = verifyAccessToken(token);
    const user = await loadUser(Number(claims.sub));

    if (!user) throw unauthorized('Your account no longer exists.');
    if (!user.isActive) {
      throw unauthorized('This account has been deactivated. Contact your administrator.');
    }

    req.user = user;
    req.orgId = user.orgId;
    req.actor = { ...req.actor, userId: user.id, orgId: user.orgId };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require every listed permission.
 *
 * @param {...string} codes permission codes, e.g. 'dealer.sale.post'
 */
export function requirePermission(...codes) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());

    const missing = codes.filter((code) => !req.user.permissions.includes(code));
    if (missing.length) {
      return next(
        forbidden(
          `Your role (${req.user.role}) does not allow this action. ` +
            `It requires: ${missing.join(', ')}.`
        )
      );
    }
    next();
  };
}

/** Require at least one of the listed permissions. */
export function requireAnyPermission(...codes) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    const allowed = codes.some((code) => req.user.permissions.includes(code));
    if (!allowed) {
      return next(
        forbidden(`Your role (${req.user.role}) does not allow this action.`)
      );
    }
    next();
  };
}

/**
 * Profit figures are hidden from Sales, Purchase and Warehouse roles.
 * Applied by report and dashboard routes so the numbers are stripped
 * server-side rather than merely hidden in the UI.
 */
export const canSeeProfit = (user) => user?.permissions?.includes('report.profit') ?? false;
