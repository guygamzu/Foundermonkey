import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './config/logger.js';
import { runMigrations } from './config/database.js';
import { createSigningRouter } from './routes/signing.js';
import { createPaymentsRouter } from './routes/payments.js';
import { createDocumentsRouter } from './routes/documents.js';
import { errorHandler } from './middleware/errorHandler.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { EmailProcessor } from './workers/EmailProcessor.js';
import { startNotificationWorker } from './workers/NotificationWorker.js';
import { startCompletionWorker } from './workers/CompletionWorker.js';

async function main() {
  const app = express();
  const port = Number(process.env.PORT) || 3001;

  // Run database migrations
  try {
    await runMigrations();
    logger.info('Database migrations completed');
  } catch (err) {
    logger.error({ err }, 'Failed to run migrations');
    // Continue - migrations may have already been applied
  }

  // Middleware
  app.use(helmet());
  const allowedOrigins = [
    process.env.APP_URL,
    'http://localhost:3000',
  ].filter(Boolean) as string[];
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
  }));
  app.use(pinoHttp({ logger }));

  // Raw body for Stripe webhooks
  app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

  // JSON parsing for all other routes
  app.use(express.json({ limit: '1mb' }));

  // Rate limiting
  app.use('/api/', rateLimiter(100, 60 * 1000)); // 100 req/min
  app.use('/api/signing/session/*/qa', rateLimiter(20, 60 * 1000)); // 20 Q&A/min

  // Routes
  app.use('/api/signing', createSigningRouter());
  app.use('/api/payments', createPaymentsRouter());
  app.use('/api/documents', createDocumentsRouter());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handling
  app.use(errorHandler);

  // Start server
  app.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Lapen API server started');
  });

  // Start workers (requires Redis)
  if (process.env.REDIS_URL) {
    startNotificationWorker();
    startCompletionWorker();
    logger.info('Background workers started');
  } else {
    logger.warn('REDIS_URL not configured, background workers not started');
  }

  // Start email processor
  if (process.env.IMAP_HOST && process.env.IMAP_USER) {
    const emailProcessor = new EmailProcessor();
    emailProcessor.start();
    logger.info('Email processor started');
  } else {
    logger.warn('IMAP not configured, email processor not started');
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting server');
  process.exit(1);
});
