import { Knex } from 'knex';
import { randomBytes } from 'crypto';
import { FREE_CREDITS, REFERRAL_BONUS, MONTHLY_REFERRAL_CAP } from '@lapen/shared';
import { notifyAdmin } from '../routes/admin.js';

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.de', 'grr.la',
  'guerrillamailblock.com', 'tempmail.com', 'throwaway.email',
  'temp-mail.org', 'fakeinbox.com', 'sharklasers.com', 'guerrillamail.info',
  'guerrillamail.biz', 'guerrillamail.net', 'yopmail.com', 'yopmail.fr',
  'trashmail.com', 'trashmail.me', 'trashmail.net', 'dispostable.com',
  'mailnesia.com', 'maildrop.cc', 'discard.email', 'tempail.com',
  'tempr.email', 'temp-mail.io', '10minutemail.com', '10minutemail.net',
  'minutemail.com', 'emailondeck.com', 'mailcatch.com', 'inboxbear.com',
  'mohmal.com', 'getnada.com', 'tmpmail.net', 'tmpmail.org',
]);

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  credits: number;
  is_provisional: boolean;
  referral_code: string | null;
  access_token: string | null;
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
    const accessToken = randomBytes(32).toString('base64url');
    const [user] = await this.db('users')
      .insert({
        email: email.toLowerCase(),
        name,
        credits: FREE_CREDITS,
        is_provisional: true,
        referral_code: referralCode,
        access_token: accessToken,
      })
      .returning('*');

    // Fire-and-forget admin notification
    notifyAdmin('new_user', { email: email.toLowerCase(), name });

    return user;
  }

  async findByReferralCode(code: string): Promise<UserRow | undefined> {
    return this.db('users').where({ referral_code: code.toUpperCase() }).first();
  }

  async findByAccessToken(token: string): Promise<UserRow | undefined> {
    return this.db('users').where({ access_token: token }).first();
  }

  async ensureAccessToken(userId: string): Promise<string> {
    const user = await this.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.access_token) return user.access_token;
    const token = randomBytes(32).toString('base64url');
    await this.db('users').where({ id: userId }).update({ access_token: token });
    return token;
  }

  async autoRedeemReferralFromSigningHistory(
    newSenderId: string,
    newSenderEmail: string,
  ): Promise<{ referrerId: string; referrerCredits: number } | null> {
    const domain = newSenderEmail.split('@')[1]?.toLowerCase();
    if (domain && DISPOSABLE_EMAIL_DOMAINS.has(domain)) return null;

    const priorSend = await this.db('document_requests')
      .where({ sender_id: newSenderId })
      .first();
    if (priorSend) return null;

    const earliestSigned = await this.db('signers')
      .join('document_requests', 'signers.document_request_id', 'document_requests.id')
      .whereRaw('LOWER(signers.email) = LOWER(?)', [newSenderEmail])
      .whereNotNull('signers.signed_at')
      .orderBy('signers.signed_at', 'asc')
      .select('document_requests.sender_id as sender_id')
      .first();
    if (!earliestSigned?.sender_id) return null;
    if (earliestSigned.sender_id === newSenderId) return null;

    try {
      const result = await this.redeemReferral(earliestSigned.sender_id, newSenderId);
      return { referrerId: earliestSigned.sender_id, referrerCredits: result.referrerCredits };
    } catch {
      return null;
    }
  }

  async redeemReferral(referrerId: string, referredId: string): Promise<{ referrerCredits: number }> {
    return this.db.transaction(async (trx) => {
      if (referrerId === referredId) throw new Error('Cannot refer yourself');

      const existing = await trx('referrals')
        .where({ referrer_id: referrerId, referred_id: referredId })
        .first();
      if (existing) throw new Error('Referral already redeemed');

      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const monthlyEarned = await trx('referrals')
        .where({ referrer_id: referrerId })
        .where('created_at', '>=', monthStart)
        .sum('credits_awarded as total')
        .first();
      if ((monthlyEarned?.total || 0) >= MONTHLY_REFERRAL_CAP) {
        throw new Error('Monthly referral cap reached');
      }

      await trx('users').where({ id: referrerId }).increment('credits', REFERRAL_BONUS);

      await trx('referrals').insert({
        referrer_id: referrerId,
        referred_id: referredId,
        credits_awarded: REFERRAL_BONUS,
      });

      const referrer = await trx('users').where({ id: referrerId }).first();

      await trx('credit_transactions').insert({
        user_id: referrerId,
        amount: REFERRAL_BONUS,
        balance_after: referrer.credits,
        reason: 'referral_bonus',
      });

      return { referrerCredits: referrer.credits };
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
