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
        from: `ləˈpɛn <${this.fromEmail}>`,
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

  /**
   * Renders a credit balance footer for sender emails.
   * Always prominent; escalates to a bold red banner with an explicit
   * top-up CTA button when the balance is <= 5.
   */
  renderCreditBalanceHtml(credits: number, purchaseUrl: string): string {
    const isLow = credits <= 5;
    const plural = credits === 1 ? '' : 's';

    if (isLow) {
      return `
        <div style="background: #fef2f2; padding: 18px 24px; border: 2px solid #dc2626; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
          <p style="margin: 0 0 6px; color: #dc2626; font-size: 18px; font-weight: 800; letter-spacing: 0.2px;">
            Only ${credits} credit${plural} left
          </p>
          <p style="margin: 0 0 12px; color: #991b1b; font-size: 13px; font-weight: 600;">
            Top up now so your next document is not delayed.
          </p>
          <a href="${purchaseUrl}" style="display: inline-block; padding: 10px 22px; background: #dc2626; color: white; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">
            Top up credits
          </a>
          <p style="margin: 14px 0 0; color: #9ca3af; font-size: 11px;">Powered by Lapen &mdash; AI-powered e-signatures</p>
        </div>
      `;
    }

    return `
      <div style="background: #f9fafb; padding: 16px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
        <p style="margin: 0 0 4px; color: #111827; font-size: 15px; font-weight: 700;">
          ${credits} credit${plural} remaining
        </p>
        <p style="margin: 0 0 10px; color: #6b7280; font-size: 12px;">
          1 credit = 1 signature request
        </p>
        <a href="${purchaseUrl}" style="display: inline-block; color: #2563eb; text-decoration: none; font-weight: 600; font-size: 13px; border-bottom: 1px solid #2563eb; padding-bottom: 1px;">
          Manage credits
        </a>
        <p style="margin: 12px 0 0; color: #9ca3af; font-size: 11px;">Powered by Lapen &mdash; AI-powered e-signatures</p>
      </div>
    `;
  }

  renderCreditBalanceText(credits: number): string {
    const plural = credits === 1 ? '' : 's';
    if (credits <= 5) {
      return `>>> ONLY ${credits} CREDIT${plural.toUpperCase()} LEFT — top up now so your next document is not delayed.`;
    }
    return `Credits remaining: ${credits} (1 credit = 1 signature request)`;
  }

  async sendCreditsAppliedEmail(
    to: string,
    creditsAdded: number,
    newBalance: number,
    purchaseUrl: string,
    processedDocuments: Array<{ fileName: string; signerCount: number }>,
  ): Promise<string> {
    const processedSection = processedDocuments.length > 0
      ? `
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="margin: 0 0 8px; font-weight: 700; color: #166534;">Pending documents now processing:</p>
          <ul style="margin: 0; padding-left: 20px; color: #15803d;">
            ${processedDocuments.map(d => `<li>${d.fileName} (${d.signerCount} signer${d.signerCount !== 1 ? 's' : ''})</li>`).join('')}
          </ul>
          <p style="margin: 8px 0 0; font-size: 13px; color: #166534;">Signing links have been sent to all recipients.</p>
        </div>`
      : '';

    const isLow = newBalance < 5;
    const balanceColor = isLow ? '#dc2626' : '#16a34a';
    const lowWarning = isLow
      ? `<p style="margin: 12px 0 0; color: #dc2626; font-size: 13px;">Your balance is getting low. <a href="${purchaseUrl}" style="color: #2563eb; text-decoration: underline;">Top up</a> to keep sending without interruption.</p>`
      : '';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
        <div style="background: linear-gradient(135deg, #16a34a 0%, #15803d 100%); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 700;">Credits Added!</h1>
        </div>
        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="margin: 0 0 12px;">
            <strong>${creditsAdded} credit${creditsAdded !== 1 ? 's' : ''}</strong> have been added to your account.
          </p>
          <p style="margin: 0 0 4px; font-size: 15px;">
            New balance: <strong style="color: ${balanceColor}; font-size: 18px;">${newBalance}</strong> credits
          </p>
          ${processedSection}
          ${lowWarning}
        </div>
        ${this.renderCreditBalanceHtml(newBalance, purchaseUrl)}
      </div>
    `;

    const processedText = processedDocuments.length > 0
      ? `\n\nPending documents now processing:\n${processedDocuments.map(d => `  - ${d.fileName} (${d.signerCount} signers)`).join('\n')}\n\nSigning links have been sent to all recipients.`
      : '';

    return this.sendEmail({
      to,
      subject: `Credits added — ${newBalance} credits remaining`,
      text: `${creditsAdded} credits have been added to your account.\n\nNew balance: ${newBalance} credits${processedText}\n\n${this.renderCreditBalanceText(newBalance)}`,
      html,
    });
  }

  /**
   * Sends a celebratory email when a user earns credits through another user
   * (currently: the first-time-sender referral bonus). Fires for both parties
   * after a successful `redeemReferral`, with copy tailored to each role to
   * drive virality:
   *   - role=referrer: "your contact joined → you just earned free credits"
   *   - role=referred: "welcome bonus from <contact> → keep the chain going"
   */
  async sendReferralBonusEmail(params: {
    to: string;
    recipientName: string | null;
    otherPartyEmail: string;
    otherPartyName: string | null;
    bonusAmount: number;
    newBalance: number;
    purchaseUrl: string;
    role: 'referrer' | 'referred';
  }): Promise<string> {
    const {
      to, recipientName, otherPartyEmail, otherPartyName,
      bonusAmount, newBalance, purchaseUrl, role,
    } = params;

    const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,';
    const otherDisplay = otherPartyName || otherPartyEmail;
    const plural = bonusAmount === 1 ? '' : 's';

    // Each role gets its own hook copy + share CTA
    const whyLine = role === 'referrer'
      ? `<strong>${otherDisplay}</strong> just sent their first document through Lapen — because they first discovered Lapen by signing one of yours, you both earned <strong>${bonusAmount} bonus credit${plural} each</strong> as a thank-you.`
      : `Welcome to Lapen! Because you first discovered us by signing a document from <strong>${otherDisplay}</strong>, you <em>and</em> they each earned <strong>${bonusAmount} bonus credit${plural}</strong> to get started.`;

    const ctaHeadline = role === 'referrer'
      ? 'Keep the chain going'
      : 'Pass it on and earn 5 more';

    const ctaSubline = role === 'referrer'
      ? 'Every time someone who has signed one of your Lapen documents comes back and sends their own first document, you both earn 5 more credits. Invite more people to experience Lapen — the more they use it, the more free credits you get.'
      : 'The next time one of your signers comes back to Lapen and sends their own first document, you and they will each earn another 5 credits — automatically. Send a document now to start the cycle.';

    const shareBody =
      'Hi,\n\n' +
      'I just used Lapen to get a document signed — it is the simplest way I have seen. No accounts, no downloads, just email.\n\n' +
      'If you ever need to get a PDF signed, just attach it to an email, put sign@lapen.ai in CC, and Lapen will email your signers a secure link. Try it — if you come from this intro, we both get 5 bonus credits.\n\n' +
      'Thanks!';
    const shareHref = `mailto:?cc=${encodeURIComponent('sign@lapen.ai')}&subject=${encodeURIComponent('Try Lapen — get documents signed by email')}&body=${encodeURIComponent(shareBody)}`;

    const balanceColor = newBalance <= 5 ? '#dc2626' : '#16a34a';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
        <div style="background: linear-gradient(135deg, #16a34a 0%, #15803d 100%); padding: 28px 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <p style="margin: 0 0 6px; color: rgba(255,255,255,0.85); font-size: 13px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;">Bonus credits earned</p>
          <h1 style="margin: 0; color: white; font-size: 32px; font-weight: 800;">+${bonusAmount} credit${plural}</h1>
        </div>
        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="margin: 0 0 14px; font-size: 15px;">${greeting}</p>
          <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.55;">${whyLine}</p>
          <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 16px 0; text-align: center;">
            <p style="margin: 0 0 4px; color: #166534; font-size: 12px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;">New balance</p>
            <p style="margin: 0; color: ${balanceColor}; font-size: 28px; font-weight: 800;">${newBalance} credit${newBalance === 1 ? '' : 's'}</p>
            <p style="margin: 6px 0 0; color: #6b7280; font-size: 12px;">1 credit = 1 signature request</p>
          </div>
          <h2 style="margin: 20px 0 8px; font-size: 16px; font-weight: 700; color: #111827;">${ctaHeadline}</h2>
          <p style="margin: 0 0 16px; font-size: 14px; color: #374151; line-height: 1.55;">${ctaSubline}</p>
          <div style="text-align: center; margin: 20px 0 4px;">
            <a href="${shareHref}" style="display: inline-block; padding: 12px 28px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">
              Share Lapen via email
            </a>
          </div>
          <p style="margin: 14px 0 0; font-size: 12px; color: #9ca3af; text-align: center;">
            You earned these credits automatically — nothing else to claim.
          </p>
        </div>
        ${this.renderCreditBalanceHtml(newBalance, purchaseUrl)}
      </div>
    `;

    const text =
      `${greeting}\n\n` +
      `+${bonusAmount} credit${plural} added to your Lapen account.\n\n` +
      (role === 'referrer'
        ? `${otherDisplay} just sent their first document through Lapen. Because they discovered Lapen by signing one of yours, you both earned ${bonusAmount} bonus credit${plural} each.\n\n`
        : `Welcome to Lapen! Because you first discovered us by signing a document from ${otherDisplay}, you and they each earned ${bonusAmount} bonus credit${plural}.\n\n`) +
      `New balance: ${newBalance} credit${newBalance === 1 ? '' : 's'}\n\n` +
      `${ctaHeadline} — ${ctaSubline}\n\n` +
      `Share Lapen: ${shareHref}\n\n` +
      `${this.renderCreditBalanceText(newBalance)}`;

    return this.sendEmail({
      to,
      subject: `You earned +${bonusAmount} bonus credit${plural} on Lapen`,
      text,
      html,
    });
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
    pdfAttachment?: { content: Buffer; filename: string },
  ): Promise<string> {
    const greeting = signerName ? `Hi ${signerName},` : 'Hi there,';

    const coverPlain = customMessage || '';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="margin: 0; color: white; font-size: 18px; font-weight: 700;">${senderName} sent you a document to sign</h1>
        </div>

        <!-- Body -->
        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.5;">${greeting}</p>

          <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.5;">
            <strong>${senderName}</strong> (<a href="mailto:${senderEmail}" style="color: #2563eb;">${senderEmail}</a>)
            has requested your signature on the following document:
          </p>

          <!-- Document card -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; margin: 0 0 20px;">
            <p style="margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #1e293b;">${fileName}</p>
            <p style="margin: 0; font-size: 13px; color: #64748b;">Attached to this email &middot; Requires your signature</p>
          </div>

          <!-- Cover text / message from sender -->
          ${customMessage ? `
          <div style="margin: 0 0 24px;">
            <p style="margin: 0 0 6px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Message from ${senderName}:</p>
            <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px 16px;">
              <p style="margin: 0; font-size: 14px; color: #374151; line-height: 1.6; white-space: pre-line;">${customMessage}</p>
            </div>
          </div>
          ` : ''}

          <!-- Two signing options -->
          <p style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #374151;">Review and sign digitally:</p>

          <!-- Digital signing -->
          <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px 20px; margin: 0 0 20px;">
            <p style="margin: 0 0 12px; font-size: 13px; color: #374151; line-height: 1.5;">
              Click the button below to review and sign the document online. You can place your signature, add text, dates, and checkboxes anywhere on the document.
            </p>
            <div style="text-align: center;">
              <a href="${signingUrl}" style="display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; padding: 12px 32px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 15px; box-shadow: 0 4px 14px rgba(37,99,235,0.35);">
                Review & Sign Online
              </a>
            </div>
          </div>

          <p style="text-align: center; color: #9ca3af; font-size: 12px; margin: 0 0 16px;">
            Direct link: <a href="${signingUrl}" style="color: #2563eb; word-break: break-all;">${signingUrl}</a>
          </p>

          <!-- Trust signals -->
          <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 8px;">
            <p style="margin: 0; font-size: 12px; color: #9ca3af; text-align: center; line-height: 1.6;">
              This is a legitimate signature request sent by <strong>${senderName}</strong> (${senderEmail})
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

    const attachments = pdfAttachment ? [{
      filename: pdfAttachment.filename,
      content: pdfAttachment.content,
      contentType: 'application/pdf',
    }] : undefined;

    return this.sendEmail({
      to,
      subject: `${senderName} (${senderEmail}) requested your signature: ${fileName}`,
      text: `${greeting}\n\n${senderName} (${senderEmail}) has sent you a document to sign.\n\nDocument: ${fileName} (attached)\n${coverPlain ? `\nMessage: ${coverPlain}\n` : ''}\nReview and sign online: ${signingUrl}\n\nClick the link to review and sign the document digitally. You can place your signature, add text, dates, and checkboxes anywhere on the document.\n\nThis is a legitimate signature request. Electronic signatures are legally binding under the ESIGN Act and eIDAS regulation. If you weren't expecting this, you can safely ignore this email.\n\nPowered by Lapen - AI-powered e-signatures`,
      html,
      attachments,
    });
  }

  async sendCompletionNotification(
    to: string,
    fileName: string,
    archiveUrl: string,
    attachments: Array<{ filename: string; content: Buffer; contentType: string }>,
    senderCredits?: { credits: number; purchaseUrl: string },
  ): Promise<string> {
    const creditFooter = senderCredits
      ? this.renderCreditBalanceHtml(senderCredits.credits, senderCredits.purchaseUrl)
      : `<div style="background: #f9fafb; padding: 12px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px; text-align: center;">
          <p style="margin: 0; color: #9ca3af; font-size: 11px;">Powered by Lapen &mdash; AI-powered e-signatures</p>
        </div>`;
    const creditText = senderCredits ? `\n\n${this.renderCreditBalanceText(senderCredits.credits)}` : '';

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
        ${creditFooter}
      </div>
    `;

    return this.sendEmail({
      to,
      subject: `Completed: ${fileName}`,
      text: `Hi,\n\nThe document ${fileName} has been successfully signed by all parties.\n\nPlease find the fully executed document and Certificate of Completion attached.${creditText}\n\nPowered by Lapen`,
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
