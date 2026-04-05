import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add signing_mode to document_requests
  await knex.schema.alterTable('document_requests', (table) => {
    table.string('signing_mode').notNullable().defaultTo('shared');
  });

  // Add per-signer signed PDF tracking
  await knex.schema.alterTable('signers', (table) => {
    table.string('signed_s3_key');
    table.string('certificate_s3_key');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('document_requests', (table) => {
    table.dropColumn('signing_mode');
  });

  await knex.schema.alterTable('signers', (table) => {
    table.dropColumn('signed_s3_key');
    table.dropColumn('certificate_s3_key');
  });
}
