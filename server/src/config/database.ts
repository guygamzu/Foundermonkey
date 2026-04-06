import knex, { Knex } from 'knex';

let db: Knex;

export function getDatabase(): Knex {
  if (!db) {
    const isProduction = process.env.NODE_ENV === 'production';
    db = knex({
      client: 'pg',
      connection: {
        connectionString: process.env.DATABASE_URL,
        ssl: isProduction ? { rejectUnauthorized: false } : false,
      },
      pool: { min: 2, max: 20 },
    });
  }
  return db;
}

export async function runMigrations(): Promise<void> {
  const database = getDatabase();

  // Create tables directly instead of using migration files
  const hasUsersTable = await database.schema.hasTable('users');
  if (hasUsersTable) {
    // Tables exist — run incremental schema updates for new columns
    await runIncrementalMigrations(database);
    return;
  }

  await database.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await database.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
    table.string('email').notNullable().unique();
    table.string('name');
    table.integer('credits').notNullable().defaultTo(10);
    table.boolean('is_provisional').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(database.fn.now());
    table.index('email');
  });

  await database.schema.createTable('document_requests', (table) => {
    table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
    table.uuid('sender_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('status').notNullable().defaultTo('draft');
    table.string('file_name').notNullable();
    table.integer('file_size').notNullable();
    table.integer('page_count').notNullable().defaultTo(1);
    table.string('mime_type').notNullable().defaultTo('application/pdf');
    table.string('document_hash').notNullable();
    table.string('s3_key').notNullable();
    table.string('signed_s3_key');
    table.string('certificate_s3_key');
    table.boolean('is_sequential').notNullable().defaultTo(false);
    table.integer('credits_required').notNullable().defaultTo(1);
    table.string('original_email_message_id');
    table.string('subject');
    table.timestamp('expires_at').notNullable();
    table.timestamp('completed_at');
    table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(database.fn.now());
    table.index('sender_id');
    table.index('status');
  });

  await database.schema.createTable('signers', (table) => {
    table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
    table.uuid('document_request_id').notNullable().references('id').inTable('document_requests').onDelete('CASCADE');
    table.string('email');
    table.string('phone');
    table.string('name');
    table.string('status').notNullable().defaultTo('pending');
    table.string('delivery_channel').notNullable().defaultTo('email');
    table.integer('signing_order').notNullable().defaultTo(1);
    table.string('signing_token').notNullable().unique();
    table.text('custom_message');
    table.timestamp('notified_at');
    table.timestamp('viewed_at');
    table.timestamp('signed_at');
    table.timestamp('declined_at');
    table.text('decline_reason');
    table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
    table.index('document_request_id');
    table.index('signing_token');
    table.index(['document_request_id', 'signing_order']);
  });

  await database.schema.createTable('document_fields', (table) => {
    table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
    table.uuid('document_request_id').notNullable().references('id').inTable('document_requests').onDelete('CASCADE');
    table.uuid('signer_id').notNullable().references('id').inTable('signers').onDelete('CASCADE');
    table.string('type').notNullable();
    table.integer('page').notNullable();
    table.float('x').notNullable();
    table.float('y').notNullable();
    table.float('width').notNullable();
    table.float('height').notNullable();
    table.boolean('required').notNullable().defaultTo(true);
    table.text('value');
    table.timestamp('completed_at');
    table.index('document_request_id');
    table.index('signer_id');
  });

  await database.schema.createTable('audit_events', (table) => {
    table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
    table.uuid('document_request_id').notNullable().references('id').inTable('document_requests').onDelete('CASCADE');
    table.uuid('signer_id').references('id').inTable('signers').onDelete('SET NULL');
    table.string('action').notNullable();
    table.string('ip_address').notNullable();
    table.string('user_agent').notNullable();
    table.string('geolocation');
    table.jsonb('metadata');
    table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
    table.index('document_request_id');
    table.index(['document_request_id', 'action']);
  });

  await database.schema.createTable('credit_transactions', (table) => {
    table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('amount').notNullable();
    table.integer('balance_after').notNullable();
    table.string('reason').notNullable();
    table.uuid('document_request_id').references('id').inTable('document_requests').onDelete('SET NULL');
    table.string('stripe_payment_intent_id');
    table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
    table.index('user_id');
    table.index('stripe_payment_intent_id');
  });

  await database.schema.createTable('pending_requests', (table) => {
    table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('document_request_id').notNullable().references('id').inTable('document_requests').onDelete('CASCADE');
    table.string('original_email_message_id');
    table.boolean('resolved').notNullable().defaultTo(false);
    table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
    table.index(['user_id', 'resolved']);
  });

  // Run incremental migrations for new features
  await runIncrementalMigrations(database);
}

/**
 * Add columns/tables that were introduced after the initial schema.
 * Each migration checks if the column/table already exists before adding.
 * Each step is wrapped in try/catch so one failure doesn't block the rest.
 */
async function runIncrementalMigrations(database: Knex): Promise<void> {
  // --- Referrals (20260401000001) ---
  try {
    const hasReferralCode = await database.raw(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'referral_code'
    `);
    if (hasReferralCode.rows.length === 0) {
      await database.schema.alterTable('users', (table) => {
        table.string('referral_code').unique();
      });
    }
  } catch (err) {
    // Column may already exist
  }

  try {
    const hasReferralsTable = await database.schema.hasTable('referrals');
    if (!hasReferralsTable) {
      await database.schema.createTable('referrals', (table) => {
        table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
        table.uuid('referrer_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.uuid('referred_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        table.integer('credits_awarded').notNullable().defaultTo(5);
        table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
      });
      // Add unique constraint separately to avoid issues
      try {
        await database.raw('ALTER TABLE referrals ADD CONSTRAINT referrals_unique_pair UNIQUE (referrer_id, referred_id)');
      } catch (_) { /* constraint may already exist */ }
    }
  } catch (err) {
    // Table may already exist
  }

  // --- AI summary & cover text on documents (20260402000001) ---
  try {
    const hasAiSummary = await database.raw(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'document_requests' AND column_name = 'ai_summary'
    `);
    if (hasAiSummary.rows.length === 0) {
      await database.schema.alterTable('document_requests', (table) => {
        table.text('ai_summary');
        table.text('suggested_cover_text');
      });
    }
  } catch (err) {
    // Columns may already exist
  }

  // --- Unique indexes on signers (20260402000002) ---
  try {
    const hasSignerEmailIdx = await database.raw(`
      SELECT 1 FROM pg_indexes WHERE indexname = 'signers_doc_email_unique'
    `);
    if (hasSignerEmailIdx.rows.length === 0) {
      // Clean up duplicates first
      try {
        await database.raw(`
          DELETE FROM signers a USING signers b
          WHERE a.id > b.id
            AND a.document_request_id = b.document_request_id
            AND a.email IS NOT NULL AND b.email IS NOT NULL
            AND a.email = b.email
        `);
      } catch (_) { /* ignore cleanup errors */ }
      await database.raw(`
        CREATE UNIQUE INDEX signers_doc_email_unique
        ON signers (document_request_id, email)
        WHERE email IS NOT NULL
      `);
    }
  } catch (err) {
    // Index may already exist or duplicates still present
  }

  try {
    const hasSignerPhoneIdx = await database.raw(`
      SELECT 1 FROM pg_indexes WHERE indexname = 'signers_doc_phone_unique'
    `);
    if (hasSignerPhoneIdx.rows.length === 0) {
      await database.raw(`
        CREATE UNIQUE INDEX signers_doc_phone_unique
        ON signers (document_request_id, phone)
        WHERE phone IS NOT NULL
      `);
    }
  } catch (err) {
    // Index may already exist
  }

  // --- Signing mode on documents (20260405000001) ---
  try {
    const hasSigningMode = await database.raw(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'document_requests' AND column_name = 'signing_mode'
    `);
    if (hasSigningMode.rows.length === 0) {
      await database.schema.alterTable('document_requests', (table) => {
        table.string('signing_mode').notNullable().defaultTo('shared');
      });
    }
  } catch (err) {
    // Column may already exist
  }

  try {
    const hasSignedS3Key = await database.raw(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'signers' AND column_name = 'signed_s3_key'
    `);
    if (hasSignedS3Key.rows.length === 0) {
      await database.schema.alterTable('signers', (table) => {
        table.string('signed_s3_key');
        table.string('certificate_s3_key');
      });
    }
  } catch (err) {
    // Columns may already exist
  }

  // --- Pending signers JSON (20260406000001) ---
  try {
    const hasPendingSigners = await database.raw(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'document_requests' AND column_name = 'pending_signers_json'
    `);
    if (hasPendingSigners.rows.length === 0) {
      await database.schema.alterTable('document_requests', (table) => {
        table.text('pending_signers_json');
      });
    }
  } catch (err) {
    // Column may already exist
  }

  // Fix documents stuck in pending_confirmation that already have notified signers
  try {
    await database.raw(`
      UPDATE document_requests
      SET status = 'sent'
      WHERE status = 'pending_confirmation'
        AND id IN (
          SELECT DISTINCT document_request_id FROM signers WHERE status = 'notified'
        )
    `);
  } catch (err) {
    // Non-critical
  }

  // --- Risk Monitor tables (20260406000002) ---
  try {
    const hasRiskEventsTable = await database.schema.hasTable('risk_events');
    if (!hasRiskEventsTable) {
      await database.schema.createTable('risk_events', (table) => {
        table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
        table.string('source').notNullable();
        table.string('source_event_id').notNullable();
        table.string('event_type').notNullable();
        table.string('title');
        table.text('description');
        table.string('location');
        table.float('latitude');
        table.float('longitude');
        table.timestamp('event_time');
        table.jsonb('raw_data').notNullable();
        table.timestamp('fetched_at').notNullable().defaultTo(database.fn.now());
        table.unique(['source', 'source_event_id']);
        table.index('event_time');
        table.index('fetched_at');
      });
    }
  } catch (err) {
    // Table may already exist
  }

  try {
    const hasRiskAlertsTable = await database.schema.hasTable('risk_alerts');
    if (!hasRiskAlertsTable) {
      await database.schema.createTable('risk_alerts', (table) => {
        table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
        table.uuid('risk_event_id').references('id').inTable('risk_events').onDelete('CASCADE');
        table.string('severity').notNullable();
        table.string('title').notNullable();
        table.text('summary').notNullable();
        table.jsonb('raw_analysis');
        table.jsonb('recipients').notNullable();
        table.timestamp('sent_at');
        table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
        table.index('severity');
        table.index('created_at');
      });
    }
  } catch (err) {
    // Table may already exist
  }
}
