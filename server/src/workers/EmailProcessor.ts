import Imap from 'imap';
import { simpleParser } from 'mailparser';
import crypto from 'crypto';
import { getDatabase } from '../config/database.js';
import { UserRepository } from '../models/UserRepository.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { EmailService } from '../services/EmailService.js';
import { logger } from '../config/logger.js';

export class EmailProcessor {
  private imap: Imap;
  private userRepo: UserRepository;
  private documentRepo: DocumentRepository;
  private auditRepo: AuditRepository;
  private emailService: EmailService;

  constructor() {
    const db = getDatabase();
    this.userRepo = new UserRepository(db);
    this.documentRepo = new DocumentRepository(db);
    this.auditRepo = new AuditRepository(db);
    this.emailService = new EmailService();

    this.imap = new Imap({
      user: process.env.IMAP_USER!,
      password: process.env.IMAP_PASS!,
      host: process.env.IMAP_HOST!,
      port: Number(process.env.IMAP_PORT) || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });
  }

  start(): void {
    this.imap.on('ready', () => {
      logger.info('IMAP connected, starting email monitoring');
      this.openInbox();
    });

    this.imap.on('error', (err: Error) => {
      logger.error({ err }, 'IMAP error');
    });

    this.imap.on('end', () => {
      logger.info('IMAP connection ended, reconnecting...');
      setTimeout(() => this.imap.connect(), 5000);
    });

    this.imap.connect();
  }

  private openInbox(): void {
    this.imap.openBox('INBOX', false, (err) => {
      if (err) {
        logger.error({ err }, 'Failed to open inbox');
        return;
      }

      // Process existing unseen messages
      this.processUnseenMessages();

      // Listen for new messages
      this.imap.on('mail', () => {
        this.processUnseenMessages();
      });
    });
  }

  private processUnseenMessages(): void {
    // Only search for recent unseen emails (last 24 hours)
    const since = new Date();
    since.setDate(since.getDate() - 1);
    this.imap.search(['UNSEEN', ['SINCE', since]], (err, results) => {
      if (err) {
        logger.error({ err: err.message }, 'IMAP search error');
        return;
      }
      if (!results?.length) {
        logger.info('No unseen recent emails found');
        return;
      }

      logger.info({ count: results.length }, 'Found unseen emails to process');
      const fetch = this.imap.fetch(results, { bodies: '', markSeen: true });

      fetch.on('message', (msg) => {
        let buffer = '';
        msg.on('body', (stream) => {
          stream.on('data', (chunk: Buffer) => { buffer += chunk.toString(); });
          stream.on('end', () => {
            this.handleEmail(buffer).catch((handleErr) => {
              const errMsg = handleErr instanceof Error ? handleErr.message : String(handleErr);
              const errStack = handleErr instanceof Error ? handleErr.stack : undefined;
              logger.error({ error: errMsg, stack: errStack }, 'Failed to process email');
            });
          });
        });
      });
    });
  }

  private async handleEmail(rawEmail: string): Promise<void> {
    const parsed = await simpleParser(rawEmail);
    const senderEmail = this.extractEmail(parsed.from?.text || '');
    if (!senderEmail) {
      logger.warn('Could not extract sender email');
      return;
    }

    const body = (parsed.text || '').trim();
    const subject = parsed.subject || '';
    const messageId = parsed.messageId || '';

    logger.info({ senderEmail, subject }, 'Processing incoming email');

    // Check if this is a Y/N reply to a pending request
    if (this.isConfirmationReply(body)) {
      logger.info('Detected confirmation reply');
      await this.handleConfirmationReply(senderEmail, body, parsed.inReplyTo as string);
      return;
    }

    // Check if this is a correction (N + instructions)
    if (this.isCorrectionReply(body)) {
      logger.info('Detected correction reply');
      await this.handleCorrectionReply(senderEmail, body, parsed.inReplyTo as string);
      return;
    }

    // New document request
    const attachments = parsed.attachments || [];
    const pdfAttachment = attachments.find(
      (a) => a.contentType === 'application/pdf' || a.filename?.endsWith('.pdf'),
    );

    if (!pdfAttachment) {
      logger.info('No PDF attachment found, sending reply');
      await this.emailService.sendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: "I didn't find any PDF attachment. Please forward the document you'd like me to send for signature.",
        inReplyTo: messageId,
      });
      return;
    }

    logger.info({ fileName: pdfAttachment.filename, size: pdfAttachment.size }, 'PDF attachment found');

    if (pdfAttachment.size > 25 * 1024 * 1024) {
      await this.emailService.sendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: 'Your document is too large (max 25MB). Please compress it or split it into smaller files.',
        inReplyTo: messageId,
      });
      return;
    }

    // Parse instructions with AI
    logger.info('Step 1: Parsing email instructions...');
    let instructions;
    try {
      const { AIService } = await import('../services/AIService.js');
      const aiService = new AIService();
      instructions = await aiService.parseEmailInstructions(body, subject);
      logger.info({ recipientCount: instructions.recipients.length }, 'Step 1 complete: AI parsed instructions');
    } catch (aiErr) {
      const errMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      logger.error({ error: errMsg }, 'AI parsing failed, attempting basic extraction');
      // Basic fallback: look for email addresses in the body
      const emailMatches = body.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
      const recipientEmails = emailMatches.filter(e => e !== senderEmail);
      instructions = {
        recipients: recipientEmails.map((email, i) => ({
          email,
          channel: 'email' as const,
          order: i + 1,
        })),
        isSequential: false,
      };
      logger.info({ recipientCount: instructions.recipients.length }, 'Step 1 complete: Fallback extraction');
    }

    if (!instructions.recipients.length) {
      logger.info('No recipients found, asking sender');
      await this.emailService.sendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: 'Who should I send this to? Please provide an email address or phone number.',
        inReplyTo: messageId,
      });
      return;
    }

    // Find or create user
    logger.info('Step 2: Finding/creating user...');
    const user = await this.userRepo.findOrCreateByEmail(senderEmail);
    logger.info({ userId: user.id, credits: user.credits }, 'Step 2 complete: User ready');

    // Process document - upload to S3 if configured, otherwise store reference
    logger.info('Step 3: Creating document record...');
    let documentId: string;
    let detectedFields: Array<{ type: string; page: number; x: number; y: number; width: number; height: number; signerIndex: number }> = [];
    let pageCount = 1;

    if (process.env.AWS_ACCESS_KEY_ID) {
      try {
        logger.info('Step 3a: Processing with S3 + AI...');
        const { StorageService } = await import('../services/StorageService.js');
        const { AIService } = await import('../services/AIService.js');
        const { DocumentService } = await import('../services/DocumentService.js');
        const storageService = new StorageService();
        const aiService = new AIService();
        const documentService = new DocumentService(
          this.documentRepo,
          this.auditRepo,
          storageService,
          aiService,
        );
        const result = await documentService.processUploadedDocument(
          user.id,
          pdfAttachment.content,
          pdfAttachment.filename || 'document.pdf',
          instructions.recipients.length,
        );
        documentId = result.documentId;
        detectedFields = result.fields;
        pageCount = result.pageCount;
        logger.info({ documentId }, 'Step 3a complete: Document processed with S3');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ error: errMsg }, 'Document processing failed, creating basic record');
        documentId = await this.createBasicDocument(user.id, pdfAttachment, messageId, subject);
      }
    } else {
      documentId = await this.createBasicDocument(user.id, pdfAttachment, messageId, subject);
    }
    logger.info({ documentId }, 'Step 3 complete: Document record created');

    // Update document with parsed instructions
    logger.info('Step 4: Updating document and creating signers...');
    const db = getDatabase();
    await db('document_requests').where({ id: documentId }).update({
      is_sequential: instructions.isSequential,
      credits_required: instructions.recipients.length,
      original_email_message_id: messageId,
      subject,
    });

    // Create signers
    for (const recipient of instructions.recipients) {
      const r = recipient as any;
      const signingToken = crypto.randomBytes(32).toString('base64url');
      await this.documentRepo.createSigner({
        document_request_id: documentId,
        email: r.email || null,
        phone: r.phone || null,
        name: r.name || null,
        status: 'pending',
        delivery_channel: r.channel || 'email',
        signing_order: r.order || 1,
        signing_token: signingToken,
        custom_message: r.customMessage || null,
      });
    }

    // Create fields for signers
    const signers = await this.documentRepo.findSignersByDocumentId(documentId);
    if (detectedFields.length > 0) {
      const fieldData = detectedFields.map((field) => ({
        document_request_id: documentId,
        signer_id: signers[field.signerIndex]?.id || signers[0].id,
        type: field.type,
        page: field.page,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
        required: true,
      }));
      await this.documentRepo.createFields(fieldData);
    } else {
      // Create default signature field for each signer
      for (const signer of signers) {
        await this.documentRepo.createFields([{
          document_request_id: documentId,
          signer_id: signer.id,
          type: 'signature',
          page: 1,
          x: 0.1,
          y: 0.85,
          width: 0.35,
          height: 0.06,
          required: true,
        }]);
      }
    }

    logger.info({ signerCount: signers.length }, 'Step 4 complete: Signers and fields created');

    // Log audit event
    logger.info('Step 5: Logging audit event...');
    await this.auditRepo.log({
      document_request_id: documentId,
      signer_id: null,
      action: 'document_created',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { senderEmail, subject },
    });

    // Check credits
    logger.info({ userCredits: user.credits, required: instructions.recipients.length }, 'Step 6: Checking credits...');
    if (user.credits < instructions.recipients.length) {
      const purchaseUrl = `${process.env.APP_URL}/credits?user=${user.id}`;

      await db('pending_requests').insert({
        user_id: user.id,
        document_request_id: documentId,
        original_email_message_id: messageId,
      });

      await this.emailService.sendInsufficientCreditsEmail(
        senderEmail,
        instructions.recipients.length,
        user.credits,
        purchaseUrl,
        messageId,
      );
      return;
    }

    // Send confirmation email to sender
    logger.info('Step 7: Sending confirmation email to sender...');
    const recipientNames = signers.map(s => s.name || s.email || s.phone).join(', ');
    const previewUrl = `${process.env.APP_URL}/preview/${documentId}`;

    await this.emailService.sendConfirmationEmail(
      senderEmail,
      user.name || senderEmail.split('@')[0],
      pdfAttachment.filename || 'document.pdf',
      detectedFields.length || signers.length,
      signers.length,
      instructions.recipients.length,
      user.credits,
      previewUrl,
      `Document will be sent to: ${recipientNames}`,
      messageId,
    );

    logger.info({ documentId, senderEmail, signerCount: signers.length }, 'Document request created from email');
  }

  private async createBasicDocument(
    senderId: string,
    attachment: { content: Buffer; filename?: string; size: number },
    messageId: string,
    subject: string,
  ): Promise<string> {
    const doc = await this.documentRepo.create({
      sender_id: senderId,
      status: 'pending_confirmation',
      file_name: attachment.filename || 'document.pdf',
      file_size: attachment.size,
      page_count: 1,
      mime_type: 'application/pdf',
      document_hash: crypto.createHash('sha256').update(attachment.content).digest('hex'),
      s3_key: `pending/${crypto.randomUUID()}.pdf`,
      is_sequential: false,
      credits_required: 1,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    return doc.id;
  }

  private async handleConfirmationReply(senderEmail: string, body: string, inReplyTo: string): Promise<void> {
    const user = await this.userRepo.findByEmail(senderEmail);
    if (!user) return;

    const db = getDatabase();

    // Find the pending document
    const pendingDoc = await db('document_requests')
      .where({ sender_id: user.id, status: 'pending_confirmation' })
      .orderBy('created_at', 'desc')
      .first();

    if (!pendingDoc) return;

    const signers = await this.documentRepo.findSignersByDocumentId(pendingDoc.id);

    // Deduct credits
    await this.userRepo.deductCredits(user.id, pendingDoc.credits_required, pendingDoc.id);

    // Update status
    await this.documentRepo.updateStatus(pendingDoc.id, 'sent');

    // Send signing notifications directly
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const signersToNotify = pendingDoc.is_sequential ? [signers[0]] : signers;

    for (const signer of signersToNotify) {
      const signingUrl = `${appUrl}/sign/${signer.signing_token}`;
      const recipientEmail = signer.email;
      if (recipientEmail) {
        await this.emailService.sendSigningNotification(
          recipientEmail,
          signer.name || undefined,
          user.name || senderEmail.split('@')[0],
          pendingDoc.file_name,
          signingUrl,
          signer.custom_message || undefined,
        );

        await this.documentRepo.updateSignerStatus(signer.id, 'notified', { notified_at: new Date() } as any);
      }
    }

    // Log audit event
    await this.auditRepo.log({
      document_request_id: pendingDoc.id,
      signer_id: null,
      action: 'document_sent',
      ip_address: 'email',
      user_agent: 'email-agent',
    });

    // Confirm to sender
    const signerList = signers.map(s => s.name || s.email || s.phone).join(', ');
    await this.emailService.sendEmail({
      to: senderEmail,
      subject: `Your document has been sent`,
      text: `I've sent ${pendingDoc.file_name} to ${signerList} for signature. I'll notify you as soon as it's completed.\n\nView status: ${process.env.APP_URL}/status/${pendingDoc.id}`,
      inReplyTo,
    });
  }

  private async handleCorrectionReply(senderEmail: string, body: string, inReplyTo: string): Promise<void> {
    const user = await this.userRepo.findByEmail(senderEmail);
    if (!user) return;

    // Acknowledge the correction
    await this.emailService.sendEmail({
      to: senderEmail,
      subject: 'Re: Correction received',
      text: "Got it! I'm re-analyzing your document with the updated instructions. I'll get back to you shortly.",
      inReplyTo,
    });
  }

  private isConfirmationReply(body: string): boolean {
    const normalized = body.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes' || normalized === 'proceed';
  }

  private isCorrectionReply(body: string): boolean {
    const normalized = body.trim().toLowerCase();
    return normalized.startsWith('n') && normalized.length > 2;
  }

  private extractEmail(fromText: string): string | null {
    const match = fromText.match(/[\w.-]+@[\w.-]+\.\w+/);
    return match ? match[0].toLowerCase() : null;
  }
}
