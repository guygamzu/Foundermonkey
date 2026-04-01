'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function SuccessContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [credits, setCredits] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!sessionId) {
      setStatus('success'); // No session ID, just show generic success
      return;
    }

    const verify = async () => {
      try {
        const res = await fetch(`${API_URL}/api/payments/verify-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        const data = await res.json();
        if (res.ok) {
          setCredits(data.credits);
          setStatus('success');
        } else {
          setErrorMsg(data.error || 'Could not verify payment');
          setStatus('error');
        }
      } catch {
        setErrorMsg('Network error — please refresh the page to try again.');
        setStatus('error');
      }
    };

    verify();
  }, [sessionId]);

  if (status === 'verifying') {
    return (
      <div className="message-page">
        <div className="message-card">
          <div className="spinner" style={{ margin: '0 auto 16px' }} />
          <p>Verifying your payment...</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2 style={{ color: '#dc2626' }}>Payment Verification Issue</h2>
          <p>{errorMsg}</p>
          <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 12 }}>
            If you were charged, your credits may take a moment to appear.
            Try refreshing this page or replying to your email to proceed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-page">
      <div className="message-card">
        <h2 style={{ color: 'var(--success)' }}>Payment Successful!</h2>
        {credits !== null && (
          <p style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--primary)', margin: '12px 0' }}>
            You now have {credits} credit{credits !== 1 ? 's' : ''}
          </p>
        )}
        <p>
          Reply to your pending email with the signee email addresses to continue
          with your signature request.
        </p>
      </div>
    </div>
  );
}

export default function CreditsPurchaseSuccess() {
  return (
    <Suspense fallback={
      <div className="message-page">
        <div className="message-card">
          <div className="spinner" style={{ margin: '0 auto 16px' }} />
          <p>Loading...</p>
        </div>
      </div>
    }>
      <SuccessContent />
    </Suspense>
  );
}
