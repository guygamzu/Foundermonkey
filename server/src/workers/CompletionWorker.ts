import { getQueue, QUEUE_NAMES } from '../config/queue.js';
import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { StorageService } from '../services/StorageService.js';
import { AIService } from '../services/AIService.js';
import { EmailService } from '../services/EmailService.js';
import { DocumentService } from '../services/DocumentService.js';
import { logger } from '../config/logger.js';
import { notifyAdmin } from '../routes/admin.js';

export function startCompletionWorker(): void {
  const queue = getQueue(QUEUE_NAMES.DOCUMENT_COMPLETION);
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const auditRepo = new AuditRepository(db);
  const storageService = new StorageService();
  const aiService = new AIService();
  const emailService = new EmailService();
  const documentService = new DocumentService(documentRepo, auditRepo, storageService, aiService);

  queue.process('complete-document', async (job) => {
    const { documentRequestId } = job.data;

    const doc = await documentRepo.findById(documentRequestId);
    if (!doc) throw new Error('Document not found');

    // Try to generate signed PDF and certificate (non-fatal if fails)
    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
    try {
      const signedPdf = await documentService.applySignaturesToDocument(documentRequestId);
      const certificate = await documentService.generateCertificateOfCompletion(documentRequestId);

      const signedKey = storageService.generateSignedKey(documentRequestId, `${doc.file_name.replace('.pdf', '')}-signed.pdf`);
      const certKey = storageService.generateCertificateKey(documentRequestId);

      await storageService.uploadDocument(signedKey, signedPdf, 'application/pdf');
      await storageService.uploadDocument(certKey, certificate, 'application/pdf');

      await documentRepo.markCompleted(documentRequestId, signedKey, certKey);

      attachments.push(
        { filename: `${doc.file_name.replace('.pdf', '')}-signed.pdf`, content: signedPdf, contentType: 'application/pdf' },
        { filename: `Certificate-of-Completion-${doc.file_name}`, content: certificate, contentType: 'application/pdf' },
      );
    } catch (pdfErr) {
      logger.error({ error: pdfErr instanceof Error ? pdfErr.message : String(pdfErr), stack: pdfErr instanceof Error ? pdfErr.stack : undefined, documentRequestId }, 'PDF generation failed — sending completion emails without attachments');
    }

    // Log completion
    await auditRepo.log({
      document_request_id: documentRequestId,
      signer_id: null,
      action: 'document_completed',
      ip_address: 'system',
      user_agent: 'completion-worker',
    });

    // Always send completion notifications to all parties
    const signers = await documentRepo.findSignersByDocumentId(documentRequestId);
    const sender = await db('users').where({ id: doc.sender_id }).first();
    const statusUrl = `${process.env.APP_URL}/status/${documentRequestId}`;

    const allEmails = new Set<string>();
    if (sender?.email) allEmails.add(sender.email);
    for (const signer of signers) {
      if (signer.email) allEmails.add(signer.email);
    }

    for (const email of allEmails) {
      const isSender = sender?.email && email === sender.email;
      const senderCredits = isSender ? { credits: sender.credits, purchaseUrl: `${process.env.APP_URL}/credits?user=${sender.id}` } : undefined;
      const emailAttachments = isSender ? attachments : attachments.filter(a => !a.filename.startsWith('Certificate'));
      await emailService.sendCompletionNotification(email, doc.file_name, statusUrl, emailAttachments, senderCredits);
    }

    notifyAdmin('document_completed', { fileName: doc.file_name, senderEmail: sender?.email });
    logger.info({ documentRequestId, withPdf: attachments.length > 0 }, 'Document completion processed');
  });

  logger.info('Completion worker started');
}
