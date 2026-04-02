import type { Knex } from 'knex';

/**
 * One-time cleanup: remove duplicate signers created by email reprocessing,
 * and fix document statuses stuck in processing states.
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Find and remove duplicate signers (keep the first one per doc+email)
  const duplicates = await knex.raw(`
    DELETE FROM signers
    WHERE id NOT IN (
      SELECT MIN(id) FROM signers GROUP BY document_request_id, email
    )
  `);

  // 2. For any document marked 'sent' that has signers already notified,
  //    leave them alone (they're fine).

  // 3. For documents stuck in 'pending_confirmation' that already have signers
  //    and those signers are notified, mark the doc as 'sent'.
  await knex.raw(`
    UPDATE document_requests
    SET status = 'sent'
    WHERE status = 'pending_confirmation'
      AND id IN (
        SELECT DISTINCT document_request_id FROM signers WHERE status = 'notified'
      )
  `);

  // 4. Add a unique constraint to prevent duplicate signers in the future
  // First check if constraint already exists
  const hasConstraint = await knex.raw(`
    SELECT 1 FROM pg_constraint WHERE conname = 'signers_doc_email_unique'
  `);
  if (hasConstraint.rows.length === 0) {
    await knex.raw(`
      ALTER TABLE signers
      ADD CONSTRAINT signers_doc_email_unique
      UNIQUE (document_request_id, email)
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  // Remove the unique constraint
  await knex.raw(`
    ALTER TABLE signers
    DROP CONSTRAINT IF EXISTS signers_doc_email_unique
  `);
}
