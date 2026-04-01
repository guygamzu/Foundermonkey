import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add referral_code to users
  await knex.schema.alterTable('users', (table) => {
    table.string('referral_code').unique();
  });

  // Generate referral codes for existing users
  const users = await knex('users').select('id');
  for (const user of users) {
    const code = user.id.replace(/-/g, '').substring(0, 8).toUpperCase();
    await knex('users').where({ id: user.id }).update({ referral_code: code });
  }

  // Referrals tracking table
  await knex.schema.createTable('referrals', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('referrer_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('referred_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('credits_awarded').notNullable().defaultTo(5);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['referrer_id', 'referred_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('referrals');
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('referral_code');
  });
}
