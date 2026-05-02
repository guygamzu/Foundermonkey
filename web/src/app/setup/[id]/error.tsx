'use client';

export default function SetupError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
