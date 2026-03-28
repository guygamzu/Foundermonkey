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
  { credits: 10, priceUsd: 1500, label: '10 Credits - $15' },
  { credits: 25, priceUsd: 2500, label: '25 Credits - $25 (Most Popular)', popular: true },
  { credits: 100, priceUsd: 7500, label: '100 Credits - $75' },
] as const;

export const FREE_CREDITS = 5;
