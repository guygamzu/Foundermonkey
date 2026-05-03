'use client';

import { useEffect } from 'react';

export default function SetupError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[SetupError]', error);
  }, [error]);

  const isMissingDocument =
    error.message.toLowerCase().includes('object can not be found') ||
    error.message.toLowerCase().includes('not available');

  if (isMissingDocument) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Document not available</h2>
          <p>This document is no longer available. If this is unexpected, please contact support.</p>
          <a
            href="mailto:support@lapen.ai"
            style={{
              display: 'inline-block', padding: '10px 24px', background: 'var(--primary)',
              color: 'white', borderRadius: 999, textDecoration: 'none', fontWeight: 600,
              fontSize: '0.875rem', marginTop: 12,
            }}
          >
            Contact support
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="message-page">
      <div className="message-card">
        <h2>Something went wrong</h2>
        <p>{error.message || 'Failed to load the setup page.'}</p>
        <button className="btn btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
