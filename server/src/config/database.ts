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
    return; // Already migrated
  }

  await database.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await database.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(database.raw('uuid_generate_v4()'));
    table.string('email').notNullable().unique();
    table.string('name');
    table.integer('credits').notNullable().defaultTo(5);
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
}
