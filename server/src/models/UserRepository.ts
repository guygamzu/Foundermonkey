import { Knex } from 'knex';
import { FREE_CREDITS } from '@lapen/shared';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  credits: number;
  is_provisional: boolean;
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
    if (existing) return existing;

    const [user] = await this.db('users')
      .insert({
        email: email.toLowerCase(),
        name,
        credits: FREE_CREDITS,
        is_provisional: true,
      })
      .returning('*');
    return user;
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
