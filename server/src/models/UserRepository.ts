import { Knex } from 'knex';
import { FREE_CREDITS } from '@lapen/shared';
import { notifyAdmin } from '../routes/admin.js';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  credits: number;
  is_provisional: boolean;
  referral_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export class UserRepository {
  constructor(private db: Knex) {}

  async findById(id: string): Promise<UserRow | undefined> {
    return this.db('users').where({ id }).first();
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    return this.db('users').where({ email: email.toLowerCase() }).first();
  }

  async findOrCreateByEmail(email: string, name?: string): Promise<UserRow> {
    const existing = await this.findByEmail(email);
    if (existing) {
      // Update name if a real display name is provided and current name is just the email prefix
      if (name && (!existing.name || existing.name === email.split('@')[0])) {
        await this.db('users').where({ id: existing.id }).update({ name, updated_at: new Date() });
        existing.name = name;
      }
      return existing;
    }

    const referralCode = this.generateReferralCode();
    const [user] = await this.db('users')
      .insert({
        email: email.toLowerCase(),
        name,
        credits: FREE_CREDITS,
        is_provisional: true,
        referral_code: referralCode,
      })
      .returning('*');

    // Fire-and-forget admin notification
    notifyAdmin('new_user', { email: email.toLowerCase(), name });

    return user;
  }

  async findByReferralCode(code: string): Promise<UserRow | undefined> {
    return this.db('users').where({ referral_code: code.toUpperCase() }).first();
  }

  /**
   * Auto-redeem a referral for users who signed a Lapen document before sending
   * their own first document. Looks up the most recent signed document by this
   * user's email in the `signers` table and, if found, grants 5 credits to both
   * parties via `redeemReferral`.
   *
   * Returns the referral result when redeemed, or null if the user is not
   * eligible (no signing history, already sent documents before, self-referral,
   * or already redeemed).
   */
  async autoRedeemReferralFromSigningHistory(
    newSenderId: string,
    newSenderEmail: string,
  ): Promise<{ referrerId: string; referrerCredits: number; referredCredits: number } | null> {
    // Only eligible if this user has not previously sent any documents as sender
    const priorSend = await this.db('document_requests')
      .where({ sender_id: newSenderId })
      .first();
    if (priorSend) return null;

    // Find the most recent document they signed via Lapen
    const recentSigned = await this.db('signers')
      .join('document_requests', 'signers.document_request_id', 'document_requests.id')
      .whereRaw('LOWER(signers.email) = LOWER(?)', [newSenderEmail])
      .whereNotNull('signers.signed_at')
      .orderBy('signers.signed_at', 'desc')
      .select('document_requests.sender_id as sender_id')
      .first();
    if (!recentSigned?.sender_id) return null;
    if (recentSigned.sender_id === newSenderId) return null;

    try {
      const result = await this.redeemReferral(recentSigned.sender_id, newSenderId);
      return { referrerId: recentSigned.sender_id, ...result };
    } catch {
      // Already redeemed or other non-fatal — swallow
      return null;
    }
  }

  async redeemReferral(referrerId: string, referredId: string): Promise<{ referrerCredits: number; referredCredits: number }> {
    const REFERRAL_BONUS = 5;
    return this.db.transaction(async (trx) => {
      // Check not self-referral
      if (referrerId === referredId) throw new Error('Cannot refer yourself');

      // Check not already referred
      const existing = await trx('referrals')
        .where({ referrer_id: referrerId, referred_id: referredId })
        .first();
      if (existing) throw new Error('Referral already redeemed');

      // Award credits to both
      await trx('users').where({ id: referrerId }).increment('credits', REFERRAL_BONUS);
      await trx('users').where({ id: referredId }).increment('credits', REFERRAL_BONUS);

      // Record the referral
      await trx('referrals').insert({
        referrer_id: referrerId,
        referred_id: referredId,
        credits_awarded: REFERRAL_BONUS,
      });

      // Log transactions
      const referrer = await trx('users').where({ id: referrerId }).first();
      const referred = await trx('users').where({ id: referredId }).first();

      await trx('credit_transactions').insert([
        { user_id: referrerId, amount: REFERRAL_BONUS, balance_after: referrer.credits, reason: 'referral_bonus' },
        { user_id: referredId, amount: REFERRAL_BONUS, balance_after: referred.credits, reason: 'referral_bonus' },
      ]);

      return { referrerCredits: referrer.credits, referredCredits: referred.credits };
    });
  }

  private generateReferralCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  async deductCredits(userId: string, amount: number, documentRequestId: string): Promise<UserRow> {
    return this.db.transaction(async (trx) => {
      const user = await trx('users').where({ id: userId }).forUpdate().first();
      if (!user || user.credits < amount) {
        throw new Error('Insufficient credits');
      }

      const newBalance = user.credits - amount;
      await trx('users').where({ id: userId }).update({
        credits: newBalance,
        updated_at: new Date(),
      });

      await trx('credit_transactions').insert({
        user_id: userId,
        amount: -amount,
        balance_after: newBalance,
        reason: 'signature_request',
        document_request_id: documentRequestId,
      });

      return { ...user, credits: newBalance };
    });
  }

  async addCredits(userId: string, amount: number, stripePaymentIntentId: string): Promise<UserRow> {
    return this.db.transaction(async (trx) => {
      const user = await trx('users').where({ id: userId }).forUpdate().first();
      if (!user) throw new Error('User not found');

      const newBalance = user.credits + amount;
      await trx('users').where({ id: userId }).update({
        credits: newBalance,
        updated_at: new Date(),
      });

      await trx('credit_transactions').insert({
        user_id: userId,
        amount,
        balance_after: newBalance,
        reason: 'credit_purchase',
        stripe_payment_intent_id: stripePaymentIntentId,
      });

      return { ...user, credits: newBalance };
    });
  }
}
