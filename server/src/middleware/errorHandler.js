import { AppError, translateDbError } from '../lib/errors.js';
import { config } from '../lib/config.js';

/**
 * Terminal error handling.
 *
 * One response shape for every failure:
 *
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 *
 * Raw driver text never reaches the client. Anything unrecognised is logged in
 * full server-side and answered with a generic sentence, so an internal detail
 * cannot leak through an error message.
 */

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'ENDPOINT_NOT_FOUND',
      message: `No such endpoint: ${req.method} ${req.path}`,
    },
  });
}

// Express identifies an error handler by its arity, so the fourth parameter
// must stay even though it is unused.
export function errorHandler(err, req, res, _next) {
  const translated = err instanceof AppError ? err : translateDbError(err);

  if (translated instanceof AppError) {
    if (translated.status >= 500) {
      console.error('[api] %s %s -> %s', req.method, req.originalUrl, translated.message);
    }
    return res.status(translated.status).json({
      error: {
        code: translated.code,
        message: translated.message,
        ...(translated.details ? { details: translated.details } : {}),
      },
    });
  }

  // Body-parser rejects malformed JSON before any route sees it.
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'The request body was not valid JSON.' },
    });
  }

  console.error('[api] unhandled error on %s %s', req.method, req.originalUrl);
  console.error(err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Please try again.',
      ...(config.isProduction ? {} : { debug: String(err?.message || err) }),
    },
  });
}
