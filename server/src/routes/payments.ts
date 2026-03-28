import { Router, Request, Response } from 'express';
import { getDatabase } from '../config/database.js';
import { UserRepository } from '../models/UserRepository.js';
import { PaymentService } from '../services/PaymentService.js';
import { logger } from '../config/logger.js';

export function createPaymentsRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const userRepo = new UserRepository(db);
  const paymentService = new PaymentService(userRepo);

  // Create checkout session
  router.post('/checkout', async (req: Request, res: Response) => {
    try {
      const { userId, packageIndex } = req.body;
      if (!userId || packageIndex === undefined) {
        res.status(400).json({ error: 'userId and packageIndex are required' });
        return;
      }

      const url = await paymentService.createCheckoutSession(userId, packageIndex);
      res.json({ url });
    } catch (err) {
      logger.error({ err }, 'Error creating checkout session');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Stripe webhook
  router.post('/webhook', async (req: Request, res: Response) => {
    try {
      const signature = req.headers['stripe-signature'] as string;
      if (!signature) {
        res.status(400).json({ error: 'Missing stripe-signature header' });
        return;
      }

      await paymentService.handleWebhook(req.body, signature);
      res.json({ received: true });
    } catch (err) {
      logger.error({ err }, 'Stripe webhook error');
      res.status(400).json({ error: 'Webhook processing failed' });
    }
  });

  // Get user credit balance
  router.get('/credits/:userId', async (req: Request<{ userId: string }>, res: Response) => {
    try {
      const user = await userRepo.findById(req.params.userId);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({ credits: user.credits, email: user.email });
    } catch (err) {
      logger.error({ err }, 'Error fetching credits');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
