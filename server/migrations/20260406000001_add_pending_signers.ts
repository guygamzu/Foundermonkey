import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('document_requests', (table) => {
    table.text('pending_signers_json').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('document_requests', (table) => {
    table.dropColumn('pending_signers_json');
  });
}
