import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add option_values to document_fields for option/dropdown field type
  await knex.schema.alterTable('document_fields', (table) => {
    table.text('option_values'); // JSON array of choices, e.g. '["Yes","No"]'
    table.boolean('is_template').notNullable().defaultTo(false); // marks template source fields
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('document_fields', (table) => {
    table.dropColumn('option_values');
    table.dropColumn('is_template');
  });
}
