export interface User {
  id: string;
  email: string;
  name?: string;
  credits: number;
  isProvisional: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreditTransaction {
  id: string;
  userId: string;
  amount: number; // positive = purchase, negative = usage
  balanceAfter: number;
  reason: string;
  documentRequestId?: string;
  stripePaymentIntentId?: string;
  createdAt: string;
}

export const CREDIT_PACKAGES = [
  { credits: 10, priceUsd: 499, label: '10 Credits - $4.99' },
  { credits: 25, priceUsd: 999, label: '25 Credits - $9.99 (Most Popular)', popular: true },
  { credits: 50, priceUsd: 1599, label: '50 Credits - $15.99' },
  { credits: 100, priceUsd: 2499, label: '100 Credits - $24.99' },
] as const;

export const FREE_CREDITS = 5;
