import { Router, Request, Response } from 'express';
import { getDatabase } from '../config/database.js';
import { getQueue, QUEUE_NAMES } from '../config/queue.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { StorageService } from '../services/StorageService.js';
import { AIService } from '../services/AIService.js';
import { logger } from '../config/logger.js';

export function createSigningRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const auditRepo = new AuditRepository(db);
  const storageService = new StorageService();
  const aiService = new AIService();

  // Get signing session data by token
  router.get('/session/:token', async (req: Request<{ token: string }>, res: Response) => {
    try {
      const signer = await documentRepo.findSignerByToken(req.params.token);
      if (!signer) {
        res.status(404).json({ error: 'Signing link not found or expired' });
        return;
      }

      if (signer.status === 'signed') {
        res.status(410).json({ error: 'already_signed', message: "You've already signed this document." });
        return;
      }

      if (signer.status === 'declined') {
        res.status(410).json({ error: 'declined', message: 'This signing request was declined.' });
        return;
      }

      const doc = await documentRepo.findById(signer.document_request_id);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      if (doc.status === 'expired' || doc.status === 'cancelled') {
        res.status(410).json({ error: 'expired', message: 'This signing link has expired.' });
        return;
      }

      // Mark as viewed
      if (signer.status === 'notified' || signer.status === 'pending') {
        await documentRepo.updateSignerStatus(signer.id, 'viewed', { viewed_at: new Date() } as any);
        await auditRepo.log({
          document_request_id: doc.id,
          signer_id: signer.id,
          action: 'document_viewed',
          ip_address: req.ip || 'unknown',
          user_agent: req.headers['user-agent'] || 'unknown',
        });
      }

      // Get document download URL
      const documentUrl = await storageService.getSignedDownloadUrl(doc.s3_key);

      // Get fields for this signer
      const fields = await documentRepo.findFieldsBySignerId(signer.id);

      res.json({
        document: {
          id: doc.id,
          fileName: doc.file_name,
          pageCount: doc.page_count,
          documentUrl,
        },
        signer: {
          id: signer.id,
          name: signer.name,
          email: signer.email,
        },
        fields: fields.map((f) => ({
          id: f.id,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
          value: f.value,
          completed: !!f.completed_at,
        })),
      });
    } catch (err) {
      logger.error({ err, token: req.params.token }, 'Error fetching signing session');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Submit field value
  router.post('/session/:token/fields/:fieldId', async (req: Request<{ token: string; fieldId: string }>, res: Response) => {
    try {
      const signer = await documentRepo.findSignerByToken(req.params.token);
      if (!signer || signer.status === 'signed') {
        res.status(403).json({ error: 'Invalid signing session' });
        return;
      }

      const { value } = req.body;
      if (!value) {
        res.status(400).json({ error: 'Value is required' });
        return;
      }

      const field = await documentRepo.updateFieldValue(req.params.fieldId, value);

      await auditRepo.log({
        document_request_id: signer.document_request_id,
        signer_id: signer.id,
        action: 'field_completed',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
        metadata: { fieldId: field.id, fieldType: field.type },
      });

      res.json({ success: true, field: { id: field.id, completed: true } });
    } catch (err) {
      logger.error({ err }, 'Error updating field');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Complete signing (consent + finalize)
  router.post('/session/:token/complete', async (req: Request<{ token: string }>, res: Response) => {
    try {
      const signer = await documentRepo.findSignerByToken(req.params.token);
      if (!signer || signer.status === 'signed') {
        res.status(403).json({ error: 'Invalid signing session' });
        return;
      }

      // Verify consent
      const { consent } = req.body;
      if (!consent) {
        res.status(400).json({ error: 'Electronic signature consent is required' });
        return;
      }

      // Check all required fields are completed
      const allCompleted = await documentRepo.areAllFieldsCompleted(signer.document_request_id, signer.id);
      if (!allCompleted) {
        res.status(400).json({ error: 'All required fields must be completed before signing' });
        return;
      }

      // Log consent
      await auditRepo.log({
        document_request_id: signer.document_request_id,
        signer_id: signer.id,
        action: 'consent_given',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
      });

      // Mark signer as signed
      await documentRepo.updateSignerStatus(signer.id, 'signed', { signed_at: new Date() } as any);

      await auditRepo.log({
        document_request_id: signer.document_request_id,
        signer_id: signer.id,
        action: 'document_signed',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
      });

      // Check if all signers have signed
      const allSigners = await documentRepo.findSignersByDocumentId(signer.document_request_id);
      const allSigned = allSigners.every((s) => s.status === 'signed');

      if (allSigned) {
        // Queue document completion
        const completionQueue = getQueue(QUEUE_NAMES.DOCUMENT_COMPLETION);
        await completionQueue.add('complete-document', {
          documentRequestId: signer.document_request_id,
        });
      } else {
        // For sequential signing, notify next signer
        const doc = await documentRepo.findById(signer.document_request_id);
        if (doc?.is_sequential) {
          const nextSigner = await documentRepo.getNextPendingSigner(signer.document_request_id);
          if (nextSigner) {
            const notificationQueue = getQueue(QUEUE_NAMES.NOTIFICATION);
            const sender = await db('users').where({ id: doc.sender_id }).first();
            await notificationQueue.add('send-signing-notification', {
              signerId: nextSigner.id,
              documentRequestId: doc.id,
              senderName: sender?.name || sender?.email?.split('@')[0] || 'Someone',
              fileName: doc.file_name,
            });
          }
        }

        // Update document status
        await documentRepo.updateStatus(signer.document_request_id, 'partially_signed');
      }

      res.json({ success: true, allCompleted: allSigned });
    } catch (err) {
      logger.error({ err }, 'Error completing signing');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Decline signing
  router.post('/session/:token/decline', async (req: Request<{ token: string }>, res: Response) => {
    try {
      const signer = await documentRepo.findSignerByToken(req.params.token);
      if (!signer) {
        res.status(404).json({ error: 'Invalid signing session' });
        return;
      }

      const { reason } = req.body;

      await documentRepo.updateSignerStatus(signer.id, 'declined', {
        declined_at: new Date(),
        decline_reason: reason,
      } as any);

      await auditRepo.log({
        document_request_id: signer.document_request_id,
        signer_id: signer.id,
        action: 'document_declined',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
        metadata: { reason },
      });

      // Update document status
      await documentRepo.updateStatus(signer.document_request_id, 'declined');

      // Notify sender
      const doc = await documentRepo.findById(signer.document_request_id);
      if (doc) {
        const sender = await db('users').where({ id: doc.sender_id }).first();
        if (sender) {
          const emailService = await import('../services/EmailService.js');
          const service = new emailService.EmailService();
          await service.sendEmail({
            to: sender.email,
            subject: `Signing declined: ${doc.file_name}`,
            text: `${signer.name || signer.email || 'A signer'} has declined to sign ${doc.file_name}.${reason ? `\n\nReason: ${reason}` : ''}`,
          });
        }
      }

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error declining signing');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // AI Document Q&A
  router.post('/session/:token/qa', async (req: Request<{ token: string }>, res: Response) => {
    try {
      const signer = await documentRepo.findSignerByToken(req.params.token);
      if (!signer) {
        res.status(404).json({ error: 'Invalid signing session' });
        return;
      }

      const { question, history } = req.body;
      if (!question) {
        res.status(400).json({ error: 'Question is required' });
        return;
      }

      const doc = await documentRepo.findById(signer.document_request_id);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      // Get document content for Q&A
      const pdfBuffer = await storageService.getDocument(doc.s3_key);
      // In production, extract text properly; using placeholder for now
      const documentText = `Document: ${doc.file_name}, ${doc.page_count} pages`;

      const answer = await aiService.answerDocumentQuestion(
        documentText,
        question,
        history || [],
      );

      res.json(answer);
    } catch (err) {
      logger.error({ err }, 'Error in document Q&A');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
