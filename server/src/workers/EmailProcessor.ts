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
  private smtpVerified = false;

  constructor() {
    const db = getDatabase();
    this.userRepo = new UserRepository(db);
    this.documentRepo = new DocumentRepository(db);
    this.auditRepo = new AuditRepository(db);
    this.emailService = new EmailService();

    this.imap = new Imap({
      user: (process.env.IMAP_USER || '').replace(/@@/g, '@'),
      password: (process.env.IMAP_PASS || '').replace(/@@/g, '@'),
      host: process.env.IMAP_HOST!,
      port: Number(process.env.IMAP_PORT) || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });
  }

  async start(): Promise<void> {
    // Verify SMTP first
    this.smtpVerified = await this.emailService.verify();

    this.imap.on('ready', () => {
      logger.info('IMAP connected, starting email monitoring');
      this.openInbox();
    });

    this.imap.on('error', (err: Error) => {
      logger.error({ error: err.message }, 'IMAP error');
    });

    this.imap.on('end', () => {
      logger.info('IMAP connection ended, reconnecting in 5s...');
      setTimeout(() => this.imap.connect(), 5000);
    });

    this.imap.connect();
  }

  private openInbox(): void {
    this.imap.openBox('INBOX', false, (err) => {
      if (err) {
        logger.error({ error: err.message }, 'Failed to open inbox');
        return;
      }

      this.processUnseenMessages();

      this.imap.on('mail', () => {
        this.processUnseenMessages();
      });
    });
  }

  private processUnseenMessages(): void {
    const since = new Date();
    since.setDate(since.getDate() - 1);
    this.imap.search(['UNSEEN', ['SINCE', since]], (err, results) => {
      if (err) {
        logger.error({ error: err.message }, 'IMAP search error');
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

  private async trySendEmail(options: { to: string; subject: string; text: string; inReplyTo?: string }): Promise<void> {
    try {
      await this.emailService.sendEmail(options);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errMsg, to: options.to }, 'Failed to send email (non-fatal)');
    }
  }

  private async handleEmail(rawEmail: string): Promise<void> {
    const parsed = await simpleParser(rawEmail);
    const senderEmail = this.extractEmail(parsed.from?.text || '');
    if (!senderEmail) {
      logger.warn('Could not extract sender email');
      return;
    }

    // Only process emails addressed directly TO our inbox
    const imapUser = (process.env.IMAP_USER || '').replace(/@@/g, '@').toLowerCase();
    const toAddresses = (parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [])
      .flatMap(addr => 'value' in addr ? addr.value : [addr])
      .map(a => (a.address || '').toLowerCase());

    if (imapUser && !toAddresses.includes(imapUser)) {
      logger.info(`Skipping email not addressed to us: from=${senderEmail} to=${toAddresses.join(',')}`);
      return;
    }

    // Skip obvious automated/notification emails
    const senderLower = senderEmail.toLowerCase();
    if (senderLower.includes('noreply') || senderLower.includes('no-reply') ||
        senderLower.includes('notification') || senderLower.includes('mailer-daemon') ||
        senderLower.includes('postmaster')) {
      logger.info(`Skipping automated email from=${senderEmail}`);
      return;
    }

    const body = (parsed.text || '').trim();
    const subject = parsed.subject || '';
    const messageId = parsed.messageId || '';

    const firstLine = body.split(/\r?\n/)[0].trim();
    logger.info(`Processing incoming email: from=${senderEmail} subject="${subject}" bodyLen=${body.length} firstLine="${firstLine}"`);

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
    const attachmentSummary = attachments.map(a => `${a.filename || 'unnamed'}(${a.contentType}, ${a.size}b)`).join(', ');
    logger.info(`Email has ${attachments.length} attachment(s): ${attachmentSummary || 'none'}`);

    // Broad PDF detection: match known PDF types, octet-stream, or .pdf extension
    const pdfAttachment = attachments.find((a) => {
      const type = (a.contentType || '').toLowerCase();
      const name = (a.filename || '').toLowerCase();
      return type === 'application/pdf' ||
             type === 'application/x-pdf' ||
             type === 'application/octet-stream' ||
             type.includes('pdf') ||
             name.endsWith('.pdf');
    });

    // If no PDF found, take the first attachment if it's the only one (likely a PDF with wrong mime type)
    const selectedAttachment = pdfAttachment || (attachments.length === 1 ? attachments[0] : null);

    if (!selectedAttachment) {
      logger.warn(`No usable attachment found among: ${attachmentSummary}`);
      await this.trySendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: "I didn't find any PDF attachment. Please forward the document you'd like me to send for signature.",
        inReplyTo: messageId,
      });
      return;
    }

    if (!pdfAttachment && selectedAttachment) {
      logger.info(`No PDF mime type match, but using single attachment: ${selectedAttachment.filename}(${selectedAttachment.contentType})`);
    }

    logger.info(`PDF attachment found: ${selectedAttachment.filename} (${selectedAttachment.size}b, ${selectedAttachment.contentType})`);

    if (selectedAttachment.size > 25 * 1024 * 1024) {
      await this.trySendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: 'Your document is too large (max 25MB). Please compress it or split it into smaller files.',
        inReplyTo: messageId,
      });
      return;
    }

    // Step 1: Parse instructions with AI
    logger.info('Step 1: Parsing email instructions...');
    let instructions;
    try {
      const { AIService } = await import('../services/AIService.js');
      const aiService = new AIService();
      instructions = await aiService.parseEmailInstructions(body, subject);
      logger.info({ recipientCount: instructions.recipients.length, recipients: instructions.recipients }, 'Step 1 done: AI parsed');
    } catch (aiErr) {
      const errMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      logger.error({ error: errMsg }, 'AI parsing failed, using fallback');
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
      logger.info({ recipientCount: instructions.recipients.length, emails: recipientEmails }, 'Step 1 done: Fallback');
    }

    if (!instructions.recipients.length) {
      logger.warn('No recipients found in email');
      await this.trySendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: 'Who should I send this to? Please provide an email address or phone number.',
        inReplyTo: messageId,
      });
      return;
    }

    // Step 2: Find or create user
    logger.info('Step 2: Finding/creating user...');
    const user = await this.userRepo.findOrCreateByEmail(senderEmail);
    logger.info({ userId: user.id, credits: user.credits }, 'Step 2 done');

    // Step 3: Create document record
    logger.info('Step 3: Creating document record...');
    let documentId: string;
    let detectedFields: Array<{ type: string; page: number; x: number; y: number; width: number; height: number; signerIndex: number }> = [];

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
          selectedAttachment.content,
          selectedAttachment.filename || 'document.pdf',
          instructions.recipients.length,
        );
        documentId = result.documentId;
        detectedFields = result.fields;
        logger.info({ documentId }, 'Step 3a done: S3 upload complete');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ error: errMsg }, 'S3 processing failed, creating basic record');
        documentId = await this.createBasicDocument(user.id, selectedAttachment, messageId, subject);
      }
    } else {
      logger.info('No AWS configured, creating basic document record');
      documentId = await this.createBasicDocument(user.id, selectedAttachment, messageId, subject);
    }
    logger.info({ documentId }, 'Step 3 done');

    // Step 4: Create signers
    logger.info('Step 4: Creating signers...');
    const db = getDatabase();
    await db('document_requests').where({ id: documentId }).update({
      is_sequential: instructions.isSequential,
      credits_required: instructions.recipients.length,
      original_email_message_id: messageId,
      subject,
    });

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

    const signers = await this.documentRepo.findSignersByDocumentId(documentId);

    // Create fields
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
    logger.info({ signerCount: signers.length }, 'Step 4 done');

    // Step 5: Audit log
    logger.info('Step 5: Audit log...');
    await this.auditRepo.log({
      document_request_id: documentId,
      signer_id: null,
      action: 'document_created',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { senderEmail, subject },
    });
    logger.info('Step 5 done');

    // Step 6: Check credits
    logger.info({ userCredits: user.credits, required: instructions.recipients.length }, 'Step 6: Credits check...');
    if (user.credits < instructions.recipients.length) {
      const purchaseUrl = `${process.env.APP_URL}/credits?user=${user.id}`;
      await db('pending_requests').insert({
        user_id: user.id,
        document_request_id: documentId,
        original_email_message_id: messageId,
      });
      await this.trySendEmail({
        to: senderEmail,
        subject: 'Insufficient credits - Action needed',
        text: `This request requires ${instructions.recipients.length} credits, but you only have ${user.credits}.\n\nBuy more: ${purchaseUrl}\n\nOnce purchased, reply "Y" to proceed.`,
        inReplyTo: messageId,
      });
      logger.info('Step 6 done: Insufficient credits, notified sender');
      return;
    }

    // Step 7: Send confirmation email
    logger.info('Step 7: Sending confirmation email...');
    const recipientNames = signers.map(s => s.name || s.email || s.phone).join(', ');
    const previewUrl = `${process.env.APP_URL}/preview/${documentId}`;

    try {
      await this.emailService.sendConfirmationEmail(
        senderEmail,
        user.name || senderEmail.split('@')[0],
        selectedAttachment.filename || 'document.pdf',
        detectedFields.length || signers.length,
        signers.length,
        instructions.recipients.length,
        user.credits,
        previewUrl,
        `Document will be sent to: ${recipientNames}`,
        messageId,
      );
      logger.info({ documentId, senderEmail, signerCount: signers.length }, 'Step 7 done: Confirmation email sent!');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errMsg }, 'Step 7 FAILED: Could not send confirmation email');
    }
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
    logger.info({ senderEmail }, 'Handling confirmation reply');
    const user = await this.userRepo.findByEmail(senderEmail);
    if (!user) {
      logger.warn({ senderEmail }, 'User not found for confirmation reply');
      return;
    }

    const db = getDatabase();
    const pendingDoc = await db('document_requests')
      .where({ sender_id: user.id, status: 'pending_confirmation' })
      .orderBy('created_at', 'desc')
      .first();

    if (!pendingDoc) {
      logger.warn({ senderEmail }, 'No pending document found for confirmation');
      return;
    }

    const signers = await this.documentRepo.findSignersByDocumentId(pendingDoc.id);

    await this.userRepo.deductCredits(user.id, pendingDoc.credits_required, pendingDoc.id);
    await this.documentRepo.updateStatus(pendingDoc.id, 'sent');

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const signersToNotify = pendingDoc.is_sequential ? [signers[0]] : signers;

    for (const signer of signersToNotify) {
      const signingUrl = `${appUrl}/sign/${signer.signing_token}`;
      if (signer.email) {
        try {
          await this.emailService.sendSigningNotification(
            signer.email,
            signer.name || undefined,
            user.name || senderEmail.split('@')[0],
            pendingDoc.file_name,
            signingUrl,
            signer.custom_message || undefined,
          );
          await this.documentRepo.updateSignerStatus(signer.id, 'notified', { notified_at: new Date() } as any);
          logger.info({ signerEmail: signer.email }, 'Signing notification sent');
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ error: errMsg, signerEmail: signer.email }, 'Failed to send signing notification');
        }
      }
    }

    await this.auditRepo.log({
      document_request_id: pendingDoc.id,
      signer_id: null,
      action: 'document_sent',
      ip_address: 'email',
      user_agent: 'email-agent',
    });

    const signerList = signers.map(s => s.name || s.email || s.phone).join(', ');
    await this.trySendEmail({
      to: senderEmail,
      subject: 'Your document has been sent',
      text: `I've sent ${pendingDoc.file_name} to ${signerList} for signature. I'll notify you as soon as it's completed.\n\nView status: ${process.env.APP_URL}/status/${pendingDoc.id}`,
      inReplyTo,
    });
    logger.info({ documentId: pendingDoc.id }, 'Confirmation reply handled successfully');
  }

  private async handleCorrectionReply(senderEmail: string, body: string, inReplyTo: string): Promise<void> {
    await this.trySendEmail({
      to: senderEmail,
      subject: 'Re: Correction received',
      text: "Got it! I'm re-analyzing your document with the updated instructions. I'll get back to you shortly.",
      inReplyTo,
    });
  }

  private isConfirmationReply(body: string): boolean {
    // Gmail replies include quoted text — only check the first line
    const firstLine = body.trim().split(/\r?\n/)[0].trim().toLowerCase();
    return firstLine === 'y' || firstLine === 'yes' || firstLine === 'proceed';
  }

  private isCorrectionReply(body: string): boolean {
    const firstLine = body.trim().split(/\r?\n/)[0].trim().toLowerCase();
    return firstLine.startsWith('n') && firstLine.length > 1;
  }

  private extractEmail(fromText: string): string | null {
    const match = fromText.match(/[\w.-]+@[\w.-]+\.\w+/);
    return match ? match[0].toLowerCase() : null;
  }
}
