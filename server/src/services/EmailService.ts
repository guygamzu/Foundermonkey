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
    senderEmail: string,
    fileName: string,
    signingUrl: string,
    customMessage?: string,
    channel: 'email' | 'sms' | 'whatsapp' = 'email',
  ): Promise<string> {
    const greeting = signerName ? `Hi ${signerName},` : 'Hi,';

    const coverHtml = customMessage
      ? `<div style="background: #f9fafb; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 0 0 20px; border-radius: 0 4px 4px 0;">
          <p style="margin: 0; font-size: 14px; color: #374151; white-space: pre-line;">${customMessage}</p>
        </div>`
      : '';

    const coverPlain = customMessage ? `\n${customMessage}\n` : '';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="margin: 0; color: white; font-size: 18px; font-weight: 700;">You have a document to sign</h1>
        </div>

        <!-- Body -->
        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="margin: 0 0 16px; font-size: 15px;">${greeting}</p>

          <!-- Sender identity -->
          <div style="background: #f0f7ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin: 0 0 20px;">
            <p style="margin: 0 0 4px; font-size: 14px; color: #6b7280;">Sent by:</p>
            <p style="margin: 0; font-size: 16px; font-weight: 700; color: #1e40af;">${senderName}</p>
            <p style="margin: 2px 0 0; font-size: 13px; color: #6b7280;">${senderEmail}</p>
          </div>

          <!-- Document info -->
          <div style="display: flex; align-items: center; gap: 12px; margin: 0 0 16px;">
            <div style="width: 40px; height: 40px; background: #fee2e2; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <span style="font-size: 20px;">📄</span>
            </div>
            <div>
              <p style="margin: 0; font-size: 14px; font-weight: 600; color: #374151;">${fileName}</p>
              <p style="margin: 2px 0 0; font-size: 12px; color: #9ca3af;">Requires your electronic signature</p>
            </div>
          </div>

          ${coverHtml}

          <!-- CTA -->
          <div style="text-align: center; margin: 24px 0 16px;">
            <a href="${signingUrl}" style="display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px; box-shadow: 0 4px 14px rgba(37,99,235,0.35);">
              Review & Sign Document
            </a>
          </div>

          <p style="text-align: center; color: #9ca3af; font-size: 12px; margin: 0 0 16px;">
            Or copy this link: <a href="${signingUrl}" style="color: #2563eb; word-break: break-all;">${signingUrl}</a>
          </p>

          <!-- Trust signals -->
          <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 8px;">
            <p style="margin: 0; font-size: 12px; color: #9ca3af; text-align: center; line-height: 1.6;">
              This is a legitimate e-signature request sent by <strong>${senderName}</strong> (${senderEmail})
              via Lapen. Electronic signatures are legally binding under the ESIGN Act and eIDAS regulation.
              If you weren't expecting this, you can safely ignore this email.
            </p>
          </div>
        </div>

        <!-- Footer -->
        <div style="background: #f9fafb; padding: 12px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
          <p style="margin: 0; color: #9ca3af; font-size: 11px;">
            Powered by Lapen &mdash; AI-powered e-signatures &middot; Secure &middot; Legally Binding
          </p>
        </div>
      </div>
    `;

    return this.sendEmail({
      to,
      subject: `${senderName} (${senderEmail}) requested your signature: ${fileName}`,
      text: `${greeting}\n\n${senderName} (${senderEmail}) has sent you a document to sign.\n\nDocument: ${fileName}\n${coverPlain}\nReview & Sign: ${signingUrl}\n\nThis is a legitimate e-signature request. Electronic signatures are legally binding under the ESIGN Act and eIDAS regulation. If you weren't expecting this, you can safely ignore this email.\n\nPowered by Lapen - AI-powered e-signatures`,
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
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
        <div style="background: linear-gradient(135deg, #16a34a 0%, #15803d 100%); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 700;">Document Signed Successfully</h1>
        </div>
        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="margin: 0 0 16px;">Hi,</p>
          <p style="margin: 0 0 16px;">The document <strong>${fileName}</strong> has been successfully signed by all parties.</p>
          <p style="margin: 0 0 8px;">Attached you will find:</p>
          <ol style="margin: 0 0 16px; padding-left: 20px; line-height: 1.8; color: #374151;">
            <li>The fully executed document</li>
            <li>The Certificate of Completion with the full audit trail</li>
          </ol>
          <p style="margin: 0; font-size: 13px; color: #6b7280;">Please save the attached files for your records.</p>
        </div>
        <div style="background: #f9fafb; padding: 12px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
          <p style="margin: 0; color: #9ca3af; font-size: 11px;">Powered by Lapen &mdash; AI-powered e-signatures</p>
        </div>
      </div>
    `;

    return this.sendEmail({
      to,
      subject: `Completed: ${fileName}`,
      text: `Hi,\n\nThe document ${fileName} has been successfully signed by all parties.\n\nPlease find the fully executed document and Certificate of Completion attached.\n\nPowered by Lapen`,
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
    referralCode?: string,
  ): Promise<string> {
    const referralSection = referralCode ? `
        <div style="background: #fef3c7; border: 1px solid #fbbf24; border-radius: 12px; padding: 20px; margin-top: 24px;">
          <p style="margin: 0 0 8px; font-weight: 700; color: #92400e; font-size: 15px;">
            Or get credits for free!
          </p>
          <p style="margin: 0 0 12px; color: #78350f; font-size: 14px; line-height: 1.5;">
            Share your referral code with a friend. When they sign up and use it,
            <strong>you both get 5 free credits</strong>.
          </p>
          <div style="background: white; border: 2px dashed #f59e0b; border-radius: 8px; padding: 12px; text-align: center;">
            <span style="font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 1px;">Your referral code</span><br/>
            <span style="font-size: 24px; font-weight: 800; color: #1e40af; letter-spacing: 3px; font-family: monospace;">${referralCode}</span>
          </div>
        </div>
    ` : '';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 0;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%); padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 700;">You're almost there!</h1>
          <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0; font-size: 14px;">Your document is ready to send</p>
        </div>

        <!-- Body -->
        <div style="background: white; padding: 28px 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="margin: 0 0 16px; color: #374151; font-size: 15px; line-height: 1.6;">
            Your signing request needs <strong>${creditsRequired} credit${creditsRequired !== 1 ? 's' : ''}</strong>,
            but you have <strong>${creditsAvailable}</strong> remaining.
            Top up to send it instantly:
          </p>

          <!-- Pricing cards -->
          <div style="margin: 20px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: separate; border-spacing: 0 8px;">
              <tr>
                <td style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px;">
                  <strong style="color: #374151;">10 credits</strong>
                  <span style="float: right; color: #2563eb; font-weight: 700;">$15</span>
                </td>
              </tr>
              <tr>
                <td style="background: #eff6ff; border: 2px solid #2563eb; border-radius: 8px; padding: 12px 16px; position: relative;">
                  <strong style="color: #1e40af;">25 credits</strong>
                  <span style="background: #2563eb; color: white; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; margin-left: 8px;">BEST VALUE</span>
                  <span style="float: right; color: #2563eb; font-weight: 700;">$25</span>
                </td>
              </tr>
              <tr>
                <td style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px;">
                  <strong style="color: #374151;">100 credits</strong>
                  <span style="float: right; color: #2563eb; font-weight: 700;">$75</span>
                </td>
              </tr>
            </table>
          </div>

          <!-- CTA Button -->
          <div style="text-align: center; margin: 24px 0 8px;">
            <a href="${purchaseUrl}" style="display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px; box-shadow: 0 4px 14px rgba(37,99,235,0.35);">
              Get Credits Now
            </a>
          </div>
          <p style="text-align: center; color: #9ca3af; font-size: 12px; margin: 8px 0 0;">
            Secure checkout via Stripe. Once purchased, reply to this email with the signee addresses to continue.
          </p>

          ${referralSection}
        </div>

        <!-- Footer -->
        <div style="background: #f9fafb; padding: 16px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px;">
            Lapen &mdash; AI-powered e-signatures &middot; Simple, fast, and secure
          </p>
        </div>
      </div>
    `;

    const textReferral = referralCode
      ? `\n\nOr get credits FREE: share your referral code ${referralCode} with a friend. You both get 5 free credits when they sign up!`
      : '';

    return this.sendEmail({
      to,
      subject: 'Your document is ready — top up to send!',
      text: `Your signing request needs ${creditsRequired} credit(s), but you have ${creditsAvailable}.\n\nGet credits: ${purchaseUrl}\n\nOnce purchased, reply with the signee email addresses to continue.${textReferral}`,
      html,
      inReplyTo,
    });
  }
}
