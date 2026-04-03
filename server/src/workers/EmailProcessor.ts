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
      this.markAllAsRead(() => {
        this.openInbox();
      });
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

  /**
   * Mark all existing UNSEEN emails as read on startup so we don't reprocess
   * old emails every time the server restarts.
   */
  private markAllAsRead(callback: () => void): void {
    this.imap.openBox('INBOX', false, (err) => {
      if (err) {
        logger.error({ error: err.message }, 'Failed to open inbox for marking read');
        callback();
        return;
      }
      this.imap.search(['UNSEEN'], (searchErr, results) => {
        if (searchErr || !results?.length) {
          if (searchErr) logger.error({ error: searchErr.message }, 'IMAP search error during mark-all-read');
          else logger.info('No unseen emails to mark as read on startup');
          callback();
          return;
        }
        logger.info(`Marking ${results.length} existing unseen emails as read to prevent reprocessing`);
        this.imap.setFlags(results, ['\\Seen'], (flagErr) => {
          if (flagErr) {
            logger.error({ error: flagErr.message }, 'Failed to mark emails as read');
          } else {
            logger.info(`Marked ${results.length} emails as read`);
          }
          callback();
        });
      });
    });
  }

  private openInbox(): void {
    // Inbox is already open from markAllAsRead — just set up listeners
    logger.info('Setting up IMAP listeners for new mail');

    this.imap.on('mail', () => {
      logger.info('IMAP mail event received');
      this.processUnseenMessages();
    });

    setInterval(() => {
      this.processUnseenMessages();
    }, 60000);
  }

  private processUnseenMessages(): void {
    this.imap.search(['UNSEEN'], (err, results) => {
      if (err) {
        logger.error({ error: err.message }, 'IMAP search error');
        return;
      }
      if (!results?.length) {
        logger.info('IMAP search returned no unseen messages');
        return;
      }

      logger.info(`IMAP search found ${results.length} unseen message(s): ${results.join(', ')}`);
      const newResults = results.filter(seq => !this.processedUids.has(seq));
      if (!newResults.length) {
        logger.info('All unseen messages already processed (in processedUids set)');
        return;
      }

      for (const seq of newResults) {
        this.processedUids.add(seq);
      }

      logger.info(`Found ${newResults.length} new emails to process`);
      const fetch = this.imap.fetch(newResults, { bodies: '', markSeen: true });

      // Collect all messages first, then process sequentially to prevent
      // duplicate Step 2 processing when multiple replies exist
      const buffers: string[] = [];
      fetch.on('message', (msg) => {
        let buffer = '';
        msg.on('body', (stream) => {
          stream.on('data', (chunk: Buffer) => { buffer += chunk.toString(); });
          stream.on('end', () => { buffers.push(buffer); });
        });
      });

      fetch.once('end', async () => {
        for (const buffer of buffers) {
          try {
            await this.handleEmail(buffer);
          } catch (handleErr) {
            const errMsg = handleErr instanceof Error ? handleErr.message : String(handleErr);
            logger.error(`Failed to process email: ${errMsg}`);
          }
        }
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
    const rawMessageId = parsed.messageId || '';
    const fromEmail = (process.env.FROM_EMAIL || '').replace(/@@/g, '@').toLowerCase();
    // Method 1: Resend-sent emails have Message-IDs containing 'resend.com'
    if (rawMessageId.includes('resend.com')) {
      logger.info(`Skipping service-sent email (Resend Message-ID): from=${senderEmail} msgId=${rawMessageId}`);
      return;
    }
    // Method 2: Skip any email FROM our own FROM_EMAIL that looks like a service reply
    // (contains service-generated content like "Welcome to Lapen" or "Document Sent")
    if (fromEmail && senderLower === fromEmail) {
      const bodyText = (parsed.text || '').trim();
      const subjectText = parsed.subject || '';
      const isServiceReply = bodyText.includes('Welcome to Lapen!') ||
        bodyText.includes("I've analyzed your document") ||
        bodyText.includes("I've sent") ||
        bodyText.includes('Track Signing Status') ||
        bodyText.includes('Lapen E-Signature Service') ||
        subjectText.includes('Document sent for signature');
      if (isServiceReply) {
        logger.info(`Skipping service-generated email: from=${senderEmail} subject="${subjectText}"`);
        return;
      }
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
    // STEP 2 REPLY: Sender is replying with signee contacts
    // (email addresses, phone numbers, or WhatsApp numbers)
    // ---------------------------------------------------------------
    const hasSigneeEmails = this.extractEmailAddresses(body, senderEmail);
    const hasPhoneNumbers = /\+[\d\s()-]{7,20}/.test(this.stripQuotedReply(body));
    const db = getDatabase();

    if (hasSigneeEmails.length > 0 || hasPhoneNumbers) {
      // This looks like a reply with signee contacts — check for a pending document
      const user = await this.userRepo.findByEmail(senderEmail);
      if (user) {
        const pendingDoc = await db('document_requests')
          .where({ sender_id: user.id })
          .whereIn('status', ['pending_confirmation', 'insufficient_credits'])
          .orderBy('created_at', 'desc')
          .first();

        if (pendingDoc) {
          const signeesWithNames = this.extractSigneesWithNames(body, senderEmail);
          if (signeesWithNames.length > 0) {
            logger.info({ documentId: pendingDoc.id, signeeCount: signeesWithNames.length, signees: signeesWithNames, docStatus: pendingDoc.status, hasAttachments: attachments.length }, 'Detected step 2 reply with signee contacts');
            await this.handleSigneeReply(senderEmail, user, pendingDoc, signeesWithNames, body, messageId);
            return;
          }
        } else {
          logger.warn({ userId: user.id, signees: hasSigneeEmails }, 'Found signee contacts but no pending/insufficient_credits document — checking for recent docs');
          const recentDoc = await db('document_requests')
            .where({ sender_id: user.id })
            .orderBy('created_at', 'desc')
            .first();
          if (recentDoc) {
            logger.warn({ documentId: recentDoc.id, status: recentDoc.status, fileName: recentDoc.file_name }, 'Most recent document for this user');
          }
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
    // ---------------------------------------------------------------
    const pdfAttachment = attachments.find((a) => {
      const type = (a.contentType || '').toLowerCase();
      const name = (a.filename || '').toLowerCase();
      return type === 'application/pdf' || type === 'application/x-pdf' ||
             type === 'application/octet-stream' || type.includes('pdf') ||
             name.endsWith('.pdf');
    });

    // If there's an attachment but it's not a PDF, tell the user
    if (!pdfAttachment && attachments.length > 0) {
      const attachNames = attachments.map(a => a.filename || 'unnamed').join(', ');
      await this.trySendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: `Thanks for your email! Lapen currently only processes PDF documents. It looks like you sent: ${attachNames}\n\nPlease convert your document to PDF and resend it. Most applications (Word, Google Docs, etc.) have a "Save as PDF" or "Export to PDF" option.\n\nLapen - AI-powered e-signatures`,
        inReplyTo: messageId,
      });
      return;
    }

    const selectedAttachment = pdfAttachment || null;

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

    // ---------------------------------------------------------------
    // SIGNEE SCAN REPLY: Check if this is a signee replying with a
    // printed-and-signed scan BEFORE treating as a new document.
    // Only matches if:
    //   - Sender has a signer record on a document in 'sent' status
    //   - Sender is NOT a registered user (pure signee, not a sender)
    // This prevents senders submitting new PDFs from being misidentified.
    // ---------------------------------------------------------------
    const existingUser = await this.userRepo.findByEmail(senderEmail);
    if (!existingUser) {
      // Not a registered sender — check if they're a signee
      const signer = await db('signers')
        .where({ email: senderLower })
        .whereIn('status', ['pending', 'notified', 'viewed'])
        .first();

      if (signer) {
        // Verify the document is in a state that expects signatures
        const signerDoc = await db('document_requests').where({ id: signer.document_request_id }).first();
        if (signerDoc && signerDoc.status === 'sent') {
          logger.info({ signerId: signer.id, signerEmail: senderLower, docId: signer.document_request_id }, 'Signee replied with signed scan');
          await this.handleSignedScanReply(signer, attachments, senderLower, messageId);
          return;
        }
      }
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
    const content = attachment.content;
    const size = attachment.size;

    logger.info(`Step 1: New document from ${senderEmail}: ${fileName} (${size}b)`);

    // Create user
    const user = await this.userRepo.findOrCreateByEmail(senderEmail);

    // Extract text from PDF (independent of S3)
    let documentText = '';
    let pageCount = 1;
    try {
      const { extractPdfText } = await import('../services/pdfTextExtractor.js');
      const result = await extractPdfText(content);
      documentText = result.text;
      pageCount = result.pageCount;
    } catch (parseErr) {
      logger.warn(`PDF text extraction failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }

    // Upload to S3 and create document record
    let documentId: string;

    if (process.env.AWS_ACCESS_KEY_ID) {
      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();

        const s3Key = `documents/${user.id}/${crypto.randomUUID()}/${fileName}`;
        await storageService.uploadDocument(s3Key, content, 'application/pdf');
        logger.info(`S3 upload successful: key=${s3Key}`);

        const doc = await this.documentRepo.create({
          sender_id: user.id,
          status: 'pending_confirmation',
          file_name: fileName,
          file_size: size,
          page_count: pageCount,
          mime_type: 'application/pdf',
          document_hash: crypto.createHash('sha256').update(content).digest('hex'),
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
        documentId = await this.createBasicDocument(user.id, { content, filename: fileName, size }, messageId, subject);
      }
    } else {
      logger.warn('AWS_ACCESS_KEY_ID not set, skipping S3 upload');
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

    // Store AI summary and suggested cover text on the document for use in step 2
    await getDatabase()('document_requests').where({ id: documentId }).update({
      ai_summary: summary,
      suggested_cover_text: suggestedCoverText,
    });

    // Preview URL for the sender to see what signees will see
    const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
    const previewUrl = `${appUrl}/preview/${documentId}`;

    // Send the welcome/instructions email
    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #2563eb; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Lapen</h1>
  </div>

  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="margin: 0 0 12px;">Hi ${user.name || senderEmail.split('@')[0]},</p>

    <p style="margin: 0 0 12px;">Got your document <strong>${fileName}</strong>:</p>

    <div style="background: #f9fafb; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 0 0 16px; border-radius: 0 4px 4px 0;">
      <p style="margin: 0; font-size: 14px; color: #374151;">${summary}</p>
    </div>

    <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
      <strong>Reply to this email</strong> with each signer's name and contact — one per line:
    </p>
    <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; margin: 0 0 16px; font-family: monospace; font-size: 13px; color: #374151; line-height: 1.8;">
      John Smith john@example.com<br>
      Jane Doe +14155551234 whatsapp<br>
      Bob Wilson +442071234567 sms
    </div>

    <div style="text-align: center; margin: 20px 0 0;">
      <a href="${previewUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Preview Document</a>
    </div>
  </div>

  <div style="padding: 16px 24px; font-size: 12px; color: #9ca3af; text-align: center;">
    Lapen • Secure E-Signatures
  </div>
</div>`;

    await this.trySendEmail({
      to: senderEmail,
      subject: `Re: ${subject || fileName}`,
      text: `Hi ${user.name || senderEmail.split('@')[0]},

Got your document "${fileName}":

${summary}

Reply to this email with each signer's name and contact — one per line:

John Smith john@example.com
Jane Doe +14155551234 whatsapp
Bob Wilson +442071234567 sms

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
    signees: Array<{ email: string | null; phone: string | null; name: string | null; channel: 'email' | 'sms' | 'whatsapp' }>,
    body: string,
    messageId: string,
  ): Promise<void> {
    const db = getDatabase();
    const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
    const signeeEmails = signees.filter(s => s.email).map(s => s.email!);
    const signeeCount = signees.length;

    // Extract custom cover text from the reply, or fall back to AI-generated cover text from step 1
    let coverText = this.extractCoverText(body, signeeEmails);
    if (!coverText && pendingDoc.suggested_cover_text) {
      coverText = pendingDoc.suggested_cover_text;
      logger.info({ docId: pendingDoc.id }, 'Using stored AI-generated cover text (user did not provide custom text)');
    }
    // Final fallback — generate a sensible default
    if (!coverText) {
      const senderDisplayName = user.name || senderEmail.split('@')[0];
      coverText = `Please review and sign the attached document "${pendingDoc.file_name}".\n\nThank you,\n${senderDisplayName}`;
    }

    logger.info({ userId: user.id, credits: user.credits, required: signeeCount, docId: pendingDoc.id, docStatus: pendingDoc.status, hasCoverText: !!coverText }, 'handleSigneeReply — starting credit check');

    // If user appears to have insufficient credits, try recovering from Stripe first
    if (user.credits < signeeCount && process.env.STRIPE_SECRET_KEY) {
      try {
        const recovered = await this.recoverUnprocessedPayments(user.id, user.email);
        if (recovered) {
          // Re-fetch user with updated credits
          const updatedUser = await this.userRepo.findById(user.id);
          if (updatedUser) {
            user = { id: updatedUser.id, name: updatedUser.name, email: updatedUser.email, credits: updatedUser.credits };
            logger.info({ userId: user.id, newCredits: user.credits }, 'Recovered credits from Stripe payments');
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to recover Stripe payments — continuing with current credits');
      }
    }

    // Check credits — mark document so we don't spam the user on every email
    if (user.credits < signeeCount) {
      // Only send the notification once: skip if already notified
      if (pendingDoc.status !== 'insufficient_credits') {
        await db('document_requests').where({ id: pendingDoc.id }).update({
          status: 'insufficient_credits',
        });
        const purchaseUrl = `${appUrl}/credits?user=${user.id}`;
        // Ensure user has a referral code
        const freshUser = await this.userRepo.findById(user.id);
        await this.emailService.sendInsufficientCreditsEmail(
          senderEmail,
          signeeCount,
          user.credits,
          purchaseUrl,
          messageId,
          freshUser?.referral_code || undefined,
        );
        logger.info({ documentId: pendingDoc.id, required: signeeCount, available: user.credits }, 'Insufficient credits — notified sender');
      } else {
        logger.info({ documentId: pendingDoc.id }, 'Insufficient credits — already notified, skipping duplicate email');
      }
      return;
    }

    // If retrying after buying credits, reset status before proceeding
    if (pendingDoc.status === 'insufficient_credits') {
      await db('document_requests').where({ id: pendingDoc.id }).update({
        status: 'pending_confirmation',
      });
    }

    // Guard: check if signers already exist for this document (prevents duplicate sends on reprocessing)
    const existingSigners = await db('signers').where({ document_request_id: pendingDoc.id }).select('email');
    if (existingSigners.length > 0) {
      logger.info({ docId: pendingDoc.id, existingSignerCount: existingSigners.length }, 'Signers already exist — skipping duplicate processing');
      return;
    }

    // Deduct credits
    await this.userRepo.deductCredits(user.id, signeeCount, pendingDoc.id);

    // Update document status FIRST to prevent duplicate processing on restart
    await db('document_requests').where({ id: pendingDoc.id }).update({
      status: 'sent',
      credits_required: signeeCount,
    });

    // Create signers and send notifications
    const sentContacts: string[] = [];
    const failedContacts: string[] = [];
    const senderDisplayName = user.name || senderEmail.split('@')[0];

    // Fetch the PDF from S3 to attach to email notifications
    let pdfBuffer: Buffer | null = null;
    if (pendingDoc.s3_key && process.env.AWS_ACCESS_KEY_ID) {
      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();
        pdfBuffer = await storageService.getDocument(pendingDoc.s3_key);
        logger.info({ docId: pendingDoc.id, size: pdfBuffer.length }, 'Fetched PDF from S3 for attachment');
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch PDF from S3 — sending without attachment');
      }
    }

    // Import MessagingService for SMS/WhatsApp
    const { MessagingService } = await import('../services/MessagingService.js');
    const messagingService = new MessagingService();

    for (let i = 0; i < signees.length; i++) {
      const { email, phone, name: signeeName, channel } = signees[i];
      const contactLabel = email || phone || 'unknown';
      const signingToken = crypto.randomBytes(32).toString('base64url');

      await this.documentRepo.createSigner({
        document_request_id: pendingDoc.id,
        email: email || null,
        phone: phone || null,
        name: signeeName,
        status: 'pending',
        delivery_channel: channel,
        signing_order: i + 1,
        signing_token: signingToken,
        custom_message: coverText || null,
      });

      const signingUrl = `${appUrl}/sign/${signingToken}`;

      try {
        if (channel === 'email' && email) {
          await this.emailService.sendSigningNotification(
            email,
            signeeName || undefined,
            senderDisplayName,
            senderEmail,
            pendingDoc.file_name,
            signingUrl,
            coverText || undefined,
            'email',
            pdfBuffer ? { content: pdfBuffer, filename: pendingDoc.file_name } : undefined,
          );
        } else if ((channel === 'sms' || channel === 'whatsapp') && phone) {
          await messagingService.sendSigningNotification(
            channel,
            phone,
            senderDisplayName,
            pendingDoc.file_name,
            signingUrl,
          );
        }

        // Update signer status to notified
        const signerQuery = email
          ? db('signers').where({ document_request_id: pendingDoc.id, email })
          : db('signers').where({ document_request_id: pendingDoc.id, phone });
        const signer = await signerQuery.first();
        if (signer) {
          await this.documentRepo.updateSignerStatus(signer.id, 'notified', { notified_at: new Date() } as any);
        }

        const displayLabel = signeeName ? `${signeeName} (${contactLabel})` : contactLabel;
        logger.info({ contact: contactLabel, channel }, 'Signing notification sent');
        sentContacts.push(displayLabel);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const displayLabel = signeeName ? `${signeeName} (${contactLabel})` : contactLabel;
        logger.error({ error: errMsg, contact: contactLabel, channel }, 'Failed to send signing notification');
        failedContacts.push(displayLabel);
      }
    }

    // Audit log
    await this.auditRepo.log({
      document_request_id: pendingDoc.id,
      signer_id: null,
      action: 'document_sent',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { signees: signees.map(s => ({ contact: s.email || s.phone, channel: s.channel, name: s.name })) },
    });

    // Send confirmation to sender
    const statusUrl = `${appUrl}/status/${pendingDoc.id}`;
    const sentList = sentContacts.map(c => `  • ${c}`).join('\n');
    const failedList = failedContacts.map(c => `  • ${c} (delivery failed)`).join('\n');
    const failedNote = failedContacts.length > 0
      ? `\n\nNote: ${failedContacts.length} notification(s) failed to deliver. The signing links have been created — you can share them manually from the status page.`
      : '';

    const recipientListHtml = sentContacts.map(c =>
      `<li style="margin: 4px 0;">${c}</li>`
    ).join('');
    const failedListHtml = failedContacts.map(c =>
      `<li style="margin: 4px 0;">${c} <span style="color: #dc2626; font-size: 13px;">(delivery failed)</span></li>`
    ).join('');

    const failedNoteHtml = failedContacts.length > 0
      ? `<p style="color: #dc2626; font-size: 14px; margin-top: 12px;">⚠ ${failedContacts.length} notification(s) failed to deliver. The signing links have been created — you can share them manually from the status page.</p>`
      : '';

    await this.trySendEmail({
      to: senderEmail,
      subject: `✓ Document sent for signature: ${pendingDoc.file_name}`,
      text: `Done! I've sent "${pendingDoc.file_name}" for signature to:\n\n${sentList}${failedList ? '\n' + failedList : ''}\n\nI'll notify you as each person signs.${failedNote}\n\nTrack status: ${statusUrl}`,
      html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #16a34a; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px;">✓ Document Sent</h1>
  </div>
  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p>I've sent <strong>${pendingDoc.file_name}</strong> for signature to:</p>
    <ul style="margin: 12px 0; padding-left: 20px;">
      ${recipientListHtml}${failedListHtml}
    </ul>
    <p>I'll notify you as each person signs.</p>
    ${failedNoteHtml}
    <div style="text-align: center; margin: 20px 0 0;">
      <a href="${statusUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">Track Signing Status</a>
    </div>
  </div>
</div>`,
      inReplyTo: messageId,
    });

    logger.info({ documentId: pendingDoc.id, sent: sentContacts.length, failed: failedContacts.length }, 'Step 2 complete: signing notifications sent, sender notified');
  }

  // =========================================================================
  // SIGNEE SCAN: Handle a signee replying with a printed & signed document
  // =========================================================================
  private async handleSignedScanReply(
    signer: any,
    attachments: any[],
    signerEmail: string,
    messageId: string,
  ): Promise<void> {
    const db = getDatabase();

    // Find the relevant attachment (prefer PDF, then images)
    const signedAttachment = attachments.find(a => {
      const type = (a.contentType || '').toLowerCase();
      const name = (a.filename || '').toLowerCase();
      return type.includes('pdf') || name.endsWith('.pdf');
    }) || attachments.find(a => {
      const type = (a.contentType || '').toLowerCase();
      return type.includes('image');
    });

    if (!signedAttachment) return;

    // Upload the signed scan to S3
    let signedScanKey: string | null = null;
    if (process.env.AWS_ACCESS_KEY_ID) {
      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();
        const ext = (signedAttachment.filename || 'scan.pdf').split('.').pop() || 'pdf';
        signedScanKey = `signed-scans/${signer.document_request_id}/${signer.id}/signed-scan.${ext}`;
        await storageService.uploadDocument(signedScanKey, signedAttachment.content, signedAttachment.contentType || 'application/pdf');
        logger.info({ signerId: signer.id, key: signedScanKey }, 'Uploaded signed scan to S3');
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to upload signed scan to S3');
      }
    }

    // Mark signer as signed
    await this.documentRepo.updateSignerStatus(signer.id, 'signed', {
      signed_at: new Date(),
    } as any);

    // Store the scan reference in metadata
    if (signedScanKey) {
      await db('signers').where({ id: signer.id }).update({
        custom_message: `Signed via print-and-scan. Scan stored at: ${signedScanKey}`,
      });
    }

    // Audit log
    await this.auditRepo.log({
      document_request_id: signer.document_request_id,
      signer_id: signer.id,
      action: 'document_signed',
      ip_address: 'email',
      user_agent: 'email-scan-reply',
      metadata: { method: 'print-and-scan', scanKey: signedScanKey, originalFilename: signedAttachment.filename },
    });

    // Send confirmation to the signee
    await this.trySendEmail({
      to: signerEmail,
      subject: 'Your signed document has been received',
      text: `Thank you! We've received your signed document. The sender will be notified.\n\nPowered by Lapen - AI-powered e-signatures`,
      html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #16a34a; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px;">Signed Document Received</h1>
  </div>
  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p>Thank you! We've received your signed document and the sender has been notified.</p>
    <p style="color: #6b7280; font-size: 13px;">Powered by Lapen - AI-powered e-signatures</p>
  </div>
</div>`,
      inReplyTo: messageId,
    });

    // Check if all signers have now signed — if so, trigger completion
    const doc = await db('document_requests').where({ id: signer.document_request_id }).first();
    if (doc) {
      const allSigners = await db('signers').where({ document_request_id: doc.id });
      const allSigned = allSigners.every(s => s.status === 'signed');

      if (allSigned) {
        logger.info({ docId: doc.id }, 'All signers have signed (including scan) — marking as completed');
        await db('document_requests').where({ id: doc.id }).update({
          status: 'completed',
          completed_at: new Date(),
        });

        // Notify the sender
        const sender = await db('users').where({ id: doc.sender_id }).first();
        if (sender) {
          // For scan-based signing, attach the scans to completion email
          const scanAttachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
          for (const s of allSigners) {
            if (s.custom_message?.includes('signed-scans/')) {
              const scanKeyMatch = s.custom_message.match(/Scan stored at: (.+)/);
              if (scanKeyMatch && process.env.AWS_ACCESS_KEY_ID) {
                try {
                  const { StorageService } = await import('../services/StorageService.js');
                  const storageService = new StorageService();
                  const scanBuffer = await storageService.getDocument(scanKeyMatch[1]);
                  const ext = scanKeyMatch[1].split('.').pop() || 'pdf';
                  scanAttachments.push({
                    filename: `signed-by-${s.name || s.email || 'signer'}.${ext}`,
                    content: scanBuffer,
                    contentType: ext === 'pdf' ? 'application/pdf' : `image/${ext}`,
                  });
                } catch (err) {
                  logger.warn({ err }, 'Failed to fetch signed scan for completion email');
                }
              }
            }
          }

          if (scanAttachments.length > 0) {
            await this.emailService.sendCompletionNotification(
              sender.email,
              doc.file_name,
              '',
              scanAttachments,
            );
          }
        }
      } else {
        // Notify sender that this signer has completed
        const sender = await db('users').where({ id: doc.sender_id }).first();
        if (sender) {
          const signedCount = allSigners.filter(s => s.status === 'signed').length;
          await this.trySendEmail({
            to: sender.email,
            subject: `${signer.name || signerEmail} signed ${doc.file_name}`,
            text: `${signer.name || signerEmail} has signed "${doc.file_name}" (via print & scan).\n\n${signedCount}/${allSigners.length} signatures complete.`,
          });
        }
      }
    }

    logger.info({ signerId: signer.id, signerEmail }, 'Signed scan processed successfully');
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
  /**
   * Extract email addresses from body, returning both the email and any associated name.
   * Supports formats: "email@example.com", "Name <email@example.com>", "Name email@example.com"
   */
  private extractEmailAddresses(body: string, senderEmail: string): string[] {
    // Strip quoted reply text to avoid picking up example emails from our instructions
    const strippedBody = this.stripQuotedReply(body);

    // Match emails with at least 2 chars before @ to avoid fragments like i@gmail.com
    const emailRegex = /\b[\w.-]{2,}@[\w.-]+\.\w{2,}\b/g;
    const matches = strippedBody.match(emailRegex) || [];

    const filtered = [...new Set(
      matches
        .map(e => e.toLowerCase())
        .filter(e => {
          if (e === senderEmail.toLowerCase()) return false;
          if (e.includes('noreply') || e.includes('no-reply')) return false;
          if (e.includes('resend.dev')) return false;
          if (e.endsWith('@example.com') || e.endsWith('@example.org') || e.endsWith('@example.net')) return false;
          const serviceEmail = (process.env.IMAP_USER || '').replace(/@@/g, '@').toLowerCase();
          if (serviceEmail && e === serviceEmail) return false;
          if (e.includes('unsubscribe')) return false;
          return true;
        }),
    )];

    return filtered;
  }

  /**
   * Extract name + contact pairs from the body. Supports:
   * - "Name <email@example.com>"         → email
   * - "Name email@example.com"           → email
   * - "Name +1234567890"                 → sms (default for phone)
   * - "Name +1234567890 whatsapp"        → whatsapp
   * - "Name +1234567890 sms"             → sms
   * - Just "email@example.com"           → email (name derived from prefix)
   */
  private extractSigneesWithNames(body: string, senderEmail: string): Array<{ email: string | null; phone: string | null; name: string | null; channel: 'email' | 'sms' | 'whatsapp' }> {
    const strippedBody = this.stripQuotedReply(body);
    const lines = strippedBody.split(/\r?\n/);
    const result: Array<{ email: string | null; phone: string | null; name: string | null; channel: 'email' | 'sms' | 'whatsapp' }> = [];
    const seenContacts = new Set<string>();

    const serviceEmail = (process.env.IMAP_USER || '').replace(/@@/g, '@').toLowerCase();
    const fromEmail = (process.env.FROM_EMAIL || '').replace(/@@/g, '@').toLowerCase();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 3) continue;

      // Try phone number pattern: "Name +1234567890 [whatsapp|sms]"
      const phoneMatch = trimmed.match(/^(.+?)\s+(\+[\d\s()-]{7,20})\s*(whatsapp|sms)?\s*$/i);
      if (phoneMatch) {
        const name = phoneMatch[1].trim();
        const phone = phoneMatch[2].replace(/[\s()-]/g, '');
        const channel = (phoneMatch[3] || 'whatsapp').toLowerCase() as 'sms' | 'whatsapp';
        if (phone.length >= 8 && !seenContacts.has(phone)) {
          seenContacts.add(phone);
          result.push({ email: null, phone, name, channel });
        }
        continue;
      }

      // Try standalone phone: "+1234567890 [whatsapp|sms]" (no name)
      const phoneOnlyMatch = trimmed.match(/^(\+[\d\s()-]{7,20})\s*(whatsapp|sms)?\s*$/i);
      if (phoneOnlyMatch) {
        const phone = phoneOnlyMatch[1].replace(/[\s()-]/g, '');
        const channel = (phoneOnlyMatch[2] || 'whatsapp').toLowerCase() as 'sms' | 'whatsapp';
        if (phone.length >= 8 && !seenContacts.has(phone)) {
          seenContacts.add(phone);
          result.push({ email: null, phone, name: null, channel });
        }
        continue;
      }

      // Try "Name <email>" pattern
      const bracketMatch = trimmed.match(/^(.+?)\s*<([\w.+-]+@[\w.-]+\.\w+)>\s*$/i);
      if (bracketMatch) {
        const name = bracketMatch[1].trim();
        const email = bracketMatch[2].toLowerCase();
        if (this.isValidSigneeEmail(email, senderEmail, serviceEmail, fromEmail) && !seenContacts.has(email)) {
          seenContacts.add(email);
          result.push({ email, phone: null, name: name.length > 1 ? name : null, channel: 'email' });
        }
        continue;
      }

      // Try "Name email" on a line
      const nameEmailMatch = trimmed.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\s+([\w.+-]+@[\w.-]+\.\w+)\s*$/i);
      if (nameEmailMatch) {
        const name = nameEmailMatch[1].trim();
        const email = nameEmailMatch[2].toLowerCase();
        if (this.isValidSigneeEmail(email, senderEmail, serviceEmail, fromEmail) && !seenContacts.has(email)) {
          seenContacts.add(email);
          result.push({ email, phone: null, name, channel: 'email' });
        }
        continue;
      }

      // Try standalone email
      const emailMatch = trimmed.match(/([\w.+-]+@[\w.-]+\.\w+)/);
      if (emailMatch) {
        const email = emailMatch[1].toLowerCase();
        if (this.isValidSigneeEmail(email, senderEmail, serviceEmail, fromEmail) && !seenContacts.has(email)) {
          seenContacts.add(email);
          // Derive name from email prefix
          const prefix = email.split('@')[0];
          const name = prefix.replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          result.push({ email, phone: null, name, channel: 'email' });
        }
      }
    }

    return result;
  }

  /** Check if an email is a valid signee (not the sender, service, or spam) */
  private isValidSigneeEmail(email: string, senderEmail: string, serviceEmail: string, fromEmail: string): boolean {
    const e = email.toLowerCase();
    if (e === senderEmail.toLowerCase()) return false;
    if (serviceEmail && e === serviceEmail) return false;
    if (fromEmail && e === fromEmail) return false;
    if (e.includes('noreply') || e.includes('no-reply') || e.includes('unsubscribe')) return false;
    if (e.includes('resend.dev')) return false;
    if (e.endsWith('@example.com') || e.endsWith('@example.org') || e.endsWith('@example.net')) return false;
    return true;
  }

  /**
   * Strip quoted reply text from email body.
   * Removes lines starting with > and content below "On ... wrote:" or "---" markers.
   */
  private stripQuotedReply(body: string): string {
    const lines = body.split(/\r?\n/);
    const result: string[] = [];

    for (const line of lines) {
      // Stop at "On ... wrote:" reply marker
      if (/^On .+ wrote:$/i.test(line.trim())) break;
      // Stop at "---" or "___" separator lines
      if (/^[-_]{3,}\s*$/.test(line.trim())) break;
      // Stop at forwarded message markers
      if (/^-+\s*Original Message\s*-+$/i.test(line.trim())) break;
      // Skip quoted lines (starting with >)
      if (line.trim().startsWith('>')) continue;
      result.push(line);
    }

    return result.join('\n');
  }

  /**
   * Extract custom cover text from the reply body.
   * Looks for text after "cover text:" or similar markers.
   * Falls back to extracting non-email text content.
   */
  /**
   * Check Stripe for completed checkout sessions whose credits haven't been applied yet.
   * Returns true if any credits were recovered.
   */
  private async recoverUnprocessedPayments(userId: string, userEmail: string): Promise<boolean> {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const db = getDatabase();

    // List recent completed checkout sessions and filter by userId in metadata
    const sessions = await stripe.checkout.sessions.list({
      status: 'complete',
      limit: 20,
    });

    let recovered = false;
    for (const session of sessions.data) {
      if (session.payment_status !== 'paid') continue;
      if (session.metadata?.userId !== userId) continue;
      const credits = Number(session.metadata?.credits);
      if (!credits) continue;

      const paymentIntentId = session.payment_intent as string;
      if (!paymentIntentId) continue;

      // Check if already credited
      const existing = await db('credit_transactions')
        .where({ stripe_payment_intent_id: paymentIntentId })
        .first();
      if (existing) continue;

      // Apply the credits
      await this.userRepo.addCredits(userId, credits, paymentIntentId);
      logger.info({ userId, credits, paymentIntentId }, 'Recovered uncredited Stripe payment');
      recovered = true;
    }

    return recovered;
  }

  private extractCoverText(body: string, signeeEmails: string[]): string {
    // Look for explicit "cover text:" marker — this is the only way to override
    const coverMatch = body.match(/cover\s*text\s*[:：]\s*([\s\S]*?)(?=\n\n|$)/i);
    if (coverMatch && coverMatch[1].trim().length > 10) {
      return coverMatch[1].trim();
    }

    // Don't try to infer cover text from remaining body — it's usually just
    // email signatures, names, URLs, etc. Return empty and let the caller
    // fall back to the AI-generated cover text stored on the document.
    return '';
  }

  private extractEmail(fromText: string): string | null {
    const match = fromText.match(/[\w.-]+@[\w.-]+\.\w+/);
    return match ? match[0].toLowerCase() : null;
  }
}
