import Imap from 'imap';
import { simpleParser, ParsedMail } from 'mailparser';
import crypto from 'crypto';
import { getDatabase } from '../config/database.js';
import { getQueue, QUEUE_NAMES } from '../config/queue.js';
import { UserRepository } from '../models/UserRepository.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { StorageService } from '../services/StorageService.js';
import { AIService } from '../services/AIService.js';
import { EmailService } from '../services/EmailService.js';
import { DocumentService } from '../services/DocumentService.js';
import { PaymentService } from '../services/PaymentService.js';
import { logger } from '../config/logger.js';

export class EmailProcessor {
  private imap: Imap;
  private userRepo: UserRepository;
  private documentRepo: DocumentRepository;
  private auditRepo: AuditRepository;
  private storageService: StorageService;
  private aiService: AIService;
  private emailService: EmailService;
  private documentService: DocumentService;
  private paymentService: PaymentService;

  constructor() {
    const db = getDatabase();
    this.userRepo = new UserRepository(db);
    this.documentRepo = new DocumentRepository(db);
    this.auditRepo = new AuditRepository(db);
    this.storageService = new StorageService();
    this.aiService = new AIService();
    this.emailService = new EmailService();
    this.documentService = new DocumentService(
      this.documentRepo,
      this.auditRepo,
      this.storageService,
      this.aiService,
    );
    this.paymentService = new PaymentService(this.userRepo);

    this.imap = new Imap({
      user: process.env.IMAP_USER!,
      password: process.env.IMAP_PASSWORD!,
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
    this.imap.search(['UNSEEN'], (err, results) => {
      if (err || !results?.length) return;

      const fetch = this.imap.fetch(results, { bodies: '', markSeen: true });

      fetch.on('message', (msg) => {
        let buffer = '';
        msg.on('body', (stream) => {
          stream.on('data', (chunk: Buffer) => { buffer += chunk.toString(); });
          stream.on('end', () => {
            this.handleEmail(buffer).catch((err) => {
              logger.error({ err }, 'Failed to process email');
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

    // Check if this is a Y/N reply to a pending request
    if (this.isConfirmationReply(body)) {
      await this.handleConfirmationReply(senderEmail, body, parsed.inReplyTo as string);
      return;
    }

    // Check if this is a correction (N + instructions)
    if (this.isCorrectionReply(body)) {
      await this.handleCorrectionReply(senderEmail, body, parsed.inReplyTo as string);
      return;
    }

    // New document request
    const attachments = parsed.attachments || [];
    const pdfAttachment = attachments.find(
      (a) => a.contentType === 'application/pdf' || a.filename?.endsWith('.pdf'),
    );

    if (!pdfAttachment) {
      await this.emailService.sendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: "I didn't find any PDF attachment. Please forward the document you'd like me to send for signature.",
        inReplyTo: messageId,
      });
      return;
    }

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
    const instructions = await this.aiService.parseEmailInstructions(body, subject);

    if (!instructions.recipients.length) {
      await this.emailService.sendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: 'Who should I send this to? Please provide an email address or phone number.',
        inReplyTo: messageId,
      });
      return;
    }

    // Find or create user
    const user = await this.userRepo.findOrCreateByEmail(senderEmail);

    // Process document
    const result = await this.documentService.processUploadedDocument(
      user.id,
      pdfAttachment.content,
      pdfAttachment.filename || 'document.pdf',
      instructions.recipients.length,
    );

    // Update document with parsed instructions
    const db = getDatabase();
    await db('document_requests').where({ id: result.documentId }).update({
      is_sequential: instructions.isSequential,
      credits_required: instructions.recipients.length,
      original_email_message_id: messageId,
      subject,
    });

    // Create signers
    for (const recipient of instructions.recipients) {
      const signingToken = crypto.randomBytes(32).toString('base64url');
      await this.documentRepo.createSigner({
        document_request_id: result.documentId,
        email: recipient.email,
        phone: recipient.phone,
        name: recipient.name,
        status: 'pending',
        delivery_channel: recipient.channel,
        signing_order: recipient.order,
        signing_token: signingToken,
        custom_message: recipient.customMessage,
      });
    }

    // Create fields for signers
    const signers = await this.documentRepo.findSignersByDocumentId(result.documentId);
    const fieldData = result.fields.map((field) => ({
      document_request_id: result.documentId,
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

    // Log audit event
    await this.auditRepo.log({
      document_request_id: result.documentId,
      signer_id: null,
      action: 'document_created',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { senderEmail, subject },
    });

    // Check credits
    if (user.credits < instructions.recipients.length) {
      const purchaseUrl = this.paymentService.getCreditPurchaseUrl(user.id);

      // Save as pending request
      await db('pending_requests').insert({
        user_id: user.id,
        document_request_id: result.documentId,
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

    // Send confirmation email
    const previewUrl = `${process.env.APP_URL}/preview/${result.documentId}`;
    const recipientNames = signers.map(s => s.name || s.email || s.phone).join(', ');

    await this.emailService.sendConfirmationEmail(
      senderEmail,
      user.name || senderEmail.split('@')[0],
      pdfAttachment.filename || 'document.pdf',
      result.fields.length,
      signers.length,
      instructions.recipients.length,
      user.credits,
      previewUrl,
      `Document will be sent to: ${recipientNames}`,
      messageId,
    );
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

    // Send to signers (respecting order for sequential)
    const signersToNotify = pendingDoc.is_sequential
      ? [signers[0]] // Only first signer for sequential
      : signers;

    const notificationQueue = getQueue(QUEUE_NAMES.NOTIFICATION);
    for (const signer of signersToNotify) {
      await notificationQueue.add('send-signing-notification', {
        signerId: signer.id,
        documentRequestId: pendingDoc.id,
        senderName: user.name || senderEmail.split('@')[0],
        fileName: pendingDoc.file_name,
      });
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
    // Re-analyze with correction instructions
    const user = await this.userRepo.findByEmail(senderEmail);
    if (!user) return;

    const db = getDatabase();
    const pendingDoc = await db('document_requests')
      .where({ sender_id: user.id, status: 'pending_confirmation' })
      .orderBy('created_at', 'desc')
      .first();

    if (!pendingDoc) return;

    // Queue re-analysis with correction context
    const analysisQueue = getQueue(QUEUE_NAMES.DOCUMENT_ANALYSIS);
    await analysisQueue.add('re-analyze', {
      documentRequestId: pendingDoc.id,
      correctionInstructions: body,
      senderEmail,
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
