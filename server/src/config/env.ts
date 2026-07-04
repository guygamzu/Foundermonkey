import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Email (optional - server starts without email processing if not set)
  IMAP_HOST: z.string().optional(),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASSWORD: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // AI
  ANTHROPIC_API_KEY: z.string().optional(),

  // AWS
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('lapen-documents'),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // WhatsApp
  WHATSAPP_API_URL: z.string().optional(),
  WHATSAPP_API_TOKEN: z.string().optional(),
  WHATSAPP_BUSINESS_NUMBER: z.string().optional(),

  // App
  APP_URL: z.string().default('https://lapen.com'),
  API_URL: z.string().default('https://api.lapen.com'),

  // Security (optional for initial deploy, required in production)
  SIGNING_URL_SECRET: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),

  // Risk Monitor
  RISK_MONITOR_ENABLED: z.coerce.boolean().default(false),
  RISK_MONITOR_RECIPIENTS: z.string().optional(),
  RISK_MONITOR_POLL_INTERVAL_MS: z.coerce.number().default(180000),
  ACLED_API_KEY: z.string().optional(),
  ACLED_API_EMAIL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let env: Env;

export function getEnv(): Env {
  if (!env) {
    env = envSchema.parse(process.env);
  }
  return env;
}
