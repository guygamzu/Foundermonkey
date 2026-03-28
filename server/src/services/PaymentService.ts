import Stripe from 'stripe';
import { UserRepository } from '../models/UserRepository.js';
import { logger } from '../config/logger.js';
import { CREDIT_PACKAGES } from '@lapen/shared';

export class PaymentService {
  private stripe: Stripe;

  constructor(private userRepo: UserRepository) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2024-12-18.acacia',
    });
  }

  async createCheckoutSession(userId: string, packageIndex: number): Promise<string> {
    const creditPackage = CREDIT_PACKAGES[packageIndex];
    if (!creditPackage) throw new Error('Invalid package');

    const user = await this.userRepo.findById(userId);
    if (!user) throw new Error('User not found');

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Lapen Signature Credits (${creditPackage.credits})`,
            description: `${creditPackage.credits} signature credits for Lapen`,
          },
          unit_amount: creditPackage.priceUsd,
        },
        quantity: 1,
      }],
      metadata: {
        userId,
        credits: String(creditPackage.credits),
      },
      success_url: `${process.env.APP_URL}/credits/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/credits`,
      customer_email: user.email,
    });

    logger.info({ userId, credits: creditPackage.credits, sessionId: session.id }, 'Checkout session created');
    return session.url!;
  }

  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    const event = this.stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      const credits = Number(session.metadata?.credits);

      if (!userId || !credits) {
        logger.error({ session: session.id }, 'Missing metadata in checkout session');
        return;
      }

      await this.userRepo.addCredits(userId, credits, session.payment_intent as string);
      logger.info({ userId, credits }, 'Credits added after payment');
    }
  }

  getCreditPurchaseUrl(userId: string): string {
    return `${process.env.APP_URL}/credits?user=${userId}`;
  }
}
