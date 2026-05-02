'use client';

export default function PreviewError({
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
        <p>{error.message || 'Failed to load the preview.'}</p>
        <button className="btn btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
