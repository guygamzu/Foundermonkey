import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { EmailService } from '../services/EmailService.js';
import { logger } from '../config/logger.js';

// Reminder schedule: 24 hours, 3 days, 7 days after notification
const REMINDER_SCHEDULE_MS = [
  24 * 60 * 60 * 1000,       // 1st reminder: 24 hours
  3 * 24 * 60 * 60 * 1000,   // 2nd reminder: 3 days
  7 * 24 * 60 * 60 * 1000,   // 3rd reminder: 7 days
];
const MAX_REMINDERS = REMINDER_SCHEDULE_MS.length;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

export function startReminderWorker(): void {
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const emailService = new EmailService();

  async function checkAndSendReminders() {
    try {
      // Find all active documents (sent or partially_signed)
      const activeDocs = await db('document_requests')
        .whereIn('status', ['sent', 'partially_signed'])
        .where('expires_at', '>', new Date())
        .select('id', 'file_name', 'sender_id', 'is_sequential');

      for (const doc of activeDocs) {
        try {
          const sender = await db('users').where({ id: doc.sender_id }).first();
          if (!sender) continue;

          const senderName = sender.name || sender.email?.split('@')[0] || 'Someone';
          const appUrl = process.env.APP_URL || 'https://app.lapen.ai';

          const signers = await documentRepo.findSignersByDocumentId(doc.id);

          for (const signer of signers) {
            if (!signer.email) continue;
            if (signer.status === 'signed' || signer.status === 'declined') continue;

            // For sequential signing, only remind the current signer
            if (doc.is_sequential && signer.status === 'pending') {
              const nextPending = await documentRepo.getNextPendingSigner(doc.id);
              if (!nextPending || nextPending.id !== signer.id) continue;
            }

            // Must have been notified to be eligible for reminders
            const notifiedAt = signer.notified_at;
            if (!notifiedAt) continue;

            const reminderCount = signer.reminder_count || 0;
            if (reminderCount >= MAX_REMINDERS) continue;

            const elapsed = Date.now() - new Date(notifiedAt).getTime();
            const threshold = REMINDER_SCHEDULE_MS[reminderCount];
            if (elapsed < threshold) continue;

            // If last reminder was sent less than 12 hours ago, skip
            if (signer.last_reminder_at) {
              const sinceLast = Date.now() - new Date(signer.last_reminder_at).getTime();
              if (sinceLast < 12 * 60 * 60 * 1000) continue;
            }

            const signingUrl = `${appUrl}/sign/${signer.signing_token}`;

            try {
              await emailService.sendSigningReminder(
                signer.email,
                signer.name || undefined,
                senderName,
                sender.email,
                doc.file_name,
                signingUrl,
                reminderCount + 1,
              );

              await db('signers').where({ id: signer.id }).update({
                reminder_count: reminderCount + 1,
                last_reminder_at: new Date(),
              });

              logger.info({
                documentId: doc.id,
                signerId: signer.id,
                reminderNumber: reminderCount + 1,
              }, 'Signing reminder sent');
            } catch (emailErr) {
              logger.warn({
                err: emailErr instanceof Error ? emailErr.message : String(emailErr),
                signerId: signer.id,
              }, 'Failed to send signing reminder');
            }
          }
        } catch (docErr) {
          logger.warn({
            err: docErr instanceof Error ? docErr.message : String(docErr),
            documentId: doc.id,
          }, 'Error processing reminders for document');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Reminder worker check failed');
    }
  }

  // Run immediately on start, then every hour
  checkAndSendReminders();
  setInterval(checkAndSendReminders, CHECK_INTERVAL_MS);

  logger.info('Reminder worker started (checking every hour)');
}
