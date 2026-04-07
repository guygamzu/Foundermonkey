import { Router, Request, Response } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { getDatabase } from '../config/database.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { UserRepository } from '../models/UserRepository.js';
import { logger } from '../config/logger.js';

export function createSetupRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const auditRepo = new AuditRepository(db);
  const userRepo = new UserRepository(db);

  // Get setup data: document + signers + fields
  router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const allowedStatuses = ['pending_setup', 'template_ready', 'sent', 'partially_signed'];
      if (!allowedStatuses.includes(doc.status)) {
        res.status(400).json({ error: 'Document is not in a configurable state', status: doc.status });
        return;
      }

      const signers = await documentRepo.findSignersByDocumentId(doc.id);
      const fields = await documentRepo.findFieldsByDocumentId(doc.id);

      // Build warning for already-sent documents
      let warning: { alreadySent: boolean; signerCount: number; signedCount: number } | undefined;
      if (doc.status === 'sent' || doc.status === 'partially_signed') {
        const signedCount = signers.filter(s => s.status === 'signed').length;
        warning = { alreadySent: true, signerCount: signers.length, signedCount };
      }

      res.json({
        id: doc.id,
        fileName: doc.file_name,
        pageCount: doc.page_count,
        isSequential: doc.is_sequential,
        signingMode: doc.signing_mode || 'shared',
        creditsRequired: doc.credits_required,
        status: doc.status,
        warning,
        signers: signers.map((s) => ({
          id: s.id,
          name: s.name,
          email: s.email,
          signingOrder: s.signing_order,
        })),
        fields: fields.map((f) => ({
          id: f.id,
          signerId: f.signer_id,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
          optionValues: f.option_values ? JSON.parse(f.option_values) : undefined,
          isTemplate: f.is_template,
        })),
      });
    } catch (err) {
      logger.error({ err, id: req.params.id }, 'Error fetching setup data');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Proxy endpoint to stream PDF content for setup page
  router.get('/:id/document', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
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
      logger.error({ err }, 'Error in setup document proxy');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create a field
  router.post('/:id/fields', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc || doc.status !== 'pending_setup') {
        res.status(400).json({ error: 'Document not in setup state' });
        return;
      }

      const { signerId, type, page, x, y, width, height, optionValues } = req.body;
      if (!signerId || !type || !page || x === undefined || y === undefined) {
        res.status(400).json({ error: 'signerId, type, page, x, y are required' });
        return;
      }

      const dims: Record<string, { w: number; h: number }> = {
        signature: { w: 0.25, h: 0.05 },
        text: { w: 0.15, h: 0.035 },
        date: { w: 0.12, h: 0.03 },
        checkbox: { w: 0.025, h: 0.025 },
        option: { w: 0.15, h: 0.035 },
      };
      const dim = dims[type as string] || { w: 0.15, h: 0.035 };

      // For option fields, validate and store option_values
      if (type === 'option' && (!optionValues || !Array.isArray(optionValues) || optionValues.length < 2)) {
        res.status(400).json({ error: 'Option fields require at least 2 choices in optionValues' });
        return;
      }

      const fields = await documentRepo.createFields([{
        document_request_id: doc.id,
        signer_id: signerId,
        type,
        page,
        x,
        y,
        width: width || dim.w,
        height: height || dim.h,
        required: true,
        ...(type === 'option' && optionValues ? { option_values: JSON.stringify(optionValues) } : {}),
      }]);

      const field = fields[0];
      res.json({
        id: field.id,
        signerId: field.signer_id,
        type: field.type,
        page: field.page,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
        required: field.required,
        optionValues: field.option_values ? JSON.parse(field.option_values) : undefined,
      });
    } catch (err) {
      logger.error({ err }, 'Error creating setup field');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete a field
  router.delete('/:id/fields/:fieldId', async (req: Request<{ id: string; fieldId: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc || doc.status !== 'pending_setup') {
        res.status(400).json({ error: 'Document not in setup state' });
        return;
      }

      await documentRepo.deleteField(req.params.fieldId);
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error deleting setup field');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Update field position
  router.patch('/:id/fields/:fieldId', async (req: Request<{ id: string; fieldId: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc || doc.status !== 'pending_setup') {
        res.status(400).json({ error: 'Document not in setup state' });
        return;
      }

      const { x, y } = req.body;
      if (x === undefined || y === undefined) {
        res.status(400).json({ error: 'x and y are required' });
        return;
      }

      const field = await documentRepo.updateFieldPosition(req.params.fieldId, x, y);
      res.json({
        id: field.id,
        x: field.x,
        y: field.y,
      });
    } catch (err) {
      logger.error({ err }, 'Error updating field position');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Add a signer
  router.post('/:id/signers', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc || doc.status !== 'pending_setup') {
        res.status(400).json({ error: 'Document not in setup state' });
        return;
      }

      const { name, email } = req.body;
      if (!email) {
        res.status(400).json({ error: 'email is required' });
        return;
      }

      // Determine next signing order
      const existingSigners = await documentRepo.findSignersByDocumentId(doc.id);
      const nextOrder = existingSigners.length + 1;

      const signer = await documentRepo.createSigner({
        document_request_id: doc.id,
        email: email.toLowerCase(),
        phone: null,
        name: name || email.split('@')[0],
        status: 'pending',
        delivery_channel: 'email',
        signing_order: nextOrder,
        signing_token: randomBytes(32).toString('base64url'),
        custom_message: null,
      });

      // Update credits_required
      await db('document_requests')
        .where({ id: doc.id })
        .update({ credits_required: nextOrder, updated_at: new Date() });

      res.json({
        id: signer.id,
        name: signer.name,
        email: signer.email,
        signingOrder: signer.signing_order,
      });
    } catch (err) {
      logger.error({ err }, 'Error adding signer');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Remove a signer (cascade deletes fields)
  router.delete('/:id/signers/:signerId', async (req: Request<{ id: string; signerId: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc || doc.status !== 'pending_setup') {
        res.status(400).json({ error: 'Document not in setup state' });
        return;
      }

      // Delete fields for this signer first, then the signer
      const fields = await documentRepo.findFieldsBySignerId(req.params.signerId);
      for (const f of fields) {
        await documentRepo.deleteField(f.id);
      }
      await documentRepo.deleteSigner(req.params.signerId);

      // Update credits_required
      const remaining = await documentRepo.findSignersByDocumentId(doc.id);
      await db('document_requests')
        .where({ id: doc.id })
        .update({ credits_required: remaining.length, updated_at: new Date() });

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error removing signer');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Update document settings (signing mode)
  router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc || doc.status !== 'pending_setup') {
        res.status(400).json({ error: 'Document not in setup state' });
        return;
      }

      const { signingMode } = req.body;
      if (signingMode && ['shared', 'individual'].includes(signingMode)) {
        await db('document_requests')
          .where({ id: doc.id })
          .update({ signing_mode: signingMode, updated_at: new Date() });
      }

      res.json({ success: true, signingMode });
    } catch (err) {
      logger.error({ err }, 'Error updating setup settings');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Send for signing
  router.post('/:id/send', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc || doc.status !== 'pending_setup') {
        res.status(400).json({ error: 'Document not in setup state' });
        return;
      }

      const allSigners = await documentRepo.findSignersByDocumentId(doc.id);
      // Filter out placeholder template signer
      const signers = allSigners.filter(s => s.email !== 'template@lapen.ai');
      if (signers.length === 0) {
        res.status(400).json({ error: 'At least one signer is required. Use the Done button for template mode.' });
        return;
      }

      // For individual mode: clone template fields to all signers
      const allFields = await documentRepo.findFieldsByDocumentId(doc.id);
      if (doc.signing_mode === 'individual' && signers.length > 1) {
        // Find template fields (fields belonging to the first signer used as template)
        const templateFields = allFields.filter(f => f.is_template);
        if (templateFields.length > 0) {
          // Clone template fields for signers that don't have their own fields yet
          const signerIdsWithFields = new Set(allFields.filter(f => !f.is_template).map(f => f.signer_id));
          for (const signer of signers) {
            if (signerIdsWithFields.has(signer.id)) continue;
            for (const tf of templateFields) {
              if (tf.signer_id === signer.id) continue; // skip if template belongs to this signer
              await db('document_fields').insert({
                id: randomUUID(),
                document_request_id: doc.id,
                signer_id: signer.id,
                type: tf.type,
                page: tf.page,
                x: tf.x,
                y: tf.y,
                width: tf.width,
                height: tf.height,
                required: tf.required,
                option_values: tf.option_values,
                is_template: false,
              });
            }
          }
        }
      }

      // Re-fetch fields after potential cloning
      const fields = await documentRepo.findFieldsByDocumentId(doc.id);
      const signerIdsWithFields = new Set(fields.map(f => f.signer_id));
      const signersWithoutFields = signers.filter(s => !signerIdsWithFields.has(s.id));
      if (signersWithoutFields.length > 0) {
        const names = signersWithoutFields.map(s => s.name || s.email).join(', ');
        res.status(400).json({ error: `Each signer needs at least one field. Missing fields for: ${names}` });
        return;
      }

      // Look up sender and deduct credits
      const sender = await db('users').where({ id: doc.sender_id }).first();
      if (!sender) {
        res.status(400).json({ error: 'Sender not found' });
        return;
      }

      try {
        await userRepo.deductCredits(sender.id, signers.length, doc.id);
      } catch (creditErr) {
        res.status(402).json({ error: 'Insufficient credits', creditsRequired: signers.length, creditsAvailable: sender.credits });
        return;
      }

      // Send notifications to each signer
      const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
      const senderName = sender.name || sender.email.split('@')[0];

      const { EmailService } = await import('../services/EmailService.js');
      const emailService = new EmailService();

      for (const signer of signers) {
        if (!signer.email) continue;

        const signingUrl = `${appUrl}/sign/${signer.signing_token}`;

        try {
          await emailService.sendSigningNotification(
            signer.email,
            signer.name || undefined,
            senderName,
            sender.email,
            doc.file_name,
            signingUrl,
          );

          await documentRepo.updateSignerStatus(signer.id, 'notified', { notified_at: new Date() } as any);

          await auditRepo.log({
            document_request_id: doc.id,
            signer_id: signer.id,
            action: 'notification_sent',
            ip_address: 'setup-page',
            user_agent: req.headers['user-agent'] || 'unknown',
          });
        } catch (emailErr) {
          logger.error({ err: emailErr, signerId: signer.id }, 'Failed to send signing notification');
        }
      }

      // Update document status to sent
      await documentRepo.updateStatus(doc.id, 'sent');

      await auditRepo.log({
        document_request_id: doc.id,
        signer_id: null,
        action: 'document_sent',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
        metadata: { signerCount: signers.length, flow: 'setup' },
      });

      const statusUrl = `${appUrl}/status/${doc.id}`;
      res.json({ success: true, statusUrl });
    } catch (err) {
      logger.error({ err }, 'Error sending for signing');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Done — mark template as ready, email sender with instructions
  router.post('/:id/done', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc || doc.status !== 'pending_setup') {
        res.status(400).json({ error: 'Document not in setup state' });
        return;
      }

      const fields = await documentRepo.findFieldsByDocumentId(doc.id);
      if (fields.length === 0) {
        res.status(400).json({ error: 'At least one field must be placed before marking as done' });
        return;
      }

      // Mark all fields as template
      await db('document_fields')
        .where({ document_request_id: doc.id })
        .update({ is_template: true });

      // Remove placeholder template signer (cleanup)
      await db('signers')
        .where({ document_request_id: doc.id, email: 'template@lapen.ai' })
        .del();

      // Update document status to template_ready
      await db('document_requests')
        .where({ id: doc.id })
        .update({ status: 'template_ready', updated_at: new Date() });

      // Email sender with instructions
      const sender = await db('users').where({ id: doc.sender_id }).first();
      if (sender) {
        const { EmailService } = await import('../services/EmailService.js');
        const emailService = new EmailService();

        const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
        const purchaseUrl = `${appUrl}/credits?user=${sender.id}`;
        const creditFooter = emailService.renderCreditBalanceHtml(sender.credits, purchaseUrl);

        await emailService.sendEmail({
          to: sender.email,
          subject: `Your document "${doc.file_name}" is ready`,
          html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #16a34a; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px;">✓ Document Ready</h1>
  </div>
  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi ${sender.name || sender.email.split('@')[0]},</p>
    <p>Your fields for <strong>${doc.file_name}</strong> are configured!</p>
    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0 0 8px; font-weight: 600;">What to do next:</p>
      <ol style="margin: 0; padding-left: 20px; line-height: 1.8;">
        <li>Email the PDF <strong>"${doc.file_name}"</strong> to your recipients</li>
        <li>Add <strong>sign@lapen.ai</strong> in CC</li>
        <li>Lapen will send each recipient a personalized signing link with your pre-configured fields</li>
      </ol>
    </div>
    <p style="font-size: 13px; color: #6b7280;">Lapen will recognize the document by its filename and your email address.</p>
  </div>
  ${creditFooter}
</div>`,
          text: `Your document "${doc.file_name}" is ready!\n\nWhat to do next:\n1. Email the PDF "${doc.file_name}" to your recipients\n2. Add sign@lapen.ai in CC\n3. Lapen will send each recipient a personalized signing link with your pre-configured fields\n\nLapen will recognize the document by its filename and your email address.`,
        });
      }

      await auditRepo.log({
        document_request_id: doc.id,
        signer_id: null,
        action: 'template_ready',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
        metadata: { fieldCount: fields.length },
      });

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error marking setup as done');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Void and reconfigure — void existing signatures and return to setup
  router.post('/:id/void-and-reconfigure', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const doc = await documentRepo.findById(req.params.id);
      if (!doc) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      if (!['sent', 'partially_signed'].includes(doc.status)) {
        res.status(400).json({ error: 'Document must be in sent or partially_signed status to void' });
        return;
      }

      const signers = await documentRepo.findSignersByDocumentId(doc.id);

      // Void all signers
      for (const signer of signers) {
        await db('signers').where({ id: signer.id }).update({
          status: 'voided',
          signing_token: randomBytes(32).toString('base64url'), // invalidate old token
        });
      }

      // Delete all non-template fields (keep template fields for reconfiguration)
      await db('document_fields')
        .where({ document_request_id: doc.id, is_template: false })
        .del();

      // Delete voided signers
      await db('signers')
        .where({ document_request_id: doc.id, status: 'voided' })
        .del();

      // Reset document status
      await db('document_requests')
        .where({ id: doc.id })
        .update({ status: 'pending_setup', updated_at: new Date() });

      // Notify affected signers
      const notifiedSigners = signers.filter(s => s.email && ['notified', 'viewed', 'signed'].includes(s.status));
      if (notifiedSigners.length > 0) {
        try {
          const { EmailService } = await import('../services/EmailService.js');
          const emailService = new EmailService();
          const sender = await db('users').where({ id: doc.sender_id }).first();
          const senderName = sender?.name || sender?.email?.split('@')[0] || 'The sender';

          for (const signer of notifiedSigners) {
            if (!signer.email) continue;
            await emailService.sendEmail({
              to: signer.email,
              subject: `Document "${doc.file_name}" has been reconfigured`,
              text: `Hi ${signer.name || 'there'},\n\n${senderName} has reconfigured the document "${doc.file_name}". Your previous signature has been voided.\n\nYou'll receive a new signing link once the document is ready.\n\nLapen E-Signature Service`,
            });
          }
        } catch (emailErr) {
          logger.warn({ err: emailErr }, 'Failed to send void notification emails');
        }
      }

      await auditRepo.log({
        document_request_id: doc.id,
        signer_id: null,
        action: 'signatures_voided',
        ip_address: req.ip || 'unknown',
        user_agent: req.headers['user-agent'] || 'unknown',
        metadata: { voidedSignerCount: signers.length },
      });

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error voiding and reconfiguring');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
