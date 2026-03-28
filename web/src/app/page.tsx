export default function Home() {
  return (
    <main className="landing">
      <div className="landing-container">
        <h1 className="landing-title">Lapen</h1>
        <p className="landing-subtitle">AI-powered e-signatures, as easy as sending an email</p>
        <div className="landing-cta">
          <p>Send a document to <strong>agent@lapen.com</strong> to get started.</p>
          <p className="landing-hint">No signup required. 5 free signatures included.</p>
        </div>
        <div className="landing-steps">
          <div className="step">
            <div className="step-number">1</div>
            <h3>Email your document</h3>
            <p>Send a PDF to agent@lapen.com with instructions on who should sign.</p>
          </div>
          <div className="step">
            <div className="step-number">2</div>
            <h3>AI detects fields</h3>
            <p>Our AI analyzes your document and identifies signature fields automatically.</p>
          </div>
          <div className="step">
            <div className="step-number">3</div>
            <h3>Recipients sign anywhere</h3>
            <p>Signers receive a link via email, SMS, or WhatsApp and sign on any device.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
