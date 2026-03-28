import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Email
  IMAP_HOST: z.string(),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_USER: z.string(),
  IMAP_PASSWORD: z.string(),
  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string(),
  SMTP_PASSWORD: z.string(),

  // AI
  ANTHROPIC_API_KEY: z.string(),

  // AWS
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET: z.string().default('lapen-documents'),

  // Stripe
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),

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

  // Security
  SIGNING_URL_SECRET: z.string(),
  JWT_SECRET: z.string(),
  ENCRYPTION_KEY: z.string(),
});

export type Env = z.infer<typeof envSchema>;

let env: Env;

export function getEnv(): Env {
  if (!env) {
    env = envSchema.parse(process.env);
  }
  return env;
}
