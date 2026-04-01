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
  private processedUids = new Set<number>();
  private processedMessageIds = new Set<string>();

  constructor() {
    const db = getDatabase();
    this.userRepo = new UserRepository(db);
    this.documentRepo = new DocumentRepository(db);
    this.auditRepo = new AuditRepository(db);
    this.emailService = new EmailService();

    this.imap = new Imap({
      user: (process.env.IMAP_USER || '').replace(/@@/g, '@'),
      password: (process.env.IMAP_PASSWORD || process.env.IMAP_PASS || '').replace(/@@/g, '@'),
      host: process.env.IMAP_HOST!,
      port: Number(process.env.IMAP_PORT) || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });
  }

  async start(): Promise<void> {
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
        logger.info('IMAP mail event received');
        this.processUnseenMessages();
      });

      setInterval(() => {
        this.processUnseenMessages();
      }, 60000);
    });
  }

  private processUnseenMessages(): void {
    const since = new Date();
    since.setHours(since.getHours() - 2);
    this.imap.search([['SINCE', since]], (err, results) => {
      if (err) {
        logger.error({ error: err.message }, 'IMAP search error');
        return;
      }
      if (!results?.length) return;

      const newResults = results.filter(seq => !this.processedUids.has(seq));
      if (!newResults.length) return;

      for (const seq of newResults) {
        this.processedUids.add(seq);
      }

      logger.info(`Found ${newResults.length} new emails to process`);
      const fetch = this.imap.fetch(newResults, { bodies: '', markSeen: true });

      fetch.on('message', (msg) => {
        let buffer = '';
        msg.on('body', (stream) => {
          stream.on('data', (chunk: Buffer) => { buffer += chunk.toString(); });
          stream.on('end', () => {
            this.handleEmail(buffer).catch((handleErr) => {
              const errMsg = handleErr instanceof Error ? handleErr.message : String(handleErr);
              logger.error(`Failed to process email: ${errMsg}`);
            });
          });
        });
      });

      if (this.processedUids.size > 1000) {
        const arr = [...this.processedUids];
        this.processedUids = new Set(arr.slice(-500));
      }
    });
  }

  private async trySendEmail(options: { to: string; subject: string; text: string; html?: string; inReplyTo?: string }): Promise<void> {
    try {
      await this.emailService.sendEmail(options);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errMsg, to: options.to }, 'Failed to send email (non-fatal)');
    }
  }

  private async handleEmail(rawEmail: string): Promise<void> {
    const parsed = await simpleParser(rawEmail);

    const messageId = parsed.messageId || '';
    if (messageId && this.processedMessageIds.has(messageId)) {
      logger.info(`Skipping already-processed email messageId=${messageId}`);
      return;
    }
    if (messageId) {
      this.processedMessageIds.add(messageId);
      if (this.processedMessageIds.size > 2000) {
        const arr = [...this.processedMessageIds];
        this.processedMessageIds = new Set(arr.slice(-1000));
      }
    }

    const senderEmail = this.extractEmail(parsed.from?.text || '');
    if (!senderEmail) {
      logger.warn('Could not extract sender email');
      return;
    }

    const imapUser = (process.env.IMAP_USER || '').replace(/@@/g, '@').toLowerCase();
    const toAddresses = (parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [])
      .flatMap(addr => 'value' in addr ? addr.value : [addr])
      .map(a => (a.address || '').toLowerCase());

    if (imapUser && !toAddresses.includes(imapUser)) {
      logger.info(`Skipping email not addressed to us: from=${senderEmail} to=${toAddresses.join(',')}`);
      return;
    }

    const senderLower = senderEmail.toLowerCase();

    // Skip emails sent BY the service itself (prevent reply loops).
    // Resend-sent emails have Message-IDs containing 'resend.com'.
    const rawMessageId = parsed.messageId || '';
    if (rawMessageId.includes('resend.com')) {
      logger.info(`Skipping service-sent email (Resend Message-ID): from=${senderEmail} msgId=${rawMessageId}`);
      return;
    }

    if (senderLower.includes('noreply') || senderLower.includes('no-reply') ||
        senderLower.includes('notification') || senderLower.includes('mailer-daemon') ||
        senderLower.includes('postmaster')) {
      logger.info(`Skipping automated email from=${senderEmail}`);
      return;
    }

    const body = (parsed.text || '').trim();
    const subject = parsed.subject || '';
    const attachments = parsed.attachments || [];

    const firstLine = body.split(/\r?\n/)[0].trim();
    logger.info(`Processing incoming email: from=${senderEmail} subject="${subject}" bodyLen=${body.length} attachments=${attachments.length} firstLine="${firstLine}"`);

    // ---------------------------------------------------------------
    // STEP 2 REPLY: Sender is replying with signee email addresses
    // (they already sent the PDF in step 1 and got the welcome response)
    // ---------------------------------------------------------------
    const hasSigneeEmails = this.extractEmailAddresses(body, senderEmail);
    const db = getDatabase();

    if (hasSigneeEmails.length > 0 && attachments.length === 0) {
      // This looks like a reply with signee addresses
      const user = await this.userRepo.findByEmail(senderEmail);
      if (user) {
        const pendingDoc = await db('document_requests')
          .where({ sender_id: user.id, status: 'pending_confirmation' })
          .orderBy('created_at', 'desc')
          .first();

        if (pendingDoc) {
          logger.info({ documentId: pendingDoc.id, signeeCount: hasSigneeEmails.length }, 'Detected step 2 reply with signee emails');
          await this.handleSigneeReply(senderEmail, user, pendingDoc, hasSigneeEmails, body, messageId);
          return;
        }
      }
    }

    // Check if this email was already processed (persisted in DB)
    if (messageId) {
      const existingDoc = await db('document_requests')
        .where({ original_email_message_id: messageId })
        .first();
      if (existingDoc) {
        logger.info(`Skipping already-processed email (found in DB): messageId=${messageId} docId=${existingDoc.id}`);
        return;
      }
    }

    // ---------------------------------------------------------------
    // STEP 1: New email with PDF attachment
    // Upload PDF, generate AI summary + cover text, reply with instructions
    // ---------------------------------------------------------------
    const pdfAttachment = attachments.find((a) => {
      const type = (a.contentType || '').toLowerCase();
      const name = (a.filename || '').toLowerCase();
      return type === 'application/pdf' || type === 'application/x-pdf' ||
             type === 'application/octet-stream' || type.includes('pdf') ||
             name.endsWith('.pdf');
    });
    const selectedAttachment = pdfAttachment || (attachments.length === 1 ? attachments[0] : null);

    if (!selectedAttachment) {
      // No attachment — could be a general question or accidental email
      if (body.length > 0) {
        await this.trySendEmail({
          to: senderEmail,
          subject: `Re: ${subject}`,
          text: "Welcome to Lapen! To get started, send me an email with a PDF document attached that you'd like to get signed. I'll help you prepare and send it to your signees.",
          inReplyTo: messageId,
        });
      }
      return;
    }

    if (selectedAttachment.size > 25 * 1024 * 1024) {
      await this.trySendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: 'Your document is too large (max 25MB). Please compress it or split it into smaller files.',
        inReplyTo: messageId,
      });
      return;
    }

    await this.handleNewDocument(senderEmail, selectedAttachment, subject, messageId, body);
  }

  // =========================================================================
  // STEP 1: Handle new document — upload, summarize, reply with instructions
  // =========================================================================
  private async handleNewDocument(
    senderEmail: string,
    attachment: { content: Buffer; filename?: string; size: number; contentType?: string },
    subject: string,
    messageId: string,
    body: string,
  ): Promise<void> {
    const fileName = attachment.filename || 'document.pdf';
    logger.info(`Step 1: New document from ${senderEmail}: ${fileName} (${attachment.size}b)`);

    // Create user
    const user = await this.userRepo.findOrCreateByEmail(senderEmail);

    // Upload to S3 and create document record
    let documentId: string;
    let documentText = '';
    let pageCount = 1;

    if (process.env.AWS_ACCESS_KEY_ID) {
      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();
        const pdfParseModule: any = await import('pdf-parse');
        const pdfParse = pdfParseModule.default || pdfParseModule;

        // Extract text
        try {
          const pdfData = await pdfParse(attachment.content);
          documentText = pdfData.text || '';
          pageCount = pdfData.numpages || 1;
        } catch (parseErr) {
          logger.warn({ error: parseErr instanceof Error ? parseErr.message : String(parseErr) }, 'PDF text extraction failed');
        }

        // Upload to S3
        const s3Key = `documents/${user.id}/${crypto.randomUUID()}/${fileName}`;
        await storageService.uploadDocument(s3Key, attachment.content, 'application/pdf');

        const doc = await this.documentRepo.create({
          sender_id: user.id,
          status: 'pending_confirmation',
          file_name: fileName,
          file_size: attachment.size,
          page_count: pageCount,
          mime_type: 'application/pdf',
          document_hash: crypto.createHash('sha256').update(attachment.content).digest('hex'),
          s3_key: s3Key,
          is_sequential: false,
          credits_required: 1,
          original_email_message_id: messageId,
          subject,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        documentId = doc.id;
      } catch (err) {
        const errDetail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        logger.error(`S3 upload failed: ${errDetail}. Using basic record.`);
        documentId = await this.createBasicDocument(user.id, attachment, messageId, subject);
      }
    } else {
      documentId = await this.createBasicDocument(user.id, attachment, messageId, subject);
    }

    // Audit log
    await this.auditRepo.log({
      document_request_id: documentId,
      signer_id: null,
      action: 'document_created',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { senderEmail, subject },
    });

    // Generate AI summary and suggested cover text
    let summary = '';
    let suggestedCoverText = '';
    try {
      const { AIService } = await import('../services/AIService.js');
      const aiService = new AIService();
      const result = await aiService.summarizeDocumentForSender(documentText, fileName);
      summary = result.summary;
      suggestedCoverText = result.suggestedCoverText;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'AI summary generation failed');
      summary = `Document "${fileName}" (${pageCount} pages) has been uploaded.`;
      suggestedCoverText = `Hi,\n\nPlease review and sign the attached document "${fileName}".\n\nThank you`;
    }

    // Preview URL for the sender to see what signees will see
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const previewUrl = `${appUrl}/preview/${documentId}`;

    // Send the welcome/instructions email
    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #2563eb; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Lapen</h1>
    <p style="margin: 4px 0 0; opacity: 0.9; font-size: 14px;">E-Signature Service</p>
  </div>

  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="margin: 0 0 16px;">Hi ${user.name || senderEmail.split('@')[0]},</p>

    <p style="margin: 0 0 16px;">I've received your document <strong>${fileName}</strong>. Here's a quick summary:</p>

    <div style="background: #f9fafb; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 0 0 20px; border-radius: 0 4px 4px 0;">
      <p style="margin: 0; font-size: 14px; color: #374151;">${summary}</p>
    </div>

    <h3 style="margin: 0 0 8px; font-size: 16px;">What happens next?</h3>
    <ol style="margin: 0 0 20px; padding-left: 20px; color: #374151; font-size: 14px; line-height: 1.8;">
      <li><strong>Reply to this email</strong> with the email addresses of all people who need to sign</li>
      <li>I'll send each signee a link to review and sign the document</li>
      <li>Signees can place signatures, text, dates, and checkboxes anywhere on the document</li>
      <li>You'll get notified when each person signs</li>
      <li>Once everyone has signed, you'll receive the completed document</li>
    </ol>

    <h3 style="margin: 0 0 8px; font-size: 16px;">Suggested cover text for signees:</h3>
    <div style="background: #f9fafb; padding: 12px 16px; margin: 0 0 20px; border-radius: 4px; border: 1px solid #e5e7eb;">
      <p style="margin: 0; font-size: 14px; color: #374151; white-space: pre-line;">${suggestedCoverText}</p>
    </div>
    <p style="margin: 0 0 20px; font-size: 13px; color: #6b7280;">
      You can edit this text in your reply — I'll include it in the email to your signees.
    </p>

    <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 16px; border-radius: 8px; margin: 0 0 20px;">
      <p style="margin: 0; font-size: 14px; font-weight: 600; color: #1e40af;">📝 How to reply:</p>
      <p style="margin: 8px 0 0; font-size: 13px; color: #374151;">
        Simply reply to this email with:<br>
        • The signee email addresses (one per line, or comma-separated)<br>
        • Optionally edit the cover text above<br><br>
        <em>Example:</em><br>
        john@example.com<br>
        jane@example.com<br><br>
        Cover text: Please review and sign at your earliest convenience.
      </p>
    </div>

    <p style="margin: 0; font-size: 13px; color: #6b7280;">
      <a href="${previewUrl}" style="color: #2563eb;">Preview how signees will see this document →</a>
    </p>
  </div>

  <div style="padding: 16px 24px; font-size: 12px; color: #9ca3af; text-align: center;">
    Lapen E-Signature Service • Secure • Legally Binding
  </div>
</div>`;

    await this.trySendEmail({
      to: senderEmail,
      subject: `Re: ${subject || fileName}`,
      text: `Hi ${user.name || senderEmail.split('@')[0]},

I've received your document "${fileName}". Here's a quick summary:

${summary}

WHAT HAPPENS NEXT:
1. Reply to this email with the email addresses of all people who need to sign
2. I'll send each signee a link to review and sign the document
3. Signees can place signatures, text, dates, and checkboxes anywhere on the document
4. You'll get notified when each person signs

SUGGESTED COVER TEXT:
${suggestedCoverText}

You can edit this text in your reply — I'll include it in the email to your signees.

HOW TO REPLY:
Simply reply with the signee email addresses (one per line or comma-separated), and optionally edit the cover text.

Preview: ${previewUrl}`,
      html,
      inReplyTo: messageId,
    });

    logger.info({ documentId, senderEmail }, 'Step 1 complete: welcome email sent with AI summary');
  }

  // =========================================================================
  // STEP 2: Sender replies with signee emails — create signers, send links
  // =========================================================================
  private async handleSigneeReply(
    senderEmail: string,
    user: { id: string; name: string | null; email: string; credits: number },
    pendingDoc: any,
    signeeEmails: string[],
    body: string,
    messageId: string,
  ): Promise<void> {
    const db = getDatabase();
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    // Extract custom cover text from the reply (look for text after "cover text:" or just use the body minus email addresses)
    const coverText = this.extractCoverText(body, signeeEmails);

    // Check credits
    if (user.credits < signeeEmails.length) {
      const purchaseUrl = `${appUrl}/credits?user=${user.id}`;
      await this.trySendEmail({
        to: senderEmail,
        subject: 'Insufficient credits - Action needed',
        text: `This request requires ${signeeEmails.length} credit(s), but you have ${user.credits}.\n\nBuy more: ${purchaseUrl}\n\nOnce purchased, reply again with the signee emails.`,
        inReplyTo: messageId,
      });
      return;
    }

    // Deduct credits
    await this.userRepo.deductCredits(user.id, signeeEmails.length, pendingDoc.id);

    // Update document status
    await db('document_requests').where({ id: pendingDoc.id }).update({
      status: 'sent',
      credits_required: signeeEmails.length,
    });

    // Create signers and send notifications
    const sentEmails: string[] = [];
    const failedEmails: string[] = [];
    for (let i = 0; i < signeeEmails.length; i++) {
      const email = signeeEmails[i];
      const signingToken = crypto.randomBytes(32).toString('base64url');

      await this.documentRepo.createSigner({
        document_request_id: pendingDoc.id,
        email,
        phone: null,
        name: null,
        status: 'pending',
        delivery_channel: 'email',
        signing_order: i + 1,
        signing_token: signingToken,
        custom_message: coverText || null,
      });

      const signingUrl = `${appUrl}/sign/${signingToken}`;

      try {
        await this.emailService.sendSigningNotification(
          email,
          undefined,
          user.name || senderEmail.split('@')[0],
          pendingDoc.file_name,
          signingUrl,
          coverText || undefined,
        );

        // Update signer status to notified
        const signer = await db('signers')
          .where({ document_request_id: pendingDoc.id, email })
          .first();
        if (signer) {
          await this.documentRepo.updateSignerStatus(signer.id, 'notified', { notified_at: new Date() } as any);
        }

        logger.info({ signerEmail: email }, 'Signing notification sent');
        sentEmails.push(email);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ error: errMsg, signerEmail: email }, 'Failed to send signing notification');
        failedEmails.push(email);
      }
    }

    // Audit log
    await this.auditRepo.log({
      document_request_id: pendingDoc.id,
      signer_id: null,
      action: 'document_sent',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { signeeEmails },
    });

    // Send confirmation to sender
    const statusUrl = `${appUrl}/status/${pendingDoc.id}`;
    const allEmails = signeeEmails;
    const sentList = allEmails.map(e => `  • ${e}${failedEmails.includes(e) ? ' (delivery failed)' : ''}`).join('\n');
    const failedNote = failedEmails.length > 0
      ? `\n\nNote: ${failedEmails.length} email(s) failed to deliver. The signing links have been created — you can share them manually from the status page.`
      : '';

    const emailListHtml = allEmails.map(e => {
      const failed = failedEmails.includes(e);
      return `<li style="margin: 4px 0;">${e}${failed ? ' <span style="color: #dc2626; font-size: 13px;">(delivery failed)</span>' : ''}</li>`;
    }).join('');

    const failedNoteHtml = failedEmails.length > 0
      ? `<p style="color: #dc2626; font-size: 14px; margin-top: 12px;">⚠ ${failedEmails.length} email(s) failed to deliver. The signing links have been created — you can share them manually from the status page.</p>`
      : '';

    await this.trySendEmail({
      to: senderEmail,
      subject: `✓ Document sent for signature: ${pendingDoc.file_name}`,
      text: `Done! I've sent "${pendingDoc.file_name}" for signature to:\n\n${sentList}\n\nI'll notify you as each person signs.${failedNote}\n\nTrack status: ${statusUrl}`,
      html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #16a34a; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px;">✓ Document Sent</h1>
  </div>
  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p>I've sent <strong>${pendingDoc.file_name}</strong> for signature to:</p>
    <ul style="margin: 12px 0; padding-left: 20px;">
      ${emailListHtml}
    </ul>
    <p>I'll notify you as each person signs.</p>
    ${failedNoteHtml}
    <p><a href="${statusUrl}" style="color: #2563eb;">Track signing status →</a></p>
  </div>
</div>`,
      inReplyTo: messageId,
    });

    logger.info({ documentId: pendingDoc.id, sent: sentEmails.length, failed: failedEmails.length }, 'Step 2 complete: signing emails sent, sender notified');
  }

  // =========================================================================
  // Helpers
  // =========================================================================
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
      original_email_message_id: messageId,
      subject,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    return doc.id;
  }

  /**
   * Extract email addresses from body text, excluding the sender's own email
   * and common service/system addresses.
   */
  private extractEmailAddresses(body: string, senderEmail: string): string[] {
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
    const matches = body.match(emailRegex) || [];

    const filtered = [...new Set(
      matches
        .map(e => e.toLowerCase())
        .filter(e => {
          if (e === senderEmail.toLowerCase()) return false;
          // Filter out common non-person emails
          if (e.includes('noreply') || e.includes('no-reply')) return false;
          if (e.includes('resend.dev')) return false;
          // Filter out the service's own email address
          const serviceEmail = (process.env.IMAP_USER || '').replace(/@@/g, '@').toLowerCase();
          if (serviceEmail && e === serviceEmail) return false;
          if (e.includes('unsubscribe')) return false;
          return true;
        }),
    )];

    return filtered;
  }

  /**
   * Extract custom cover text from the reply body.
   * Looks for text after "cover text:" or similar markers.
   * Falls back to extracting non-email text content.
   */
  private extractCoverText(body: string, signeeEmails: string[]): string {
    // Look for explicit cover text marker
    const coverMatch = body.match(/cover\s*text\s*[:：]\s*([\s\S]*?)(?=\n\n|$)/i);
    if (coverMatch && coverMatch[1].trim().length > 10) {
      return coverMatch[1].trim();
    }

    // Remove email addresses and quoted text, see if meaningful text remains
    let cleaned = body;
    // Remove quoted text (lines starting with >)
    cleaned = cleaned.replace(/^>.*$/gm, '');
    // Remove email addresses
    for (const email of signeeEmails) {
      cleaned = cleaned.replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    }
    // Remove "On ... wrote:" lines
    cleaned = cleaned.replace(/on\s+.*\s+wrote\s*:/gi, '');
    // Remove blank lines and trim
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    // If there's substantial remaining text, use it as cover text
    if (cleaned.length > 20) {
      return cleaned;
    }

    return '';
  }

  private extractEmail(fromText: string): string | null {
    const match = fromText.match(/[\w.-]+@[\w.-]+\.\w+/);
    return match ? match[0].toLowerCase() : null;
  }
}
