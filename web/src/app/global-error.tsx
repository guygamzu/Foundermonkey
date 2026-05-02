'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        margin: 0,
        background: '#efe6ce',
        color: '#1f1a14',
      }}>
        <div style={{
          textAlign: 'center',
          maxWidth: 420,
          padding: 40,
          background: '#f4ecd6',
          borderRadius: 16,
          border: '1px solid #c9b890',
        }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: '#4a4338', fontSize: '0.9rem', marginBottom: 24 }}>
            {error.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={reset}
            style={{
              padding: '10px 24px',
              background: '#1f1a14',
              color: '#f4ecd6',
              border: 'none',
              borderRadius: 999,
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
