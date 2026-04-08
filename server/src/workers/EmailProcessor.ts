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
    const senderName = parsed.from?.value?.[0]?.name || null;

    const imapUser = (process.env.IMAP_USER || '').replace(/@@/g, '@').toLowerCase();
    // Lapen addresses we accept emails for (also include FROM_EMAIL to prevent it from becoming a signer)
    const fromEmailAddr = (process.env.FROM_EMAIL || '').replace(/@@/g, '@').toLowerCase();
    const lapenAddresses = new Set([imapUser, fromEmailAddr].filter(Boolean));

    // Extract TO and CC with full name+address info
    const toEntries = (parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [])
      .flatMap(addr => 'value' in addr ? addr.value : [addr]);
    const ccEntries = (parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : [])
      .flatMap(addr => 'value' in addr ? addr.value : [addr]);

    const toAddresses = toEntries.map(a => (a.address || '').toLowerCase());
    const ccAddresses = ccEntries.map(a => (a.address || '').toLowerCase());
    const allRecipientAddresses = [...toAddresses, ...ccAddresses];

    // Check if any of our addresses are in TO or CC
    const isAddressedToUs = lapenAddresses.size === 0 || allRecipientAddresses.some(a => lapenAddresses.has(a));
    if (!isAddressedToUs) {
      logger.info(`Skipping email not addressed to us: from=${senderEmail} to=${toAddresses.join(',')} cc=${ccAddresses.join(',')} lapenAddresses=${[...lapenAddresses].join(',')}`);
      return;
    }

    // All flows now go through sign@ (set@ has been removed)

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
    const db = getDatabase();

    const firstLine = body.split(/\r?\n/)[0].trim();
    logger.info(`Processing incoming email: from=${senderEmail} subject="${subject}" bodyLen=${body.length} attachments=${attachments.length} toCount=${toEntries.length} ccCount=${ccEntries.length} firstLine="${firstLine}"`);

    // ---------------------------------------------------------------
    // Extract signers from TO/CC addresses (excluding Lapen addresses and sender)
    // ---------------------------------------------------------------
    const serviceEmail = (process.env.FROM_EMAIL || '').replace(/@@/g, '@').toLowerCase();
    const recipientSigners: Array<{ email: string; phone: null; name: string | null; channel: 'email' }> = [];
    const seenEmails = new Set<string>();

    // Log raw TO/CC entries for debugging name extraction
    logger.info({ toEntries: toEntries.map(e => ({ name: e.name, address: e.address })), ccEntries: ccEntries.map(e => ({ name: e.name, address: e.address })) }, 'Raw TO/CC entries from email parser');

    for (const entry of [...toEntries, ...ccEntries]) {
      const addr = (entry.address || '').toLowerCase();
      if (!addr) continue;
      if (lapenAddresses.has(addr)) continue;
      if (addr === senderLower) continue;
      if (!this.isValidSigneeEmail(addr, senderEmail, serviceEmail, imapUser)) continue;
      if (seenEmails.has(addr)) continue;
      seenEmails.add(addr);
      // Derive name from email header or email prefix
      let name = entry.name || null;
      if (!name) {
        const prefix = addr.split('@')[0];
        name = prefix.replace(/[._-]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
      }
      recipientSigners.push({ email: addr, phone: null, name, channel: 'email' });
    }

    // ---------------------------------------------------------------
    // Find PDF attachment
    // ---------------------------------------------------------------
    const pdfAttachment = attachments.find((a) => {
      const type = (a.contentType || '').toLowerCase();
      const name = (a.filename || '').toLowerCase();
      return type === 'application/pdf' || type === 'application/x-pdf' ||
             type === 'application/octet-stream' || type.includes('pdf') ||
             name.endsWith('.pdf');
    });

    // ---------------------------------------------------------------
    // DIRECT FLOW: Signers found in TO + PDF attached
    // → check for template match first, then send signing links
    // ---------------------------------------------------------------
    if (recipientSigners.length > 0 && pdfAttachment) {
      if (pdfAttachment.size > 25 * 1024 * 1024) {
        await this.trySendEmail({
          to: senderEmail,
          subject: `Re: ${subject}`,
          text: 'Your document is too large (max 25MB). Please compress it or split it into smaller files.',
          inReplyTo: messageId,
        });
        return;
      }

      // Check if already processed
      if (messageId) {
        const existingDoc = await db('document_requests').where({ original_email_message_id: messageId }).first();
        if (existingDoc) {
          logger.info(`Skipping already-processed email: messageId=${messageId} docId=${existingDoc.id}`);
          return;
        }
      }

      // Check for template match: same sender + same filename + status template_ready
      const fileName = pdfAttachment.filename || 'document.pdf';
      const senderUser = await this.userRepo.findByEmail(senderEmail);
      if (senderUser) {
        const templateDoc = await db('document_requests')
          .where({ sender_id: senderUser.id, file_name: fileName, status: 'template_ready' })
          .orderBy('updated_at', 'desc')
          .first();
        if (templateDoc) {
          logger.info({ templateDocId: templateDoc.id, signerCount: recipientSigners.length }, 'Template match found — using pre-configured fields');
          await this.handleTemplateForward(templateDoc, senderEmail, senderUser, recipientSigners, subject, messageId, body);
          return;
        }
      }

      logger.info({ signerCount: recipientSigners.length, signers: recipientSigners.map(s => s.email) }, 'Direct flow: signers detected in TO');
      await this.handleDirectSign(senderEmail, pdfAttachment, recipientSigners, subject, messageId, body, senderName);
      return;
    }

    // ---------------------------------------------------------------
    // STEP 2 REPLY (fallback): Sender is replying with signee contacts
    // in the body of a reply to an existing pending document
    // ---------------------------------------------------------------
    const hasSigneeEmails = this.extractEmailAddresses(body, senderEmail);
    const hasPhoneNumbers = /\+[\d\s()-]{7,20}/.test(this.stripQuotedReply(body));

    if (hasSigneeEmails.length > 0 || hasPhoneNumbers) {
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
            logger.info({ documentId: pendingDoc.id, signeeCount: signeesWithNames.length, signees: signeesWithNames, docStatus: pendingDoc.status }, 'Step 2 reply with signee contacts');
            await this.handleSigneeReply(senderEmail, user, pendingDoc, signeesWithNames, body, messageId);
            return;
          }
        } else {
          logger.warn({ userId: user.id, signees: hasSigneeEmails }, 'Found signee contacts but no pending document');
        }
      }
    }

    // Check if already processed
    if (messageId) {
      const existingDoc = await db('document_requests').where({ original_email_message_id: messageId }).first();
      if (existingDoc) {
        logger.info(`Skipping already-processed email: messageId=${messageId} docId=${existingDoc.id}`);
        return;
      }
    }

    // ---------------------------------------------------------------
    // FALLBACK: PDF only (no signers in TO/CC or body)
    // ---------------------------------------------------------------
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

    if (!pdfAttachment) {
      await this.trySendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: `Welcome to Lapen! To send a document for signing:\n\n1. Compose a new email TO sign@lapen.ai and your signers (e.g. sign@lapen.ai, john@example.com)\n2. Attach the PDF\n3. Send!\n\nLapen will send signing links to your recipients automatically.\n\nWant to customize fields first? Send the PDF only to sign@lapen.ai (no other recipients) and we'll send you a setup link.`,
        inReplyTo: messageId,
      });
      return;
    }

    if (pdfAttachment.size > 25 * 1024 * 1024) {
      await this.trySendEmail({
        to: senderEmail,
        subject: `Re: ${subject}`,
        text: 'Your document is too large (max 25MB). Please compress it or split it into smaller files.',
        inReplyTo: messageId,
      });
      return;
    }

    // PDF attached but no signers — enter template setup flow
    await this.handleTemplateSetup(senderEmail, pdfAttachment, subject, messageId, body, senderName);
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
    senderName?: string | null,
  ): Promise<void> {
    const fileName = attachment.filename || 'document.pdf';
    const content = attachment.content;
    const size = attachment.size;

    logger.info(`Step 1: New document from ${senderEmail}: ${fileName} (${size}b)`);

    // Create user
    const user = await this.userRepo.findOrCreateByEmail(senderEmail, senderName || undefined);

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
    const purchaseUrl = `${appUrl}/credits?user=${user.id}`;
    const creditFooter = this.emailService.renderCreditBalanceHtml(user.credits, purchaseUrl);
    const creditText = this.emailService.renderCreditBalanceText(user.credits);

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

  ${creditFooter}
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

Preview: ${previewUrl}

${creditText}`,
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
        // Store pending signers so we can auto-process after credit purchase
        await db('document_requests').where({ id: pendingDoc.id }).update({
          status: 'insufficient_credits',
          pending_signers_json: JSON.stringify(signees),
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
        logger.info({ documentId: pendingDoc.id, required: signeeCount, available: user.credits }, 'Insufficient credits — notified sender (signers stored for auto-processing)');
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
    const setupUrl = `${appUrl}/setup/${pendingDoc.id}`;
    const purchaseUrl = `${appUrl}/credits?user=${user.id}`;
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

    // Get updated credit balance after deduction
    const updatedUser = await this.userRepo.findById(user.id);
    const currentCredits = updatedUser?.credits ?? 0;
    const creditFooter = this.emailService.renderCreditBalanceHtml(currentCredits, purchaseUrl);
    const creditText = this.emailService.renderCreditBalanceText(currentCredits);

    await this.trySendEmail({
      to: senderEmail,
      subject: `✓ Document sent for signature: ${pendingDoc.file_name}`,
      text: `Done! I've sent "${pendingDoc.file_name}" for signature to:\n\n${sentList}${failedList ? '\n' + failedList : ''}\n\nI'll notify you as each person signs.${failedNote}\n\nTrack status: ${statusUrl}\n\nWant to reconfigure fields? ${setupUrl}\nNote: this will void any signatures already collected.\n\n${creditText}`,
      html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #16a34a; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px;">✓ Document Sent</h1>
  </div>
  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
    <p>I've sent <strong>${pendingDoc.file_name}</strong> for signature to:</p>
    <ul style="margin: 12px 0; padding-left: 20px;">
      ${recipientListHtml}${failedListHtml}
    </ul>
    <p>I'll notify you as each person signs.</p>
    ${failedNoteHtml}
    <div style="text-align: center; margin: 20px 0 0;">
      <a href="${statusUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">Track Signing Status</a>
    </div>
    <p style="margin: 16px 0 0; font-size: 13px; color: #6b7280; text-align: center;">
      Want to reconfigure fields? <a href="${setupUrl}" style="color: #2563eb;">Customize fields</a>
      <br><span style="font-size: 12px;">(Note: this will void any signatures already collected)</span>
    </p>
  </div>
  ${creditFooter}
</div>`,
      inReplyTo: messageId,
    });

    logger.info({ documentId: pendingDoc.id, sent: sentContacts.length, failed: failedContacts.length }, 'Step 2 complete: signing notifications sent, sender notified');
  }

  // =========================================================================
  // DIRECT SIGN: sign@ flow — create doc + send signing links immediately
  // =========================================================================
  private async handleDirectSign(
    senderEmail: string,
    attachment: { content: Buffer; filename?: string; size: number; contentType?: string },
    signers: Array<{ email: string; phone: null; name: string | null; channel: 'email' }>,
    subject: string,
    messageId: string,
    body: string,
    senderName?: string | null,
  ): Promise<void> {
    const fileName = attachment.filename || 'document.pdf';
    const content = attachment.content;
    logger.info(`Direct sign flow: ${senderEmail} → ${signers.length} signers, file=${fileName}`);

    // Create user
    const user = await this.userRepo.findOrCreateByEmail(senderEmail, senderName || undefined);

    // Extract text and page count
    let pageCount = 1;
    try {
      const { extractPdfText } = await import('../services/pdfTextExtractor.js');
      const result = await extractPdfText(content);
      pageCount = result.pageCount;
    } catch (parseErr) {
      logger.warn(`PDF text extraction failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }

    // Upload to S3 and create document
    let documentId: string;
    let s3Key: string | null = null;
    if (process.env.AWS_ACCESS_KEY_ID) {
      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();
        s3Key = `documents/${user.id}/${crypto.randomUUID()}/${fileName}`;
        await storageService.uploadDocument(s3Key, content, 'application/pdf');
        const doc = await this.documentRepo.create({
          sender_id: user.id,
          status: 'pending_confirmation',
          file_name: fileName,
          file_size: attachment.size,
          page_count: pageCount,
          mime_type: 'application/pdf',
          document_hash: crypto.createHash('sha256').update(content).digest('hex'),
          s3_key: s3Key,
          is_sequential: false,
          signing_mode: 'shared',
          credits_required: signers.length,
          original_email_message_id: messageId,
          subject,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        documentId = doc.id;
      } catch (err) {
        logger.error(`S3 upload failed: ${err instanceof Error ? err.message : String(err)}`);
        documentId = await this.createBasicDocument(user.id, { content, filename: fileName, size: attachment.size }, messageId, subject);
      }
    } else {
      documentId = await this.createBasicDocument(user.id, attachment, messageId, subject);
    }

    // Audit
    await this.auditRepo.log({
      document_request_id: documentId,
      signer_id: null,
      action: 'document_created',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { senderEmail, subject, flow: 'direct-sign' },
    });

    // Create a pending doc object for handleSigneeReply
    const pendingDoc = await getDatabase()('document_requests').where({ id: documentId }).first();

    // Delegate to existing signer creation + notification logic
    await this.handleSigneeReply(senderEmail, user, pendingDoc, signers, body, messageId);

    logger.info({ documentId, signerCount: signers.length }, 'Direct sign flow complete');
  }

  // =========================================================================
  // TEMPLATE SETUP: PDF sent to sign@ with no recipients — setup flow
  // =========================================================================
  private async handleTemplateSetup(
    senderEmail: string,
    attachment: { content: Buffer; filename?: string; size: number; contentType?: string },
    subject: string,
    messageId: string,
    body: string,
    senderName?: string | null,
  ): Promise<void> {
    const fileName = attachment.filename || 'document.pdf';
    const content = attachment.content;
    logger.info(`Template setup flow: ${senderEmail}, file=${fileName}`);

    // Create user
    const user = await this.userRepo.findOrCreateByEmail(senderEmail, senderName || undefined);

    // Extract text and page count
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

    // Upload to S3 and create document
    let documentId: string;
    if (process.env.AWS_ACCESS_KEY_ID) {
      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();
        const s3Key = `documents/${user.id}/${crypto.randomUUID()}/${fileName}`;
        await storageService.uploadDocument(s3Key, content, 'application/pdf');
        const doc = await this.documentRepo.create({
          sender_id: user.id,
          status: 'pending_setup',
          file_name: fileName,
          file_size: attachment.size,
          page_count: pageCount,
          mime_type: 'application/pdf',
          document_hash: crypto.createHash('sha256').update(content).digest('hex'),
          s3_key: s3Key,
          is_sequential: false,
          credits_required: 0,
          original_email_message_id: messageId,
          subject,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        documentId = doc.id;
      } catch (err) {
        logger.error(`S3 upload failed: ${err instanceof Error ? err.message : String(err)}`);
        documentId = await this.createBasicDocument(user.id, { content, filename: fileName, size: attachment.size }, messageId, subject);
      }
    } else {
      documentId = await this.createBasicDocument(user.id, attachment, messageId, subject);
    }

    // Generate AI summary
    let summary = '';
    try {
      const { AIService } = await import('../services/AIService.js');
      const aiService = new AIService();
      const result = await aiService.summarizeDocumentForSender(documentText, fileName);
      summary = result.summary;
    } catch {
      summary = `Document "${fileName}" (${pageCount} pages) has been uploaded.`;
    }

    await getDatabase()('document_requests').where({ id: documentId }).update({ ai_summary: summary });

    // Audit
    await this.auditRepo.log({
      document_request_id: documentId,
      signer_id: null,
      action: 'document_created',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { senderEmail, subject, flow: 'template-setup' },
    });

    // Reply with setup link
    const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
    const setupUrl = `${appUrl}/setup/${documentId}`;
    const purchaseUrl = `${appUrl}/credits?user=${user.id}`;
    const creditFooter = this.emailService.renderCreditBalanceHtml(user.credits, purchaseUrl);
    const creditText = this.emailService.renderCreditBalanceText(user.credits);

    await this.trySendEmail({
      to: senderEmail,
      subject: `Re: ${subject || fileName}`,
      text: `Hi ${user.name || senderEmail.split('@')[0]},\n\nGot your document "${fileName}".\n\n${summary}\n\nSet up your fields and configure the signing experience:\n${setupUrl}\n\nOnce you're done, you'll be able to send the PDF to your recipients with Lapen handling the signing.\n\n${creditText}`,
      html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #2563eb; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Lapen</h1>
  </div>
  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Hi ${user.name || senderEmail.split('@')[0]},</p>
    <p>Got your document <strong>${fileName}</strong>:</p>
    <div style="background: #f9fafb; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 0 0 16px; border-radius: 0 4px 4px 0;">
      <p style="margin: 0; font-size: 14px; color: #374151;">${summary}</p>
    </div>
    <p>Set up your fields and configure the signing experience. Once done, you can send the PDF to your recipients and Lapen will handle the rest.</p>
    <div style="text-align: center; margin: 20px 0 0;">
      <a href="${setupUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Set Up Document</a>
    </div>
  </div>
  ${creditFooter}
</div>`,
      inReplyTo: messageId,
    });

    logger.info({ documentId }, 'Template setup flow: setup email sent');
  }

  // =========================================================================
  // TEMPLATE FORWARD: Sender forwards prepared PDF with recipients + CC sign@
  // Matches template by sender + filename → clones fields → sends signing links
  // =========================================================================
  private async handleTemplateForward(
    templateDoc: any,
    senderEmail: string,
    user: { id: string; name: string | null; email: string; credits: number },
    signers: Array<{ email: string; phone: null; name: string | null; channel: 'email' }>,
    subject: string,
    messageId: string,
    body: string,
  ): Promise<void> {
    const db = getDatabase();
    const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
    const signeeCount = signers.length;

    logger.info({ templateDocId: templateDoc.id, signerCount: signeeCount }, 'Template forward: cloning fields for new signers');

    // Credit check (same as handleSigneeReply)
    if (user.credits < signeeCount && process.env.STRIPE_SECRET_KEY) {
      try {
        const recovered = await this.recoverUnprocessedPayments(user.id, user.email);
        if (recovered) {
          const updatedUser = await this.userRepo.findById(user.id);
          if (updatedUser) {
            user = { id: updatedUser.id, name: updatedUser.name, email: updatedUser.email, credits: updatedUser.credits };
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to recover Stripe payments');
      }
    }

    if (user.credits < signeeCount) {
      const purchaseUrl = `${appUrl}/credits?user=${user.id}`;
      await this.emailService.sendInsufficientCreditsEmail(
        senderEmail,
        signeeCount,
        user.credits,
        purchaseUrl,
        messageId,
      );
      logger.info({ templateDocId: templateDoc.id, required: signeeCount, available: user.credits }, 'Template forward: insufficient credits');
      return;
    }

    // Deduct credits
    await this.userRepo.deductCredits(user.id, signeeCount, templateDoc.id);

    // Update template doc status to sent
    await db('document_requests').where({ id: templateDoc.id }).update({
      status: 'sent',
      credits_required: signeeCount,
    });

    // Get template fields
    const templateFields = await db('document_fields')
      .where({ document_request_id: templateDoc.id, is_template: true });

    // Fetch PDF for attachment
    let pdfBuffer: Buffer | null = null;
    if (templateDoc.s3_key && process.env.AWS_ACCESS_KEY_ID) {
      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();
        pdfBuffer = await storageService.getDocument(templateDoc.s3_key);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch PDF from S3 for attachment');
      }
    }

    // Create signers, clone template fields, send notifications
    const sentContacts: string[] = [];
    const failedContacts: string[] = [];
    const senderDisplayName = user.name || senderEmail.split('@')[0];

    // Extract cover text from the forwarding email body
    let coverText = this.extractCoverText(body, signers.map(s => s.email));
    if (!coverText) {
      coverText = `Please review and sign the document "${templateDoc.file_name}".\n\nThank you,\n${senderDisplayName}`;
    }

    for (let i = 0; i < signers.length; i++) {
      const { email, name: signeeName } = signers[i];
      const signingToken = crypto.randomBytes(32).toString('base64url');

      // Create signer
      await this.documentRepo.createSigner({
        document_request_id: templateDoc.id,
        email,
        phone: null,
        name: signeeName,
        status: 'pending',
        delivery_channel: 'email',
        signing_order: i + 1,
        signing_token: signingToken,
        custom_message: coverText || null,
      });

      // Get the signer record to get its ID
      const signer = await db('signers').where({ document_request_id: templateDoc.id, email }).first();

      // Clone template fields for this signer
      if (signer && templateFields.length > 0) {
        for (const tf of templateFields) {
          await db('document_fields').insert({
            id: crypto.randomUUID(),
            document_request_id: templateDoc.id,
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

      // Send personalized signing notification
      const signingUrl = `${appUrl}/sign/${signingToken}`;
      try {
        await this.emailService.sendSigningNotification(
          email,
          signeeName || undefined,
          senderDisplayName,
          senderEmail,
          templateDoc.file_name,
          signingUrl,
          coverText || undefined,
          'email',
          pdfBuffer ? { content: pdfBuffer, filename: templateDoc.file_name } : undefined,
        );

        // Update signer status to notified
        if (signer) {
          await this.documentRepo.updateSignerStatus(signer.id, 'notified', { notified_at: new Date() } as any);
        }

        const displayLabel = signeeName ? `${signeeName} (${email})` : email;
        sentContacts.push(displayLabel);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ error: errMsg, contact: email }, 'Failed to send signing notification (template forward)');
        failedContacts.push(signeeName ? `${signeeName} (${email})` : email);
      }
    }

    // Audit
    await this.auditRepo.log({
      document_request_id: templateDoc.id,
      signer_id: null,
      action: 'document_sent',
      ip_address: 'email',
      user_agent: 'email-agent',
      metadata: { flow: 'template-forward', signerCount: signeeCount },
    });

    // Send confirmation to sender
    const statusUrl = `${appUrl}/status/${templateDoc.id}`;
    const setupUrl = `${appUrl}/setup/${templateDoc.id}`;
    const purchaseUrl = `${appUrl}/credits?user=${user.id}`;
    const sentList = sentContacts.map(c => `  • ${c}`).join('\n');
    const recipientListHtml = sentContacts.map(c =>
      `<li style="margin: 4px 0;">${c}</li>`
    ).join('');

    const updatedUser = await this.userRepo.findById(user.id);
    const currentCredits = updatedUser?.credits ?? 0;
    const creditFooter = this.emailService.renderCreditBalanceHtml(currentCredits, purchaseUrl);
    const creditText = this.emailService.renderCreditBalanceText(currentCredits);

    await this.trySendEmail({
      to: senderEmail,
      subject: `✓ Document sent for signature: ${templateDoc.file_name}`,
      text: `Done! Your pre-configured document "${templateDoc.file_name}" has been sent for signature to:\n\n${sentList}\n\nEach recipient received a personalized signing link with your pre-configured fields.\n\nI'll notify you as each person signs.\n\nTrack status: ${statusUrl}\n\n${creditText}`,
      html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
  <div style="background: #16a34a; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 20px;">✓ Document Sent (Pre-configured)</h1>
  </div>
  <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
    <p>Your pre-configured document <strong>${templateDoc.file_name}</strong> has been sent for signature to:</p>
    <ul style="margin: 12px 0; padding-left: 20px;">
      ${recipientListHtml}
    </ul>
    <p>Each recipient received a personalized signing link with your pre-configured fields. I'll notify you as each person signs.</p>
    <div style="text-align: center; margin: 20px 0 0;">
      <a href="${statusUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">Track Signing Status</a>
    </div>
    <p style="margin: 16px 0 0; font-size: 13px; color: #6b7280; text-align: center;">
      Want to reconfigure fields? <a href="${setupUrl}" style="color: #2563eb;">Customize fields</a>
      <br><span style="font-size: 12px;">(Note: this will void any signatures already collected)</span>
    </p>
  </div>
  ${creditFooter}
</div>`,
      inReplyTo: messageId,
    });

    logger.info({ templateDocId: templateDoc.id, sent: sentContacts.length, failed: failedContacts.length }, 'Template forward complete');
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
      signing_mode: 'shared',
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
