import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Enable UUID extension
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // Users table
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('email').notNullable().unique();
    table.string('name');
    table.integer('credits').notNullable().defaultTo(5); // FREE_CREDITS
    table.boolean('is_provisional').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index('email');
  });

  // Document requests table
  await knex.schema.createTable('document_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('sender_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('status').notNullable().defaultTo('draft');
    table.string('file_name').notNullable();
    table.integer('file_size').notNullable();
    table.integer('page_count').notNullable().defaultTo(1);
    table.string('mime_type').notNullable().defaultTo('application/pdf');
    table.string('document_hash').notNullable(); // SHA-256
    table.string('s3_key').notNullable();
    table.string('signed_s3_key');
    table.string('certificate_s3_key');
    table.boolean('is_sequential').notNullable().defaultTo(false);
    table.integer('credits_required').notNullable().defaultTo(1);
    table.string('original_email_message_id'); // For email thread continuity
    table.string('subject');
    table.timestamp('expires_at').notNullable();
    table.timestamp('completed_at');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index('sender_id');
    table.index('status');
  });

  // Signers table
  await knex.schema.createTable('signers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('document_request_id').notNullable().references('id').inTable('document_requests').onDelete('CASCADE');
    table.string('email');
    table.string('phone');
    table.string('name');
    table.string('status').notNullable().defaultTo('pending');
    table.string('delivery_channel').notNullable().defaultTo('email');
    table.integer('signing_order').notNullable().defaultTo(1);
    table.string('signing_token').notNullable().unique(); // Cryptographically secure
    table.text('custom_message');
    table.timestamp('notified_at');
    table.timestamp('viewed_at');
    table.timestamp('signed_at');
    table.timestamp('declined_at');
    table.text('decline_reason');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('document_request_id');
    table.index('signing_token');
    table.index(['document_request_id', 'signing_order']);
  });

  // Document fields table
  await knex.schema.createTable('document_fields', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('document_request_id').notNullable().references('id').inTable('document_requests').onDelete('CASCADE');
    table.uuid('signer_id').notNullable().references('id').inTable('signers').onDelete('CASCADE');
    table.string('type').notNullable(); // signature, initial, date, text, checkbox
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

  // Audit events table (immutable log)
  await knex.schema.createTable('audit_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('document_request_id').notNullable().references('id').inTable('document_requests').onDelete('CASCADE');
    table.uuid('signer_id').references('id').inTable('signers').onDelete('SET NULL');
    table.string('action').notNullable();
    table.string('ip_address').notNullable();
    table.string('user_agent').notNullable();
    table.string('geolocation');
    table.jsonb('metadata');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('document_request_id');
    table.index(['document_request_id', 'action']);
  });

  // Credit transactions table
  await knex.schema.createTable('credit_transactions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('amount').notNullable(); // positive = purchase, negative = usage
    table.integer('balance_after').notNullable();
    table.string('reason').notNullable();
    table.uuid('document_request_id').references('id').inTable('document_requests').onDelete('SET NULL');
    table.string('stripe_payment_intent_id');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('user_id');
    table.index('stripe_payment_intent_id');
  });

  // Pending requests (for credit purchase resume flow)
  await knex.schema.createTable('pending_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('document_request_id').notNullable().references('id').inTable('document_requests').onDelete('CASCADE');
    table.string('original_email_message_id');
    table.boolean('resolved').notNullable().defaultTo(false);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['user_id', 'resolved']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('pending_requests');
  await knex.schema.dropTableIfExists('credit_transactions');
  await knex.schema.dropTableIfExists('audit_events');
  await knex.schema.dropTableIfExists('document_fields');
  await knex.schema.dropTableIfExists('signers');
  await knex.schema.dropTableIfExists('document_requests');
  await knex.schema.dropTableIfExists('users');
}
