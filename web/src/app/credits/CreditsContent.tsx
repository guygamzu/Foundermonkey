'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const PACKAGES = [
  { index: 0, credits: 10, price: '$15', label: '10 Credits' },
  { index: 1, credits: 25, price: '$25', label: '25 Credits', popular: true },
  { index: 2, credits: 100, price: '$75', label: '100 Credits' },
];

export default function CreditsContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get('user');
  const [credits, setCredits] = useState<number | null>(null);
  const [selectedPackage, setSelectedPackage] = useState(1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) return;
    fetch(`${API_URL}/api/payments/credits/${userId}`)
      .then((r) => r.json())
      .then((data) => setCredits(data.credits))
      .catch(() => {});
  }, [userId]);

  const handlePurchase = async () => {
    if (!userId || loading) return;
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/payments/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, packageIndex: selectedPackage }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      alert('Failed to start checkout. Please try again.');
    } finally {
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
    </div>
  );
}
