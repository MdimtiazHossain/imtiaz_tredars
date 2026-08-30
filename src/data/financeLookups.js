/**
 * Selectable finance masters: where money sits, how it moves, and what an
 * expense is booked against.
 *
 * Distinct from the similarly named lists in `reference.js`, which are the
 * read-only display rows the Settings screen renders. These carry ids and are
 * what the payment and expense forms select from, mirroring the shape the API
 * returns so the two implementations agree.
 */

export const ACCOUNTS = [
  { id: 1, code: 'CASH-BOG', name: 'Office cash — Bogura', type: 'CASH' },
  { id: 2, code: 'BANK-IBBL', name: 'Islami Bank — 20501...4417', type: 'BANK' },
  { id: 3, code: 'BANK-DBBL', name: 'DBBL — 1471...8802', type: 'BANK' },
  { id: 4, code: 'MFS-BKASH', name: 'bKash Merchant — 01755...', type: 'MFS' },
];

/** Rocket is configured but not in use, as the Settings screen shows. */
export const PAYMENT_METHOD_OPTIONS = [
  { id: 1, code: 'CASH', name: 'Cash', accountId: 1, active: true },
  { id: 2, code: 'BANK', name: 'Bank transfer', accountId: 2, active: true },
  { id: 3, code: 'CHEQUE', name: 'Cheque', accountId: 3, active: true },
  { id: 4, code: 'BKASH', name: 'bKash', accountId: 4, active: true },
  { id: 5, code: 'NAGAD', name: 'Nagad', accountId: 4, active: true },
  // Retired, as it is in the seeded database. It stays listed on the settings
  // screen so it can be brought back, and is not offered on a new payment.
  { id: 6, code: 'ROCKET', name: 'Rocket', accountId: null, active: false },
];

export const EXPENSE_CATEGORIES = [
  { id: 1, code: 'TRANSPORT', name: 'Transport' },
  { id: 2, code: 'LABOUR', name: 'Loading / Unloading' },
  { id: 3, code: 'SALARY', name: 'Salary' },
  { id: 4, code: 'WAREHOUSE', name: 'Warehouse' },
  { id: 5, code: 'FUEL', name: 'Fuel' },
  { id: 6, code: 'COMMISSION', name: 'Commission' },
  { id: 7, code: 'OFFICE', name: 'Office & utility' },
];
