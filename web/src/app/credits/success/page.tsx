export default function CreditsPurchaseSuccess() {
  return (
    <div className="message-page">
      <div className="message-card">
        <h2 style={{ color: 'var(--success)' }}>Payment Successful!</h2>
        <p>
          Your credits have been added to your account. You can now reply &ldquo;Y&rdquo; to your
          pending email to proceed with your signature request.
        </p>
      </div>
    </div>
  );
}
