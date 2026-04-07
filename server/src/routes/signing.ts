import { Router, Request, Response } from 'express';
import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { logger } from '../config/logger.js';
import { notifyAdmin } from './admin.js';

export function createSigningRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const auditRepo = new AuditRepository(db);

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

      // Get fields for this signer
      const fields = await documentRepo.findFieldsBySignerId(signer.id);

      // In shared mode, also get completed fields from other signers (so they can see previous signatures)
      let otherCompletedFields: Array<{
        id: string; type: string; page: number; x: number; y: number;
        width: number; height: number; value: string | null; signerName: string | null;
      }> = [];
      if (doc.signing_mode !== 'individual') {
        const allFields = await documentRepo.findFieldsByDocumentId(doc.id);
        const allSigners = await documentRepo.findSignersByDocumentId(doc.id);
        const signerMap = new Map(allSigners.map(s => [s.id, s]));
        otherCompletedFields = allFields
          .filter(f => f.signer_id !== signer.id && f.completed_at)
          .map(f => ({
            id: f.id,
            type: f.type,
            page: f.page,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            value: f.value,
            signerName: signerMap.get(f.signer_id)?.name || null,
          }));
      }

      logger.info({ signingMode: doc.signing_mode, otherFieldsCount: otherCompletedFields.length, signerId: signer.id }, 'Signing session: otherFields loaded');

      // Generate signed URL if S3 is configured and document has been uploaded
      let documentUrl: string | null = null;
      logger.info(`Signing session: s3_key=${doc.s3_key}, AWS_KEY=${!!process.env.AWS_ACCESS_KEY_ID}`);
      if (process.env.AWS_ACCESS_KEY_ID && doc.s3_key && !doc.s3_key.startsWith('pending/')) {
        try {
          const { StorageService } = await import('../services/StorageService.js');
          const storageService = new StorageService();
          documentUrl = await storageService.getSignedDownloadUrl(doc.s3_key);
          logger.info(`Generated signed URL for s3_key=${doc.s3_key}`);
        } catch (urlErr) {
          const errMsg = urlErr instanceof Error ? urlErr.message : String(urlErr);
          logger.error(`Could not generate signed download URL: ${errMsg}`);
        }
      } else {
        logger.info(`Skipping S3 URL: s3_key=${doc.s3_key}, starts_with_pending=${doc.s3_key?.startsWith('pending/')}`);
      }

      res.json({
        document: {
          id: doc.id,
          fileName: doc.file_name,
          pageCount: doc.page_count,
          documentUrl,
          signingMode: doc.signing_mode,
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
          optionValues: f.option_values ? JSON.parse(f.option_values) : undefined,
        })),
        otherFields: otherCompletedFields,
      });
    } catch (err) {
      logger.error({ err, token: req.params.token }, 'Error fetching signing session');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Proxy endpoint to stream PDF content (avoids S3 CORS issues)
  router.get('/session/:token/document', async (req: Request<{ token: string }>, res: Response) => {
    try {
      const signer = await documentRepo.findSignerByToken(req.params.token);
      if (!signer) {
        res.status(404).json({ error: 'Signing link not found or expired' });
        return;
      }

      const doc = await documentRepo.findById(signer.document_request_id);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      if (!process.env.AWS_ACCESS_KEY_ID || !doc.s3_key || doc.s3_key.startsWith('pending/')) {
        res.status(404).json({ error: 'Document file not available' });
        return;
      }

      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();
        const pdfBuffer = await storageService.getDocument(doc.s3_key);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);
      } catch (s3Err) {
        logger.error({ err: s3Err, s3Key: doc.s3_key }, 'Error fetching document from S3');
        res.status(502).json({ error: 'Could not retrieve document' });
      }
    } catch (err) {
      logger.error({ err, token: req.params.token }, 'Error in document proxy');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create a new field (free-form placement by signee)
  router.post('/session/:token/fields', async (req: Request<{ token: string }>, res: Response) => {
    try {
      const signer = await documentRepo.findSignerByToken(req.params.token);
      if (!signer || signer.status === 'signed') {
        res.status(403).json({ error: 'Invalid signing session' });
        return;
      }

      const { type, page, x, y, width, height, value } = req.body;
      if (!type || !page || x === undefined || y === undefined) {
        res.status(400).json({ error: 'type, page, x, y are required' });
        return;
      }

      const fields = await documentRepo.createFields([{
        document_request_id: signer.document_request_id,
        signer_id: signer.id,
        type,
        page,
        x,
        y,
        width: width || (type === 'signature' ? 0.25 : type === 'checkbox' ? 0.03 : 0.15),
        height: height || (type === 'signature' ? 0.05 : type === 'checkbox' ? 0.03 : 0.035),
        required: false,
      }]);

      const field = fields[0];

      // If value provided, set it immediately
      if (value && field) {
        await documentRepo.updateFieldValue(field.id, value);
      }

      await auditRepo.log({
        document_request_id: signer.document_request_id,
        signer_id: signer.id,
        action: 'field_completed',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
        metadata: { fieldId: field?.id, fieldType: type },
      });

      res.json({
        success: true,
        field: {
          id: field?.id,
          type,
          page,
          x, y,
          width: width || 0.15,
          height: height || 0.035,
          value,
          completed: !!value,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Error creating field');
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

      // Check that at least one field (signature) has been placed
      const fields = await documentRepo.findFieldsBySignerId(signer.id);
      const hasSignature = fields.some(f => f.type === 'signature' && f.completed_at);
      if (!hasSignature) {
        res.status(400).json({ error: 'Please place and complete at least one signature before finishing' });
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
      const doc = await documentRepo.findById(signer.document_request_id);
      const allSigners = await documentRepo.findSignersByDocumentId(signer.document_request_id);
      const allSigned = allSigners.every((s) => s.status === 'signed');

      // Individual mode: generate per-signer PDF immediately
      if (doc?.signing_mode === 'individual') {
        try {
          const { StorageService } = await import('../services/StorageService.js');
          const { AIService } = await import('../services/AIService.js');
          const { DocumentService } = await import('../services/DocumentService.js');
          const { EmailService } = await import('../services/EmailService.js');
          const storageService = new StorageService();
          const aiService = new AIService();
          const documentService = new DocumentService(documentRepo, auditRepo, storageService, aiService);
          const emailService = new EmailService();

          // Generate PDF with only this signer's fields
          const signerPdf = await documentService.applySignaturesToDocument(signer.document_request_id, signer.id);
          const signerName = signer.name || signer.email?.split('@')[0] || 'signer';
          const signedKey = `signed/${signer.document_request_id}/${signer.id}/${doc.file_name.replace('.pdf', '')}-signed-${signerName}.pdf`;
          await storageService.uploadDocument(signedKey, signerPdf, 'application/pdf');

          // Store per-signer signed key
          await db('signers').where({ id: signer.id }).update({ signed_s3_key: signedKey });

          // Send to this signer + sender
          const sender = await db('users').where({ id: doc.sender_id }).first();
          const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
          const attachment = { filename: `${doc.file_name.replace('.pdf', '')}-signed-${signerName}.pdf`, content: signerPdf, contentType: 'application/pdf' };

          const recipientEmails = new Set<string>();
          if (signer.email) recipientEmails.add(signer.email);
          if (sender?.email) recipientEmails.add(sender.email);

          for (const email of recipientEmails) {
            const isSender = sender?.email && email === sender.email;
            const senderCredits = isSender ? { credits: sender.credits, purchaseUrl: `${appUrl}/credits?user=${sender.id}` } : undefined;
            await emailService.sendCompletionNotification(email, doc.file_name, `${appUrl}/status/${doc.id}`, [attachment], senderCredits);
          }

          logger.info({ documentId: doc.id, signerId: signer.id }, 'Individual signer completion processed');
        } catch (completionErr) {
          logger.error({ err: completionErr }, 'Individual signer completion failed');
        }

        if (allSigned) {
          // All done — also generate combined PDF
          await documentRepo.updateStatus(signer.document_request_id, 'completed');
          try {
            const { StorageService } = await import('../services/StorageService.js');
            const { AIService } = await import('../services/AIService.js');
            const { DocumentService } = await import('../services/DocumentService.js');
            const { EmailService } = await import('../services/EmailService.js');
            const storageService = new StorageService();
            const aiService = new AIService();
            const documentService = new DocumentService(documentRepo, auditRepo, storageService, aiService);
            const emailService = new EmailService();

            const combinedPdf = await documentService.applySignaturesToDocument(signer.document_request_id);
            const certificate = await documentService.generateCertificateOfCompletion(signer.document_request_id);

            const signedKey = storageService.generateSignedKey(signer.document_request_id, `${doc!.file_name.replace('.pdf', '')}-signed-all.pdf`);
            const certKey = storageService.generateCertificateKey(signer.document_request_id);
            await storageService.uploadDocument(signedKey, combinedPdf, 'application/pdf');
            await storageService.uploadDocument(certKey, certificate, 'application/pdf');
            await documentRepo.markCompleted(signer.document_request_id, signedKey, certKey);

            // Send combined PDF to sender
            const sender = await db('users').where({ id: doc!.sender_id }).first();
            if (sender?.email) {
              const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
              const attachments = [
                { filename: `${doc!.file_name.replace('.pdf', '')}-signed-all.pdf`, content: combinedPdf, contentType: 'application/pdf' },
                { filename: `Certificate-of-Completion.pdf`, content: certificate, contentType: 'application/pdf' },
              ];
              await emailService.sendCompletionNotification(sender.email, doc!.file_name, `${appUrl}/archive/${signer.document_request_id}`, attachments, { credits: sender.credits, purchaseUrl: `${appUrl}/credits?user=${sender.id}` });
            }
            logger.info({ documentId: doc!.id }, 'All individual signers complete — combined PDF sent');
          } catch (err) {
            logger.error({ err }, 'Combined PDF generation failed');
          }
        } else {
          await documentRepo.updateStatus(signer.document_request_id, 'partially_signed');
        }
      } else if (allSigned) {
        // Shared mode: existing logic — wait for all, then merge
        await documentRepo.updateStatus(signer.document_request_id, 'completed');

        // Generate signed PDF and send completion emails
        let completionHandled = false;
        if (process.env.REDIS_URL) {
          try {
            const { getQueue, QUEUE_NAMES } = await import('../config/queue.js');
            const completionQueue = getQueue(QUEUE_NAMES.DOCUMENT_COMPLETION);
            await completionQueue.add('complete-document', {
              documentRequestId: signer.document_request_id,
            });
            completionHandled = true;
          } catch (qErr) {
            logger.warn({ err: qErr }, 'Could not queue document completion, will process inline');
          }
        }

        // Process inline if no Redis or queue failed
        if (!completionHandled) {
          try {
            const { StorageService } = await import('../services/StorageService.js');
            const { AIService } = await import('../services/AIService.js');
            const { DocumentService } = await import('../services/DocumentService.js');
            const { EmailService } = await import('../services/EmailService.js');
            const storageService = new StorageService();
            const aiService = new AIService();
            const documentService = new DocumentService(documentRepo, auditRepo, storageService, aiService);
            const emailService = new EmailService();

            const completedDoc = await documentRepo.findById(signer.document_request_id);
            if (completedDoc) {
              // Apply signatures to PDF
              const signedPdf = await documentService.applySignaturesToDocument(signer.document_request_id);
              const certificate = await documentService.generateCertificateOfCompletion(signer.document_request_id);

              // Upload signed docs
              const signedKey = storageService.generateSignedKey(signer.document_request_id, `${completedDoc.file_name.replace('.pdf', '')}-signed.pdf`);
              const certKey = storageService.generateCertificateKey(signer.document_request_id);
              await storageService.uploadDocument(signedKey, signedPdf, 'application/pdf');
              await storageService.uploadDocument(certKey, certificate, 'application/pdf');
              await documentRepo.markCompleted(signer.document_request_id, signedKey, certKey);

              // Send completion emails
              const allSigners = await documentRepo.findSignersByDocumentId(signer.document_request_id);
              const sender = await db('users').where({ id: completedDoc.sender_id }).first();
              const allEmails = new Set<string>();
              if (sender?.email) allEmails.add(sender.email);
              for (const s of allSigners) { if (s.email) allEmails.add(s.email); }

              const signedPdfAttachment = { filename: `${completedDoc.file_name.replace('.pdf', '')}-signed.pdf`, content: signedPdf, contentType: 'application/pdf' };
              const certificateAttachment = { filename: `Certificate-of-Completion.pdf`, content: certificate, contentType: 'application/pdf' };
              const archiveUrl = `${process.env.APP_URL}/archive/${signer.document_request_id}`;

              for (const email of allEmails) {
                const isSender = sender?.email && email === sender.email;
                const senderCredits = isSender ? { credits: sender.credits, purchaseUrl: `${process.env.APP_URL}/credits?user=${sender.id}` } : undefined;
                const attachments = isSender
                  ? [signedPdfAttachment, certificateAttachment]
                  : [signedPdfAttachment];
                await emailService.sendCompletionNotification(email, completedDoc.file_name, archiveUrl, attachments, senderCredits);
              }

              notifyAdmin('document_completed', { fileName: completedDoc.file_name, senderEmail: sender?.email });
              logger.info({ documentId: signer.document_request_id }, 'Document completion processed inline');
            }
          } catch (completionErr) {
            logger.error({ err: completionErr }, 'Inline document completion failed');
          }
        }
      } else {
        // For sequential signing, notify next signer
        const doc = await documentRepo.findById(signer.document_request_id);
        if (doc?.is_sequential && process.env.REDIS_URL) {
          try {
            const nextSigner = await documentRepo.getNextPendingSigner(signer.document_request_id);
            if (nextSigner) {
              const { getQueue, QUEUE_NAMES } = await import('../config/queue.js');
              const notificationQueue = getQueue(QUEUE_NAMES.NOTIFICATION);
              const sender = await db('users').where({ id: doc.sender_id }).first();
              await notificationQueue.add('send-signing-notification', {
                signerId: nextSigner.id,
                documentRequestId: doc.id,
                senderName: sender?.name || sender?.email?.split('@')[0] || 'Someone',
                fileName: doc.file_name,
              });
            }
          } catch (qErr) {
            logger.warn({ err: qErr }, 'Could not queue notification');
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

      // Notify sender via email if configured
      if (process.env.RESEND_API_KEY || process.env.SMTP_HOST) {
        try {
          const doc = await documentRepo.findById(signer.document_request_id);
          if (doc) {
            const sender = await db('users').where({ id: doc.sender_id }).first();
            if (sender) {
              const emailService = await import('../services/EmailService.js');
              const service = new emailService.EmailService();
              const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
              const purchaseUrl = `${appUrl}/credits?user=${sender.id}`;
              const creditFooter = service.renderCreditBalanceHtml(sender.credits, purchaseUrl);
              const creditText = service.renderCreditBalanceText(sender.credits);
              await service.sendEmail({
                to: sender.email,
                subject: `Signing declined: ${doc.file_name}`,
                text: `${signer.name || signer.email || 'A signer'} has declined to sign ${doc.file_name}.${reason ? `\n\nReason: ${reason}` : ''}\n\n${creditText}`,
                html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #dc2626; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px;">Signing Declined</h1>
  </div>
  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
    <p><strong>${signer.name || signer.email || 'A signer'}</strong> has declined to sign <strong>${doc.file_name}</strong>.</p>
    ${reason ? `<p style="color: #6b7280;">Reason: ${reason}</p>` : ''}
  </div>
  ${creditFooter}
</div>`,
              });
            }
          }
        } catch (emailErr) {
          logger.warn({ err: emailErr }, 'Could not send decline notification email');
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
      if (!process.env.ANTHROPIC_API_KEY) {
        res.status(503).json({ error: 'AI Q&A is not configured' });
        return;
      }

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

      const { AIService } = await import('../services/AIService.js');
      const aiService = new AIService();

      // Extract actual PDF text content for the AI to answer questions about
      let documentText = `Document: ${doc.file_name}, ${doc.page_count} pages`;
      if (process.env.AWS_ACCESS_KEY_ID && doc.s3_key && !doc.s3_key.startsWith('pending/')) {
        try {
          const { StorageService } = await import('../services/StorageService.js');
          const { extractPdfText } = await import('../services/pdfTextExtractor.js');
          const storageService = new StorageService();
          const pdfBuffer = await storageService.getDocument(doc.s3_key);
          const { text } = await extractPdfText(pdfBuffer);
          if (text.trim().length > 0) {
            documentText = `Document: ${doc.file_name} (${doc.page_count} pages)\n\nContent:\n${text}`;
          }
        } catch (pdfErr) {
          logger.warn(`Could not extract PDF text for Q&A: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`);
        }
      }

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
