import { getQueue, QUEUE_NAMES } from '../config/queue.js';
import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { StorageService } from '../services/StorageService.js';
import { AIService } from '../services/AIService.js';
import { EmailService } from '../services/EmailService.js';
import { DocumentService } from '../services/DocumentService.js';
import { logger } from '../config/logger.js';

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

    // Apply all signatures to PDF
    const signedPdf = await documentService.applySignaturesToDocument(documentRequestId);

    // Generate certificate of completion
    const certificate = await documentService.generateCertificateOfCompletion(documentRequestId);

    // Upload signed document and certificate
    const signedKey = storageService.generateSignedKey(documentRequestId, `${doc.file_name.replace('.pdf', '')}-signed.pdf`);
    const certKey = storageService.generateCertificateKey(documentRequestId);

    await storageService.uploadDocument(signedKey, signedPdf, 'application/pdf');
    await storageService.uploadDocument(certKey, certificate, 'application/pdf');

    // Update document record
    await documentRepo.markCompleted(documentRequestId, signedKey, certKey);

    // Log completion
    await auditRepo.log({
      document_request_id: documentRequestId,
      signer_id: null,
      action: 'document_completed',
      ip_address: 'system',
      user_agent: 'completion-worker',
    });

    // Send completion notifications to all parties
    const signers = await documentRepo.findSignersByDocumentId(documentRequestId);
    const sender = await db('users').where({ id: doc.sender_id }).first();
    const archiveUrl = `${process.env.APP_URL}/archive/${documentRequestId}`;

    const allEmails = new Set<string>();
    if (sender?.email) allEmails.add(sender.email);
    for (const signer of signers) {
      if (signer.email) allEmails.add(signer.email);
    }

    const attachments = [
      { filename: `${doc.file_name.replace('.pdf', '')}-signed.pdf`, content: signedPdf, contentType: 'application/pdf' },
      { filename: `Certificate-of-Completion-${doc.file_name}`, content: certificate, contentType: 'application/pdf' },
    ];

    for (const email of allEmails) {
      await emailService.sendCompletionNotification(email, doc.file_name, archiveUrl, attachments);
    }

    logger.info({ documentRequestId }, 'Document completion processed');
  });

  logger.info('Completion worker started');
}
