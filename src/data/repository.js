import { InMemoryRepository } from './inMemoryRepository.js';
import { ApiRepository } from './apiRepository.js';

/**
 * The repository contract.
 *
 * Screens depend on this module, never on a concrete implementation, so the
 * same UI runs against the bundled seed data or a live PostgreSQL-backed API
 * without a single screen change.
 *
 * ## Contract
 *
 * | Method                     | Purpose                                       |
 * | -------------------------- | --------------------------------------------- |
 * | `load()`                   | the whole working set the app boots from      |
 * | `createCustomer(record)`   | add a customer, returns the stored record     |
 * | `listMaster(kind, query)`  | one page of a master list                     |
 * | `createMaster(kind, body)` | add a crop, customer, supplier or company     |
 * | `updateMaster(kind, ...)`  | edit one of them                              |
 * | `retireMaster(kind, id)`   | deactivate one; master rows are never deleted |
 * | `restoreMaster(kind, id)`  | put a retired one back                        |
 * | `expenses(query)`          | posted expense vouchers                       |
 * | `postCropPurchase(args)`   | post a bulk crop purchase                     |
 * | `postCropSale(args)`       | post a bulk crop sale (FIFO allocation)       |
 * | `postDealerPurchase(args)` | post a dealer purchase                        |
 * | `postDealerSale(args)`     | post a dealer sales invoice                   |
 * | `decideApproval(...)`      | approve or reject a pending request           |
 * | `settings()`               | the Settings screen's working set             |
 * | `updateOrganization(...)`  | the company profile, or the valuation method  |
 * | `createFiscalYear(year)`   | open the next financial year                  |
 * | `updateFiscalYear(...)`    | close, reopen or adopt one                    |
 * | `updateNumbering(...)`     | the prefix and width of a document type       |
 * | `updateApprovalRule(...)`  | move an approval limit, or switch a rule off  |
 * | `updateNotificationRule()` | move or switch off an alert                   |
 * | `audit(filters)`           | the recorded history of every change          |
 * | `roles()`                  | the roles, their grants and the permissions   |
 * | `createRole(role)`         | add a role, optionally with grants            |
 * | `updateRole(id, changes)`  | rename one, or say what it is for             |
 * | `deleteRole(id)`           | remove one nobody holds                       |
 * | `setRolePermissions(...)`  | grant and revoke inside one module            |
 * | `userAccounts()`           | the logins, and the roles each one holds      |
 * | `createUserAccount(...)`   | give an employee a login                      |
 * | `updateUserAccount(...)`   | change its roles, or switch it off            |
 * | `resetUserPassword(...)`   | set a temporary password, ending its sessions |
 *
 * Both implementations resolve to the same shapes. The write methods accept an
 * `intent` — what the user did — rather than a finished row, so the server can
 * own document numbering, costing and the ledger while the in-memory version
 * simply computes the same thing locally.
 */

export { InMemoryRepository } from './inMemoryRepository.js';
export { ApiRepository } from './apiRepository.js';
export { ApiClient, ApiError } from './apiClient.js';

/**
 * Kept as the historical name so existing callers and tests that do
 * `new Repository({ latency: 0 })` continue to work unchanged.
 */
export { InMemoryRepository as Repository } from './inMemoryRepository.js';

/**
 * Choose an implementation.
 *
 * An API base URL — from `VITE_API_URL` at build time, or passed explicitly —
 * selects the live backend. With none configured the app runs on seed data,
 * which is what the test suite and a no-backend demo use.
 *
 * @param {object} [options]
 * @param {string} [options.apiUrl] overrides the build-time value
 * @param {number} [options.latency] in-memory only; 0 in tests
 */
export function createRepository(options = {}) {
  const apiUrl =
    options.apiUrl ?? (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_API_URL : null);

  if (apiUrl) return new ApiRepository({ baseUrl: apiUrl });
  return new InMemoryRepository({ latency: options.latency });
}

/** The app-wide instance. */
export const repository = createRepository();

/** True when the app is talking to a real backend, so the UI can ask for a sign-in. */
export const requiresAuthentication = repository instanceof ApiRepository;
