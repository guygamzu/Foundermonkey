import { Router, Request, Response } from 'express';
import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { StorageService } from '../services/StorageService.js';
import { logger } from '../config/logger.js';

export function createDocumentsRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const auditRepo = new AuditRepository(db);
  const storageService = new StorageService();

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

      const documentUrl = await storageService.getSignedDownloadUrl(doc.s3_key);
      const fields = await documentRepo.findFieldsByDocumentId(doc.id);
      const signers = await documentRepo.findSignersByDocumentId(doc.id);

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

  // Get completed document archive
  router.get('/archive/:documentId', async (req: Request<{ documentId: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.documentId);
      if (!doc || doc.status !== 'completed') {
        res.status(404).json({ error: 'Completed document not found' });
        return;
      }

      const signedUrl = doc.signed_s3_key
        ? await storageService.getSignedDownloadUrl(doc.signed_s3_key)
        : null;
      const certificateUrl = doc.certificate_s3_key
        ? await storageService.getSignedDownloadUrl(doc.certificate_s3_key)
        : null;

      const auditTrail = await auditRepo.findByDocumentId(doc.id);

      res.json({
        id: doc.id,
        fileName: doc.file_name,
        completedAt: doc.completed_at,
        signedDocumentUrl: signedUrl,
        certificateUrl,
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
