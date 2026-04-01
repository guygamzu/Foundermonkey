import { Router, Request, Response } from 'express';
import { getDatabase } from '../config/database.js';
import { UserRepository } from '../models/UserRepository.js';
import { logger } from '../config/logger.js';

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
      await paymentService.handleWebhook(req.body, signature);
      logger.info('Stripe webhook processed successfully');
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
      const user = await userRepo.findById(userId);
      logger.info({ userId, credits, paymentIntentId }, 'Credits applied via session verification (webhook fallback)');
      res.json({ message: `${credits} credits added`, credits: user?.credits });
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
