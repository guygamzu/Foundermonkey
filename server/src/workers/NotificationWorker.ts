import { getQueue, QUEUE_NAMES } from '../config/queue.js';
import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { EmailService } from '../services/EmailService.js';
import { MessagingService } from '../services/MessagingService.js';
import { logger } from '../config/logger.js';

export function startNotificationWorker(): void {
  const queue = getQueue(QUEUE_NAMES.NOTIFICATION);
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const auditRepo = new AuditRepository(db);
  const emailService = new EmailService();
  const messagingService = new MessagingService();

  queue.process('send-signing-notification', async (job) => {
    const { signerId, documentRequestId, senderName, fileName } = job.data;

    const signer = await db('signers').where({ id: signerId }).first();
    if (!signer) throw new Error(`Signer ${signerId} not found`);

    const signingUrl = `${process.env.APP_URL}/sign/${signer.signing_token}`;

    if (signer.delivery_channel === 'email' && signer.email) {
      await emailService.sendSigningNotification(
        signer.email,
        signer.name,
        senderName,
        fileName,
        signingUrl,
        signer.custom_message,
      );
    } else if ((signer.delivery_channel === 'sms' || signer.delivery_channel === 'whatsapp') && signer.phone) {
      await messagingService.sendSigningNotification(
        signer.delivery_channel as 'sms' | 'whatsapp',
        signer.phone,
        senderName,
        fileName,
        signingUrl,
      );
    }

    // Update signer status
    await documentRepo.updateSignerStatus(signerId, 'notified', { notified_at: new Date() } as any);

    // Log audit event
    await auditRepo.log({
      document_request_id: documentRequestId,
      signer_id: signerId,
      action: 'document_sent',
      ip_address: 'system',
      user_agent: 'notification-worker',
      metadata: { channel: signer.delivery_channel },
    });

    logger.info({ signerId, channel: signer.delivery_channel }, 'Signing notification sent');
  });

  logger.info('Notification worker started');
}
