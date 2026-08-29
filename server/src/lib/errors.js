/**
 * Error handling.
 *
 * Every failure the API returns is an `AppError` with a stable machine code and
 * a sentence a user can act on. Raw PostgreSQL messages never reach the client:
 * `translateDbError` maps constraint violations onto the same shape, so
 * "duplicate key value violates unique constraint dealer_sales_org_id_txn_no_key"
 * becomes "Invoice number already exists. Please use a different invoice number."
 */

export class AppError extends Error {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    stable machine-readable code
   * @param {string} message sentence shown to the user
   * @param {object} [details] field-level detail, safe to display
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Please sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do this.') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Record') =>
  new AppError(404, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (code, message, details) => new AppError(409, code, message, details);
export const unprocessable = (code, message, details) =>
  new AppError(422, code, message, details);

/** Named constraints mapped to the sentence a user should see. */
const CONSTRAINT_MESSAGES = {
  dealer_sales_org_id_txn_no_key: [
    'DUPLICATE_INVOICE_NO',
    'Invoice number already exists. Please use a different invoice number.',
  ],
  dealer_purchases_org_id_txn_no_key: [
    'DUPLICATE_PURCHASE_NO',
    'Purchase number already exists. Please use a different purchase number.',
  ],
  dealer_purchases_company_invoice: [
    'DUPLICATE_SUPPLIER_INVOICE',
    'This company invoice number has already been recorded.',
  ],
  crop_sales_org_id_txn_no_key: [
    'DUPLICATE_SALE_NO',
    'Sales number already exists. Please use a different sales number.',
  ],
  crop_purchases_org_id_txn_no_key: [
    'DUPLICATE_PURCHASE_NO',
    'Purchase number already exists. Please use a different purchase number.',
  ],
  crop_batches_org_id_batch_no_key: [
    'DUPLICATE_BATCH_NO',
    'Batch number already exists.',
  ],
  payments_org_id_txn_no_key: [
    'DUPLICATE_PAYMENT_NO',
    'Payment voucher number already exists.',
  ],
  customers_org_mobile_active: [
    'DUPLICATE_CUSTOMER_MOBILE',
    'A customer with this mobile number already exists.',
  ],
  customers_org_id_code_key: ['DUPLICATE_CUSTOMER_CODE', 'This customer code is already in use.'],
  suppliers_org_mobile_active: [
    'DUPLICATE_SUPPLIER_MOBILE',
    'A supplier with this mobile number already exists.',
  ],
  approvals_one_pending_per_entity: [
    'APPROVAL_ALREADY_PENDING',
    'This document is already waiting for approval.',
  ],
  users_username_key: ['DUPLICATE_USERNAME', 'That username is already taken.'],
  crop_batches_quantity_remaining_check: [
    'INSUFFICIENT_STOCK',
    'Not enough stock remains in the selected batch. Refresh and try again.',
  ],
  stock_quantity_check: [
    'INSUFFICIENT_STOCK',
    'This would take stock below zero. Check the available quantity and try again.',
  ],
};

/** Messages raised by our own PL/pgSQL guards. */
const RAISED_MESSAGES = {
  POSTED_TRANSACTION_IMMUTABLE: [
    409,
    'POSTED_TRANSACTION_IMMUTABLE',
    'A posted transaction cannot be edited. Cancel it and create a new one instead.',
  ],
  POSTED_TRANSACTION_CANNOT_BE_DELETED: [
    409,
    'POSTED_TRANSACTION_CANNOT_BE_DELETED',
    'A posted transaction cannot be deleted. Cancel it instead so the history is kept.',
  ],
  CANCEL_REQUIRES_REASON: [
    400,
    'CANCEL_REQUIRES_REASON',
    'Please give a reason for cancelling this transaction.',
  ],
  STOCK_LEDGER_IS_APPEND_ONLY: [
    409,
    'STOCK_LEDGER_IS_APPEND_ONLY',
    'Stock history cannot be changed. Post an adjustment instead.',
  ],
};

/**
 * Convert a driver error into an AppError. Anything unrecognised is returned
 * unchanged so the error handler can log it and answer with a generic 500.
 */
export function translateDbError(err) {
  if (!err || typeof err !== 'object') return err;

  const raised = RAISED_MESSAGES[err.message];
  if (raised) return new AppError(raised[0], raised[1], raised[2]);

  switch (err.code) {
    case '23505': {
      const mapped = CONSTRAINT_MESSAGES[err.constraint];
      return mapped
        ? conflict(mapped[0], mapped[1])
        : conflict('DUPLICATE_RECORD', 'This record already exists.');
    }
    case '23503':
      return badRequest(
        'INVALID_REFERENCE',
        'A selected record no longer exists. Refresh the page and try again.'
      );
    case '23514': {
      const mapped = CONSTRAINT_MESSAGES[err.constraint];
      return mapped
        ? unprocessable(mapped[0], mapped[1])
        : unprocessable('INVALID_VALUE', 'One of the values entered is not allowed.');
    }
    case '23502':
      return badRequest('MISSING_VALUE', 'A required field was left empty.');
    case '40001':
      return conflict(
        'CONCURRENT_UPDATE',
        'Someone else changed this record at the same time. Please try again.'
      );
    case '55P03':
    case '40P01':
      return conflict(
        'RECORD_BUSY',
        'This record is being updated by someone else. Please try again in a moment.'
      );
    default:
      return err;
  }
}
