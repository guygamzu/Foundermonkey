import type { Knex } from 'knex';

/**
 * One-time cleanup: remove duplicate signers created by email reprocessing,
 * and fix document statuses stuck in processing states.
 * Also adds unique constraints to prevent future duplicates.
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Find and remove duplicate signers (keep the first one per doc+email)
  await knex.raw(`
    DELETE FROM signers
    WHERE id NOT IN (
      SELECT MIN(id) FROM signers GROUP BY document_request_id, COALESCE(email, phone, id::text)
    )
  `);

  // 2. For documents stuck in 'pending_confirmation' that already have signers
  //    and those signers are notified, mark the doc as 'sent'.
  await knex.raw(`
    UPDATE document_requests
    SET status = 'sent'
    WHERE status = 'pending_confirmation'
      AND id IN (
        SELECT DISTINCT document_request_id FROM signers WHERE status = 'notified'
      )
  `);

  // 3. Add unique constraints to prevent duplicate signers
  const hasEmailConstraint = await knex.raw(`
    SELECT 1 FROM pg_constraint WHERE conname = 'signers_doc_email_unique'
  `);
  if (hasEmailConstraint.rows.length === 0) {
    await knex.raw(`
      CREATE UNIQUE INDEX signers_doc_email_unique
      ON signers (document_request_id, email)
      WHERE email IS NOT NULL
    `);
  }

  const hasPhoneConstraint = await knex.raw(`
    SELECT 1 FROM pg_constraint WHERE conname = 'signers_doc_phone_unique'
  `);
  if (hasPhoneConstraint.rows.length === 0) {
    await knex.raw(`
      CREATE UNIQUE INDEX signers_doc_phone_unique
      ON signers (document_request_id, phone)
      WHERE phone IS NOT NULL
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS signers_doc_email_unique');
  await knex.raw('DROP INDEX IF EXISTS signers_doc_phone_unique');
}
