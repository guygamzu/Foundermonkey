import { logger } from '../config/logger.js';

interface ResendApiResponse {
  id: string;
  [key: string]: unknown;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }>;
  inReplyTo?: string;
  references?: string;
}

export class EmailService {
  private useResend: boolean;
  private resendApiKey: string;
  private fromEmail: string;

  constructor() {
    this.resendApiKey = process.env.RESEND_API_KEY || '';
    this.useResend = !!this.resendApiKey;
    this.fromEmail = (process.env.FROM_EMAIL || process.env.SMTP_USER || 'onboarding@resend.dev').replace(/@@/g, '@');

    if (this.useResend) {
      logger.info(`Email service configured: Resend HTTP API, from=${this.fromEmail}`);
    } else {
      logger.info('Email service: No RESEND_API_KEY set, emails will be logged only');
    }
  }

  async verify(): Promise<boolean> {
    if (!this.useResend) {
      logger.warn('No RESEND_API_KEY — email sending disabled');
      return false;
    }
    // Send-only keys can't list API keys, so just verify the key format is present
    logger.info(`Resend API key configured (${this.resendApiKey.substring(0, 8)}...), from=${this.fromEmail}`);
    return true;
  }

  async sendEmail(options: SendEmailOptions): Promise<string> {
    if (!this.useResend) {
      logger.info(`[DRY RUN] Would send email to=${options.to} subject="${options.subject}"`);
      return 'dry-run-no-api-key';
    }

    try {
      // Reply-To must point to the monitored IMAP inbox so replies come back to us
      const replyTo = (process.env.IMAP_USER || '').replace(/@@/g, '@');

      const payload: any = {
        from: `Lapen <${this.fromEmail}>`,
        reply_to: replyTo || undefined,
        to: [options.to],
        subject: options.subject,
        text: options.text,
      };

      if (options.html) {
        payload.html = options.html;
      }

      if (options.inReplyTo) {
        payload.headers = {
          'In-Reply-To': options.inReplyTo,
          'References': options.references || options.inReplyTo,
        };
      }

      if (options.attachments?.length) {
        payload.attachments = options.attachments.map(a => ({
          filename: a.filename,
          content: a.content.toString('base64'),
          content_type: a.contentType,
        }));
      }

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = await res.json() as ResendApiResponse;

      if (!res.ok) {
        logger.error(`Resend API error (${res.status}): ${JSON.stringify(result)} to=${options.to}`);
        throw new Error(`Resend API error: ${JSON.stringify(result)}`);
      }

      logger.info(`Email sent via Resend: id=${result.id} to=${options.to}`);
      return result.id;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to send email: ${errMsg} to=${options.to} subject="${options.subject}"`);
      throw err;
    }
  }

  async sendConfirmationEmail(
    to: string,
    senderName: string,
    fileName: string,
    fieldCount: number,
    signerCount: number,
    creditsRequired: number,
    creditsRemaining: number,
    previewUrl: string,
    recipientPreview: string,
    inReplyTo?: string,
  ): Promise<string> {
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <p>Hi ${senderName || 'there'},</p>
        <p>Welcome to Lapen! I've analyzed your document (<strong>${fileName}</strong>) and detected
        <strong>${fieldCount} fields</strong> for <strong>${signerCount} signer(s)</strong>.
        This will use <strong>${creditsRequired}</strong> of your <strong>${creditsRemaining}</strong> free signature credits.</p>

        <p>Here is a preview of the document with the fields I've identified:</p>
        <p><a href="${previewUrl}" style="color: #2563eb;">View all detected fields on the full document</a></p>

        <p>And here is the message your recipient(s) will receive:</p>
        <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 12px 0;">
          ${recipientPreview}
        </div>

        <p><strong>Shall I proceed? Reply Y or N.</strong></p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        <p style="color: #6b7280; font-size: 12px;">Lapen - AI-powered e-signatures</p>
      </div>
    `;

    return this.sendEmail({
      to,
      subject: `Re: ${fileName} - Ready for signature`,
      text: `Hi ${senderName || 'there'},\n\nI've analyzed your document (${fileName}) and detected ${fieldCount} fields for ${signerCount} signer(s). This will use ${creditsRequired} of your ${creditsRemaining} credits.\n\nShall I proceed? Reply Y or N.`,
      html,
      inReplyTo,
    });
  }

  async sendSigningNotification(
    to: string,
    signerName: string | undefined,
    senderName: string,
    fileName: string,
    signingUrl: string,
    customMessage?: string,
    channel: 'email' | 'sms' | 'whatsapp' = 'email',
  ): Promise<string> {
    const greeting = signerName ? `Hi ${signerName}` : 'Hi';
    const messageBody = customMessage || `${senderName} has requested your signature on the document ${fileName}. You can review and sign here.`;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <p>${greeting},</p>
        <p>${messageBody}</p>
        <p>
          <a href="${signingUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
            Review & Sign Document
          </a>
        </p>
        <p style="color: #6b7280; font-size: 13px;">
          Or copy this link: <a href="${signingUrl}">${signingUrl}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        <p style="color: #6b7280; font-size: 12px;">Powered by Lapen - AI-powered e-signatures</p>
      </div>
    `;

    return this.sendEmail({
      to,
      subject: `Signature requested: ${fileName}`,
      text: `${greeting},\n\n${messageBody}\n\nReview & Sign: ${signingUrl}\n\nPowered by Lapen`,
      html,
    });
  }

  async sendCompletionNotification(
    to: string,
    fileName: string,
    archiveUrl: string,
    attachments: Array<{ filename: string; content: Buffer; contentType: string }>,
  ): Promise<string> {
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <p>Hi,</p>
        <p>The document <strong>${fileName}</strong> has been successfully signed by all parties.</p>
        <p>Attached you will find:</p>
        <ol>
          <li>The fully executed document.</li>
          <li>The Certificate of Completion with the full audit trail.</li>
        </ol>
        <p>You can also access these files permanently at the following secure link:</p>
        <p><a href="${archiveUrl}" style="color: #2563eb;">${archiveUrl}</a></p>
        <p>Best,<br/>Lapen</p>
      </div>
    `;

    return this.sendEmail({
      to,
      subject: `Completed: ${fileName}`,
      text: `The document ${fileName} has been successfully signed by all parties.\n\nAccess permanently: ${archiveUrl}`,
      html,
      attachments,
    });
  }

  async sendInsufficientCreditsEmail(
    to: string,
    creditsRequired: number,
    creditsAvailable: number,
    purchaseUrl: string,
    inReplyTo?: string,
  ): Promise<string> {
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
        <p>Hi,</p>
        <p>This request will require <strong>${creditsRequired}</strong> signature credits,
        but you only have <strong>${creditsAvailable}</strong> remaining.</p>
        <p>
          <a href="${purchaseUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
            Buy More Credits
          </a>
        </p>
        <p>Once you've topped up your account, simply reply <strong>"Y"</strong> to this email to proceed.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        <p style="color: #6b7280; font-size: 12px;">Lapen - AI-powered e-signatures</p>
      </div>
    `;

    return this.sendEmail({
      to,
      subject: 'Insufficient credits - Action needed',
      text: `This request requires ${creditsRequired} credits, but you only have ${creditsAvailable}.\n\nBuy more: ${purchaseUrl}\n\nOnce purchased, reply "Y" to proceed.`,
      html,
      inReplyTo,
    });
  }
}
