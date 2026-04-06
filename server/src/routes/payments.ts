import { Router, Request, Response } from 'express';
import { getDatabase } from '../config/database.js';
import { UserRepository } from '../models/UserRepository.js';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { logger } from '../config/logger.js';
import { notifyAdmin } from './admin.js';
import crypto from 'crypto';

/**
 * After credits are added, auto-process any documents stuck in 'insufficient_credits' status.
 * Returns info about processed documents for the confirmation email.
 */
async function processPendingDocumentsAfterPurchase(
  userId: string,
  userRepo: UserRepository,
): Promise<Array<{ fileName: string; signerCount: number }>> {
  const db = getDatabase();
  const documentRepo = new DocumentRepository(db);
  const auditRepo = new AuditRepository(db);
  const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
  const processedDocs: Array<{ fileName: string; signerCount: number }> = [];

  // Find documents stuck on insufficient_credits for this user
  const pendingDocs = await db('document_requests')
    .where({ sender_id: userId, status: 'insufficient_credits' })
    .whereNotNull('pending_signers_json')
    .orderBy('created_at', 'asc');

  if (pendingDocs.length === 0) return processedDocs;

  const user = await userRepo.findById(userId);
  if (!user) return processedDocs;

  for (const doc of pendingDocs) {
    let signees: Array<{ email: string | null; phone: string | null; name: string | null; channel: 'email' | 'sms' | 'whatsapp' }>;
    try {
      signees = JSON.parse(doc.pending_signers_json);
    } catch {
      logger.warn({ docId: doc.id }, 'Invalid pending_signers_json — skipping');
      continue;
    }

    const signeeCount = signees.length;

    // Re-check credits
    const freshUser = await userRepo.findById(userId);
    if (!freshUser || freshUser.credits < signeeCount) {
      logger.info({ docId: doc.id, required: signeeCount, available: freshUser?.credits }, 'Still insufficient credits for pending doc — skipping');
      break; // Stop processing further docs
    }

    // Guard: check if signers already exist (prevents duplicate sends)
    const existingSigners = await db('signers').where({ document_request_id: doc.id }).select('email');
    if (existingSigners.length > 0) {
      logger.info({ docId: doc.id }, 'Signers already exist — clearing pending status');
      await db('document_requests').where({ id: doc.id }).update({ status: 'sent', pending_signers_json: null });
      continue;
    }

    // Deduct credits
    await userRepo.deductCredits(userId, signeeCount, doc.id);

    // Update status
    await db('document_requests').where({ id: doc.id }).update({
      status: 'sent',
      credits_required: signeeCount,
      pending_signers_json: null,
    });

    // Create signers and send notifications
    const { EmailService } = await import('../services/EmailService.js');
    const emailService = new EmailService();
    const { MessagingService } = await import('../services/MessagingService.js');
    const messagingService = new MessagingService();

    const senderDisplayName = user.name || user.email.split('@')[0];
    const sentContacts: string[] = [];

    // Fetch PDF for attachment
    let pdfBuffer: Buffer | null = null;
    if (doc.s3_key && process.env.AWS_ACCESS_KEY_ID) {
      try {
        const { StorageService } = await import('../services/StorageService.js');
        const storageService = new StorageService();
        pdfBuffer = await storageService.getDocument(doc.s3_key);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch PDF for attachment');
      }
    }

    for (let i = 0; i < signees.length; i++) {
      const { email, phone, name: signeeName, channel } = signees[i];
      const contactLabel = email || phone || 'unknown';
      const signingToken = crypto.randomBytes(32).toString('base64url');

      await documentRepo.createSigner({
        document_request_id: doc.id,
        email,
        phone,
        name: signeeName,
        status: 'notified',
        delivery_channel: channel,
        signing_order: i + 1,
        signing_token: signingToken,
        custom_message: null,
      });

      const signingUrl = `${appUrl}/sign/${signingToken}`;

      try {
        if (channel === 'email' && email) {
          const coverText = doc.suggested_cover_text || `Please review and sign the attached document "${doc.file_name}".`;
          await emailService.sendSigningNotification(
            email,
            signeeName || undefined,
            senderDisplayName,
            user.email,
            doc.file_name,
            signingUrl,
            coverText,
            'email',
            pdfBuffer ? { content: pdfBuffer, filename: doc.file_name } : undefined,
          );
          sentContacts.push(`${signeeName || email} (${email})`);
        } else if ((channel === 'sms' || channel === 'whatsapp') && phone) {
          const message = `${senderDisplayName} sent you a document to sign: "${doc.file_name}". Review and sign here: ${signingUrl}`;
          if (channel === 'whatsapp') {
            await messagingService.sendWhatsApp(phone, message);
          } else {
            await messagingService.sendSMS(phone, message);
          }
          sentContacts.push(`${signeeName || phone} (${channel})`);
        }
      } catch (sendErr) {
        logger.warn({ err: sendErr, contact: contactLabel }, 'Failed to send signing notification (auto-processed)');
      }
    }

    await auditRepo.log({
      document_request_id: doc.id,
      signer_id: null,
      action: 'document_sent',
      ip_address: 'payment',
      user_agent: 'auto-process-after-credit-purchase',
      metadata: { signees: signees.map(s => ({ contact: s.email || s.phone, channel: s.channel, name: s.name })) },
    });

    processedDocs.push({ fileName: doc.file_name, signerCount: signeeCount });
    logger.info({ docId: doc.id, signerCount: signeeCount }, 'Auto-processed pending document after credit purchase');
  }

  return processedDocs;
}

export function createPaymentsRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const userRepo = new UserRepository(db);

  // Create checkout session
  router.post('/checkout', async (req: Request, res: Response) => {
    try {
      if (!process.env.STRIPE_SECRET_KEY) {
        logger.error('STRIPE_SECRET_KEY is not set — cannot process payments');
        res.status(503).json({ error: 'Payment processing is temporarily unavailable. Please try again later.' });
        return;
      }

      const { userId, packageIndex } = req.body;
      if (!userId || packageIndex === undefined) {
        res.status(400).json({ error: 'userId and packageIndex are required' });
        return;
      }

      const user = await userRepo.findById(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const { PaymentService } = await import('../services/PaymentService.js');
      const paymentService = new PaymentService(userRepo);
      const url = await paymentService.createCheckoutSession(userId, packageIndex);
      res.json({ url });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errMsg }, 'Error creating checkout session');
      res.status(500).json({ error: 'Failed to start checkout. Please try again.' });
    }
  });

  // Stripe webhook
  router.post('/webhook', async (req: Request, res: Response) => {
    try {
      if (!process.env.STRIPE_SECRET_KEY) {
        res.status(503).json({ error: 'Payment processing is not configured' });
        return;
      }

      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        logger.error('STRIPE_WEBHOOK_SECRET is not configured - cannot verify webhook');
        res.status(500).json({ error: 'Webhook secret not configured' });
        return;
      }

      const signature = req.headers['stripe-signature'] as string;
      if (!signature) {
        logger.warn('Stripe webhook received without signature header');
        res.status(400).json({ error: 'Missing stripe-signature header' });
        return;
      }

      logger.info('Stripe webhook received, verifying signature...');

      const { PaymentService } = await import('../services/PaymentService.js');
      const paymentService = new PaymentService(userRepo);
      const result = await paymentService.handleWebhook(req.body, signature);
      logger.info('Stripe webhook processed successfully');

      // Auto-process pending documents and send confirmation email
      if (result?.userId && result?.creditsAdded) {
        try {
          const processedDocs = await processPendingDocumentsAfterPurchase(result.userId, userRepo);
          const updatedUser = await userRepo.findById(result.userId);
          if (updatedUser) {
            const { EmailService } = await import('../services/EmailService.js');
            const emailService = new EmailService();
            const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
            await emailService.sendCreditsAppliedEmail(
              updatedUser.email,
              result.creditsAdded,
              updatedUser.credits,
              `${appUrl}/credits?user=${updatedUser.id}`,
              processedDocs,
            );
            notifyAdmin('credit_purchase', { email: updatedUser.email, credits: result.creditsAdded });
          }
        } catch (postErr) {
          logger.warn({ err: postErr }, 'Post-purchase processing failed (credits were still applied)');
        }
      }

      res.json({ received: true });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errMsg }, 'Stripe webhook error');
      res.status(400).json({ error: 'Webhook processing failed' });
    }
  });

  // Verify checkout session and ensure credits are applied (fallback for delayed webhooks)
  router.post('/verify-session', async (req: Request, res: Response) => {
    try {
      if (!process.env.STRIPE_SECRET_KEY) {
        res.status(503).json({ error: 'Payment processing is not configured' });
        return;
      }

      const { sessionId } = req.body;
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }

      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== 'paid') {
        res.status(400).json({ error: 'Payment not completed', status: session.payment_status });
        return;
      }

      const userId = session.metadata?.userId;
      const credits = Number(session.metadata?.credits);
      if (!userId || !credits) {
        res.status(400).json({ error: 'Invalid session metadata' });
        return;
      }

      // Check if credits were already granted
      const paymentIntentId = session.payment_intent as string;
      const existing = await db('credit_transactions')
        .where({ stripe_payment_intent_id: paymentIntentId })
        .first();

      if (existing) {
        const user = await userRepo.findById(userId);
        res.json({ message: 'Credits already applied', credits: user?.credits });
        return;
      }

      // Apply credits now (webhook was delayed or failed)
      await userRepo.addCredits(userId, credits, paymentIntentId);
      logger.info({ userId, credits, paymentIntentId }, 'Credits applied via session verification (webhook fallback)');

      // Auto-process pending documents and send confirmation email
      try {
        const processedDocs = await processPendingDocumentsAfterPurchase(userId, userRepo);
        const updatedUser = await userRepo.findById(userId);
        if (updatedUser) {
          const { EmailService } = await import('../services/EmailService.js');
          const emailService = new EmailService();
          const appUrl = process.env.APP_URL || 'https://app.lapen.ai';
          await emailService.sendCreditsAppliedEmail(
            updatedUser.email,
            credits,
            updatedUser.credits,
            `${appUrl}/credits?user=${updatedUser.id}`,
            processedDocs,
          );
        }
        res.json({ message: `${credits} credits added`, credits: updatedUser?.credits, processedDocuments: processedDocs.length });
      } catch (postErr) {
        logger.warn({ err: postErr }, 'Post-purchase processing failed (credits were still applied)');
        const user = await userRepo.findById(userId);
        res.json({ message: `${credits} credits added`, credits: user?.credits });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errMsg }, 'Error verifying checkout session');
      res.status(500).json({ error: 'Failed to verify payment' });
    }
  });

  // Manual payment verification - recover credits from a completed Stripe payment
  router.post('/verify-payment', async (req: Request, res: Response) => {
    try {
      if (!process.env.STRIPE_SECRET_KEY) {
        res.status(503).json({ error: 'Payment processing is not configured' });
        return;
      }

      const { paymentIntentId } = req.body;
      if (!paymentIntentId) {
        res.status(400).json({ error: 'paymentIntentId is required' });
        return;
      }

      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

      // Find the checkout session for this payment intent
      const sessions = await stripe.checkout.sessions.list({
        payment_intent: paymentIntentId,
        limit: 1,
      });

      if (!sessions.data.length) {
        res.status(404).json({ error: 'No checkout session found for this payment' });
        return;
      }

      const session = sessions.data[0];
      if (session.payment_status !== 'paid') {
        res.status(400).json({ error: `Payment status is "${session.payment_status}", not "paid"` });
        return;
      }

      const userId = session.metadata?.userId;
      const credits = Number(session.metadata?.credits);
      if (!userId || !credits) {
        res.status(400).json({ error: 'Missing userId or credits in session metadata' });
        return;
      }

      // Check if credits were already granted for this payment
      const existing = await db('credit_transactions')
        .where({ stripe_payment_intent_id: paymentIntentId })
        .first();

      if (existing) {
        const user = await userRepo.findById(userId);
        res.json({ message: 'Credits were already granted for this payment', credits: user?.credits });
        return;
      }

      await userRepo.addCredits(userId, credits, paymentIntentId);
      const user = await userRepo.findById(userId);
      logger.info({ userId, credits, paymentIntentId }, 'Credits manually verified and added');
      res.json({ message: `Added ${credits} credits`, newBalance: user?.credits });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errMsg }, 'Error verifying payment');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Redeem referral code
  router.post('/referral', async (req: Request, res: Response) => {
    try {
      const { userId, referralCode } = req.body;
      if (!userId || !referralCode) {
        res.status(400).json({ error: 'userId and referralCode are required' });
        return;
      }

      const referrer = await userRepo.findByReferralCode(referralCode);
      if (!referrer) {
        res.status(404).json({ error: 'Invalid referral code' });
        return;
      }

      const result = await userRepo.redeemReferral(referrer.id, userId);
      res.json({ message: 'Referral redeemed! 5 credits added for both of you.', credits: result.referredCredits });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === 'Cannot refer yourself' || errMsg === 'Referral already redeemed') {
        res.status(400).json({ error: errMsg });
        return;
      }
      logger.error({ error: errMsg }, 'Error redeeming referral');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get user credit balance and referral code
  router.get('/credits/:userId', async (req: Request<{ userId: string }>, res: Response) => {
    try {
      const user = await userRepo.findById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({ credits: user.credits, email: user.email, referralCode: user.referral_code });
    } catch (err) {
      logger.error({ err }, 'Error fetching credits');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
