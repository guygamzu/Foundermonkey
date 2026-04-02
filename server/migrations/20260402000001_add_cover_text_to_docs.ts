import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('document_requests', (table) => {
    table.text('ai_summary');
    table.text('suggested_cover_text');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('document_requests', (table) => {
    table.dropColumn('ai_summary');
    table.dropColumn('suggested_cover_text');
  });
}
