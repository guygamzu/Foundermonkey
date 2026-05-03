import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './config/logger.js';
import { runMigrations } from './config/database.js';
import { createDocumentsRouter } from './routes/documents.js';
import { errorHandler } from './middleware/errorHandler.js';
import { rateLimiter } from './middleware/rateLimiter.js';

async function main() {
  const app = express();
  const port = Number(process.env.PORT) || 3001;

  // Root route
  app.get('/', (_req, res) => {
    res.json({ name: 'Lapen API', version: '1.0.2', status: 'running', dbConfigured: !!process.env.DATABASE_URL });
  });

  // Health check — register first so it responds even during startup
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Start server immediately so healthcheck passes
  app.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Lapen API server started');
  });

  // Run database migrations
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations();
      logger.info('Database migrations completed');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg }, 'Failed to run migrations');
    }
  } else {
    logger.warn('DATABASE_URL not configured, skipping migrations');
  }

  // Middleware
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }));
  const allowedOrigins = [
    process.env.APP_URL,
    'http://localhost:3000',
    'https://web-frontend-production-6687.up.railway.app',
    'https://app.lapen.ai',
    'https://lapen.ai',
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

  // Routes — each wrapped in try/catch so one failure doesn't block others
  if (process.env.DATABASE_URL) {
    try {
      app.use('/api/documents', createDocumentsRouter());
      logger.info('Documents routes registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register documents routes');
    }

    try {
      const { createSigningRouter } = await import('./routes/signing.js');
      app.use('/api/signing', createSigningRouter());
      logger.info('Signing routes registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register signing routes');
    }

    try {
      const { createSetupRouter } = await import('./routes/setup.js');
      app.use('/api/setup', createSetupRouter());
      logger.info('Setup routes registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register setup routes');
    }

    try {
      const { createPaymentsRouter } = await import('./routes/payments.js');
      app.use('/api/payments', createPaymentsRouter());
      logger.info('Payments routes registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register payments routes');
    }

    try {
      const { createAdminRouter } = await import('./routes/admin.js');
      app.use('/api/admin', createAdminRouter());
      logger.info('Admin routes registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register admin routes');
    }
  }

  // Contact form (no DB required)
  app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    try {
      const { EmailService } = await import('./services/EmailService.js');
      const emailService = new EmailService();
      await emailService.sendEmail({
        to: 'sign@lapen.ai',
        subject: `Contact form: ${name}`,
        text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
        html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p>${message.replace(/\n/g, '<br>')}</p>`,
      });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Contact form failed');
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // Error handling
  app.use(errorHandler);

  // Start workers (requires Redis)
  if (process.env.REDIS_URL) {
    try {
      const { startNotificationWorker } = await import('./workers/NotificationWorker.js');
      const { startCompletionWorker } = await import('./workers/CompletionWorker.js');
      startNotificationWorker();
      startCompletionWorker();
      logger.info('Background workers started');
    } catch (err) {
      logger.error({ err }, 'Failed to start background workers');
    }
  } else {
    logger.warn('REDIS_URL not configured, background workers not started');
  }

  // Start email processor
  if (process.env.IMAP_HOST && process.env.IMAP_USER) {
    try {
      const { EmailProcessor } = await import('./workers/EmailProcessor.js');
      const emailProcessor = new EmailProcessor();
      emailProcessor.start();
      logger.info('Email processor started');
    } catch (err) {
      logger.error({ err }, 'Failed to start email processor');
    }
  } else {
    logger.warn('IMAP not configured, email processor not started');
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting server');
});
