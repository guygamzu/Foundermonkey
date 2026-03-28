# Lapen

AI-native, messaging-first electronic signature platform.

## Overview

Lapen eliminates friction in e-signature workflows by using a conversational AI agent. Users send documents via email to `agent@lapen.com` and the AI handles field detection, signer coordination, and document delivery—no dashboard or account setup required.

## Architecture

```
├── shared/          # Shared TypeScript types
├── server/          # Express.js API server
│   ├── src/
│   │   ├── config/      # Database, queue, env, logger
│   │   ├── models/      # Database repositories
│   │   ├── routes/      # API routes (signing, payments, documents)
│   │   ├── services/    # Business logic (AI, email, storage, payments)
│   │   ├── workers/     # Background job processors
│   │   └── middleware/  # Error handling, rate limiting
│   └── migrations/      # PostgreSQL migrations
├── web/             # Next.js frontend
│   └── src/
│       ├── app/         # Pages (signing, credits, landing)
│       ├── components/  # React components (SignatureCanvas, ChatWidget)
│       ├── lib/         # API client
│       └── styles/      # Global CSS
```

## Tech Stack

- **Backend**: Node.js, TypeScript, Express
- **Frontend**: Next.js 15, React 19
- **Database**: PostgreSQL (via Knex.js)
- **Queue**: Redis + Bull
- **AI**: Anthropic Claude API (document analysis, NLP, Q&A)
- **Storage**: AWS S3
- **Payments**: Stripe
- **Messaging**: SMTP/IMAP (email), Twilio (SMS), WhatsApp Business API
- **PDF**: pdf-lib

## Key Features

1. **Zero-setup sending** — Email a PDF to agent@lapen.com with instructions
2. **AI field detection** — Automatic signature/initial/date field identification
3. **Multi-channel delivery** — Email, SMS, WhatsApp
4. **Sequential signing** — Enforce signing order via natural language
5. **Mobile-first signing** — Responsive UI optimized for touch
6. **Document Q&A** — AI-powered chat for recipients to ask about document terms
7. **Audit trail** — Immutable logs with Certificate of Completion
8. **Credit-based billing** — 5 free credits, Stripe checkout for more

## Getting Started

### Prerequisites

- Node.js 22+
- PostgreSQL 16+
- Redis 7+

### Development

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Run database migrations
npm run migrate --workspace=server

# Start development servers
npm run dev
```

### Docker

```bash
docker compose up
```

The API server runs on port 3001, the web app on port 3000.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/signing/session/:token` | Get signing session data |
| POST | `/api/signing/session/:token/fields/:fieldId` | Submit field value |
| POST | `/api/signing/session/:token/complete` | Complete signing with consent |
| POST | `/api/signing/session/:token/decline` | Decline to sign |
| POST | `/api/signing/session/:token/qa` | Ask AI about document |
| GET | `/api/documents/status/:id` | Get document status |
| GET | `/api/documents/preview/:id` | Get document preview |
| GET | `/api/documents/archive/:id` | Get completed document archive |
| POST | `/api/payments/checkout` | Create Stripe checkout session |
| POST | `/api/payments/webhook` | Stripe webhook handler |
| GET | `/api/payments/credits/:userId` | Get credit balance |
| GET | `/health` | Health check |
