import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Request/response conventions shared by every route: one success envelope,
 * one error envelope, and one way to read pagination, sorting and filters.
 */

/** Wrap an async handler so a rejection reaches the error middleware. */
export const handler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function ok(res, data, meta) {
  return res.json(meta ? { data, meta } : { data });
}

export function created(res, data) {
  return res.status(201).json({ data });
}

/** Validate a request part against a zod schema, or throw a 400 with details. */
export function parse(schema, value, what = 'request') {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const details = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!details[key]) details[key] = issue.message;
  }
  const first = result.error.issues[0];
  const field = first.path.join('.');
  throw badRequest(
    'VALIDATION_FAILED',
    field ? `${field}: ${first.message}` : `The ${what} was not valid.`,
    details
  );
}

export const parseBody = (schema, req) => parse(schema, req.body, 'request body');
export const parseQuery = (schema, req) => parse(schema, req.query, 'query string');
export const parseParams = (schema, req) => parse(schema, req.params, 'URL');

/** Common query-string shape: pagination, sorting, search and date range. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().max(64).optional(),
  dir: z.enum(['asc', 'desc']).default('asc'),
  q: z.string().max(120).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  businessType: z.enum(['DEALER', 'BULK_CROP', 'ALL']).default('ALL'),
});

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Build a safe ORDER BY. Column names never come from the client directly --
 * only a key into an allow-list -- so sorting cannot be used for injection.
 */
export function orderBy(sort, dir, allowed, fallback) {
  const column = allowed[sort] || fallback;
  return `${column} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
}

/** LIMIT/OFFSET pair plus the meta block the client uses for its pager. */
export function paginate(page, pageSize) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export function pageMeta(page, pageSize, total) {
  const totalCount = Number(total) || 0;
  return {
    page,
    pageSize,
    total: totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    hasNext: page * pageSize < totalCount,
    hasPrev: page > 1,
  };
}
