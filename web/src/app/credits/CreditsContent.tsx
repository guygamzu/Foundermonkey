'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const PACKAGES = [
  { index: 0, credits: 10, price: '$4.99', label: '10 Credits' },
  { index: 1, credits: 25, price: '$9.99', label: '25 Credits', popular: true },
  { index: 2, credits: 50, price: '$15.99', label: '50 Credits' },
  { index: 3, credits: 100, price: '$24.99', label: '100 Credits' },
];

export default function CreditsContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get('user');
  const [credits, setCredits] = useState<number | null>(null);
  const [selectedPackage, setSelectedPackage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referralInput, setReferralInput] = useState('');
  const [referralLoading, setReferralLoading] = useState(false);
  const [referralMessage, setReferralMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!userId) return;
    fetch(`${API_URL}/api/payments/credits/${userId}`)
      .then((r) => r.json())
      .then((data) => {
        setCredits(data.credits);
        if (data.referralCode) setReferralCode(data.referralCode);
      })
      .catch(() => {});
  }, [userId]);

  const handleReferral = async () => {
    if (!userId || !referralInput.trim() || referralLoading) return;
    setReferralLoading(true);
    setReferralMessage(null);
    try {
      const res = await fetch(`${API_URL}/api/payments/referral`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, referralCode: referralInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setReferralMessage({ type: 'error', text: data.error || 'Failed to redeem code' });
      } else {
        setCredits(data.credits);
        setReferralMessage({ type: 'success', text: '5 bonus credits added! Your friend got 5 too.' });
        setReferralInput('');
      }
    } catch {
      setReferralMessage({ type: 'error', text: 'Something went wrong. Please try again.' });
    } finally {
      setReferralLoading(false);
    }
  };

  const handlePurchase = async () => {
    if (!userId || loading) return;
    setLoading(true);
    setPurchaseError(null);

    try {
      const res = await fetch(`${API_URL}/api/payments/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, packageIndex: selectedPackage }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setPurchaseError(data.error || 'Could not start checkout. Please try again.');
        setLoading(false);
      }
    } catch {
      setPurchaseError('Network error — please check your connection and try again.');
      setLoading(false);
    }
  };

  return (
    <div className="status-page">
      <h1 style={{ marginBottom: 8 }}>Lapen Credits</h1>
      {credits !== null && (
        <p style={{ color: 'var(--gray-500)', marginBottom: 24 }}>
          You have <strong>{credits}</strong> credit{credits !== 1 ? 's' : ''} remaining.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {PACKAGES.map((pkg) => (
          <label
            key={pkg.index}
            className="status-card"
            style={{
              cursor: 'pointer',
              border: selectedPackage === pkg.index ? '2px solid var(--primary)' : '2px solid transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <input
              type="radio"
              name="package"
              checked={selectedPackage === pkg.index}
              onChange={() => setSelectedPackage(pkg.index)}
              style={{ width: 20, height: 20 }}
            />
            <div style={{ flex: 1 }}>
              <strong>{pkg.label} - {pkg.price}</strong>
              {pkg.popular && (
                <span className="status-badge sent" style={{ marginLeft: 8 }}>Most Popular</span>
              )}
            </div>
          </label>
        ))}
      </div>

      <button
        className="btn btn-primary btn-block"
        style={{ marginTop: 24 }}
        onClick={handlePurchase}
        disabled={loading || !userId}
      >
        {loading ? 'Processing...' : 'Pay with Card'}
      </button>
      {purchaseError && (
        <p style={{ color: '#dc2626', fontSize: '0.85rem', marginTop: 8, textAlign: 'center' }}>
          {purchaseError}
        </p>
      )}

      {/* Referral section */}
      <div style={{
        marginTop: 32, padding: 20, background: '#fef3c7', borderRadius: 12,
        border: '1px solid #fbbf24',
      }}>
        <h3 style={{ margin: '0 0 4px', fontSize: '1rem', color: '#92400e' }}>
          Get 5 free credits
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: '#78350f', lineHeight: 1.5 }}>
          Have a referral code from a friend? Enter it below &mdash; you both get <strong>5 free credits</strong>.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={referralInput}
            onChange={(e) => setReferralInput(e.target.value.toUpperCase())}
            placeholder="Enter code"
            maxLength={8}
            style={{
              flex: 1, padding: '10px 12px', border: '1px solid #fbbf24', borderRadius: 8,
              fontSize: '1rem', fontFamily: 'monospace', letterSpacing: 2,
              textTransform: 'uppercase', background: 'white',
            }}
          />
          <button
            className="btn btn-primary"
            style={{ whiteSpace: 'nowrap' }}
            onClick={handleReferral}
            disabled={referralLoading || !referralInput.trim()}
          >
            {referralLoading ? '...' : 'Redeem'}
          </button>
        </div>
        {referralMessage && (
          <p style={{
            margin: '8px 0 0', fontSize: '0.85rem',
            color: referralMessage.type === 'success' ? '#16a34a' : '#dc2626',
          }}>
            {referralMessage.text}
          </p>
        )}
      </div>

      {/* Your referral code */}
      {referralCode && (
        <div style={{
          marginTop: 16, padding: 16, background: '#f0f7ff', borderRadius: 12,
          border: '1px solid #bfdbfe', textAlign: 'center',
        }}>
          <p style={{ margin: '0 0 6px', fontSize: '0.8rem', color: '#6b7280' }}>
            Share your code with friends &mdash; you both get 5 credits
          </p>
          <span style={{
            fontSize: '1.5rem', fontWeight: 800, color: '#1e40af',
            letterSpacing: 3, fontFamily: 'monospace',
          }}>
            {referralCode}
          </span>
        </div>
      )}
    </div>
  );
}
