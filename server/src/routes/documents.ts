import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { logger } from '../config/logger.js';

export function createDocumentsRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const auditRepo = new AuditRepository(db);

  // Create a document request with signers
  router.post('/create', async (req: Request, res: Response) => {
    try {
      const { fileName, senderEmail, signerEmail, signerName, signerPhone } = req.body;

      if (!fileName || !senderEmail || (!signerEmail && !signerPhone)) {
        res.status(400).json({ error: 'fileName, senderEmail, and signerEmail or signerPhone are required' });
        return;
      }

      // Find or create sender user
      let sender = await db('users').where({ email: senderEmail }).first();
      if (!sender) {
        [sender] = await db('users').insert({
          email: senderEmail,
          name: senderEmail.split('@')[0],
          credits: 5,
          is_provisional: true,
        }).returning('*');
      }

      // Create document request
      const signingToken = randomUUID();
      const doc = await documentRepo.create({
        sender_id: sender.id,
        status: 'sent',
        file_name: fileName,
        file_size: 0,
        page_count: 1,
        mime_type: 'application/pdf',
        document_hash: randomUUID(),
        s3_key: `documents/${randomUUID()}.pdf`,
        is_sequential: false,
        credits_required: 1,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      });

      // Create signer
      const signer = await documentRepo.createSigner({
        document_request_id: doc.id,
        email: signerEmail || null,
        phone: signerPhone || null,
        name: signerName || signerEmail?.split('@')[0] || 'Signer',
        status: 'pending',
        delivery_channel: signerEmail ? 'email' : 'sms',
        signing_order: 1,
        signing_token: signingToken,
      });

      // Create a default signature field
      await documentRepo.createFields([{
        document_request_id: doc.id,
        signer_id: signer.id,
        type: 'signature',
        page: 1,
        x: 50,
        y: 700,
        width: 200,
        height: 50,
        required: true,
      }]);

      await auditRepo.log({
        document_request_id: doc.id,
        signer_id: signer.id,
        action: 'document_created',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
      });

      const appUrl = process.env.APP_URL || 'http://localhost:3000';

      res.json({
        documentId: doc.id,
        signingToken,
        signingUrl: `${appUrl}/sign/${signingToken}`,
        statusUrl: `${appUrl}/status/${doc.id}`,
      });
    } catch (err) {
      logger.error({ err }, 'Error creating document');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get document status
  router.get('/status/:documentId', async (req: Request<{ documentId: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.documentId);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const signers = await documentRepo.findSignersByDocumentId(doc.id);

      res.json({
        id: doc.id,
        fileName: doc.file_name,
        status: doc.status,
        createdAt: doc.created_at,
        completedAt: doc.completed_at,
        signers: signers.map((s) => ({
          name: s.name,
          email: s.email,
          status: s.status,
          signedAt: s.signed_at,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Error fetching document status');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get document preview (for sender confirmation)
  router.get('/preview/:documentId', async (req: Request<{ documentId: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.documentId);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const fields = await documentRepo.findFieldsByDocumentId(doc.id);
      const signers = await documentRepo.findSignersByDocumentId(doc.id);

      // Generate signed URL if S3 is configured
      let documentUrl: string | null = null;
      if (process.env.AWS_ACCESS_KEY_ID && doc.s3_key && !doc.s3_key.startsWith('pending/')) {
        try {
          const { StorageService } = await import('../services/StorageService.js');
          const storageService = new StorageService();
          documentUrl = await storageService.getSignedDownloadUrl(doc.s3_key);
        } catch (urlErr) {
          logger.warn({ err: urlErr }, 'Could not generate preview URL');
        }
      }

      res.json({
        id: doc.id,
        fileName: doc.file_name,
        pageCount: doc.page_count,
        documentUrl,
        fields: fields.map((f) => ({
          id: f.id,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        })),
        signers: signers.map((s) => ({
          name: s.name,
          email: s.email,
          phone: s.phone,
          order: s.signing_order,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Error fetching document preview');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Proxy endpoint to stream PDF content (avoids S3 CORS issues)
  router.get('/preview/:documentId/document', async (req: Request<{ documentId: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.documentId);
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
      logger.error({ err }, 'Error in document proxy');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get completed document archive
  router.get('/archive/:documentId', async (req: Request<{ documentId: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.documentId);
      if (!doc || doc.status !== 'completed') {
        res.status(404).json({ error: 'Completed document not found' });
        return;
      }

      const auditTrail = await auditRepo.findByDocumentId(doc.id);

      res.json({
        id: doc.id,
        fileName: doc.file_name,
        completedAt: doc.completed_at,
        documentHash: doc.document_hash,
        auditTrail: auditTrail.map((e) => ({
          action: e.action,
          timestamp: e.created_at,
          ipAddress: e.ip_address,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Error fetching document archive');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
