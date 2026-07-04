import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { EmailService } from '../services/EmailService.js';
import { logger } from '../config/logger.js';

const SENDER_NOTIFY_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

export function startReminderWorker(): void {
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const emailService = new EmailService();

  async function checkAndNotifySenders() {
    try {
      const activeDocs = await db('document_requests')
        .whereIn('status', ['sent', 'partially_signed'])
        .where('expires_at', '>', new Date())
        .whereNull('sender_nudge_notified_at')
        .select('id', 'file_name', 'sender_id');

      for (const doc of activeDocs) {
        try {
          const signers = await documentRepo.findSignersByDocumentId(doc.id);
          const unsignedSigners = signers.filter(
            (s) => s.email && s.status !== 'signed' && s.status !== 'declined',
          );

          if (unsignedSigners.length === 0) continue;

          const earliestNotified = signers
            .filter((s) => s.notified_at)
            .map((s) => new Date(s.notified_at!).getTime())
            .sort((a, b) => a - b)[0];

          if (!earliestNotified) continue;

          const elapsed = Date.now() - earliestNotified;
          if (elapsed < SENDER_NOTIFY_AFTER_MS) continue;

          const sender = await db('users').where({ id: doc.sender_id }).first();
          if (!sender?.email) continue;

          const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
          const statusUrl = `${appUrl}/status/${doc.id}`;

          try {
            await emailService.sendSenderNudgeNotification(
              sender.email,
              sender.name || sender.email.split('@')[0],
              doc.file_name,
              unsignedSigners.map((s) => ({
                name: s.name || undefined,
                email: s.email!,
              })),
              statusUrl,
            );

            await db('document_requests')
              .where({ id: doc.id })
              .update({ sender_nudge_notified_at: new Date() });

            logger.info({
              documentId: doc.id,
              unsignedCount: unsignedSigners.length,
            }, 'Sender nudge notification sent');
          } catch (emailErr) {
            logger.warn({
              err: emailErr instanceof Error ? emailErr.message : String(emailErr),
              documentId: doc.id,
            }, 'Failed to send sender nudge notification');
          }
        } catch (docErr) {
          logger.warn({
            err: docErr instanceof Error ? docErr.message : String(docErr),
            documentId: doc.id,
          }, 'Error processing nudge check for document');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Reminder worker check failed');
    }
  }

  checkAndNotifySenders();
  setInterval(checkAndNotifySenders, CHECK_INTERVAL_MS);

  logger.info('Reminder worker started (sender nudge mode, checking every hour)');
}
