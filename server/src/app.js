import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './lib/config.js';
import { requestContext } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthcheck } from './lib/db.js';
import routes from './routes/index.js';

/**
 * Express application.
 *
 * Assembled separately from the listener so tests can mount it with supertest
 * without binding a port.
 */
export function createApp() {
  const app = express();

  // Behind a reverse proxy, trust it so `req.ip` is the real client address --
  // the audit trail records it.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and tooling requests arrive without an Origin header.
        if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
        callback(new Error('Origin not allowed by CORS policy'));
      },
      credentials: true,
      // Without this the browser hides content-disposition from JavaScript, so
      // a download would be saved under a fallback name with no extension.
      exposedHeaders: ['content-disposition'],
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext);

  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
      },
    })
  );

  app.get('/health', async (_req, res) => {
    try {
      await healthcheck();
      res.json({ data: { status: 'ok', env: config.env } });
    } catch {
      res.status(503).json({
        error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable.' },
      });
    }
  });

  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
