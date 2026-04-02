import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Lapen - E-Signatures as Easy as Sending an Email',
  description: 'No signup. No app. Just email your PDF and Lapen handles the rest. AI-powered e-signatures with free-form signing tools.',
};

export default function Home() {
  return (
    <main>
      {/* Hero */}
      <section className="landing-hero">
        <nav className="landing-nav">
          <span className="landing-logo">Lapen</span>
          <a href="#how-it-works" className="landing-nav-link">How it works</a>
        </nav>
        <div className="landing-hero-content">
          <h1 className="landing-hero-title">
            E-signatures as easy as<br />sending an email
          </h1>
          <p className="landing-hero-sub">
            No signup. No app to install. Just email your PDF and Lapen handles the rest.
            AI-powered document analysis, free-form signing tools, and legally binding signatures.
          </p>
          <div className="landing-hero-cta">
            <a href="mailto:guygamzu@lapen.ai" className="landing-btn-primary">
              Send a document now
            </a>
            <p className="landing-hero-hint">
              Email your PDF to <strong>guygamzu@lapen.ai</strong> &mdash; 5 free signatures included
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="landing-section" id="how-it-works">
        <h2 className="landing-section-title">How it works</h2>
        <p className="landing-section-sub">Three steps. No account needed. Takes under a minute.</p>
        <div className="landing-steps-grid">
          <div className="landing-step-card">
            <div className="landing-step-icon">1</div>
            <h3>Email your document</h3>
            <p>Send any PDF to <strong>guygamzu@lapen.ai</strong>. Our AI instantly analyzes it and replies with a summary.</p>
          </div>
          <div className="landing-step-card">
            <div className="landing-step-icon">2</div>
            <h3>Add your signees</h3>
            <p>Reply with the email addresses of people who need to sign. Lapen sends each one a personalized signing link.</p>
          </div>
          <div className="landing-step-card">
            <div className="landing-step-icon">3</div>
            <h3>They sign, you're done</h3>
            <p>Signees use free-form tools to place signatures, text, dates, and checkboxes anywhere on the document.</p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="landing-section landing-section-alt">
        <h2 className="landing-section-title">Why Lapen</h2>
        <div className="landing-features-grid">
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x2728;</div>
            <h3>AI-powered</h3>
            <p>Instant document summary, smart field detection, and an AI assistant to answer questions about the document.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x2709;</div>
            <h3>Email-first</h3>
            <p>No app to download, no account to create. Works entirely through email &mdash; the tool everyone already uses.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x270D;</div>
            <h3>Free-form signing</h3>
            <p>Signees place signatures, text, dates, and checkboxes anywhere they want. No rigid fields or templates.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x1F512;</div>
            <h3>Legally binding</h3>
            <p>Compliant with ESIGN Act and eIDAS. Full audit trail and certificate of completion for every document.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x1F4F1;</div>
            <h3>Works on any device</h3>
            <p>Signees can review and sign from their phone, tablet, or computer. No downloads required.</p>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon">&#x26A1;</div>
            <h3>Instant delivery</h3>
            <p>Signing links are sent immediately. Get notified the moment each person signs.</p>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="landing-section">
        <h2 className="landing-section-title">Simple pricing</h2>
        <p className="landing-section-sub">Start with 5 free credits. Each signature request uses 1 credit per signee.</p>
        <div className="landing-pricing-grid">
          <div className="landing-price-card">
            <h3>Starter</h3>
            <div className="landing-price">Free</div>
            <p>5 signature credits</p>
            <ul>
              <li>All features included</li>
              <li>AI document analysis</li>
              <li>No expiration</li>
            </ul>
          </div>
          <div className="landing-price-card landing-price-popular">
            <div className="landing-price-badge">Most Popular</div>
            <h3>Pro</h3>
            <div className="landing-price">$25</div>
            <p>25 signature credits</p>
            <ul>
              <li>Everything in Starter</li>
              <li>Best value per credit</li>
              <li>Priority delivery</li>
            </ul>
          </div>
          <div className="landing-price-card">
            <h3>Business</h3>
            <div className="landing-price">$75</div>
            <p>100 signature credits</p>
            <ul>
              <li>Everything in Pro</li>
              <li>Lowest cost per credit</li>
              <li>Bulk sending</li>
            </ul>
          </div>
        </div>
        <p className="landing-referral-note">
          Refer a friend and you both get <strong>5 free credits</strong>.
        </p>
      </section>

      {/* Final CTA */}
      <section className="landing-section landing-cta-section">
        <h2 className="landing-cta-title">Ready to get documents signed?</h2>
        <p className="landing-cta-sub">No signup needed. Just send an email.</p>
        <a href="mailto:guygamzu@lapen.ai" className="landing-btn-primary landing-btn-lg">
          Email your first document
        </a>
        <p className="landing-cta-hint">guygamzu@lapen.ai</p>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <span className="landing-logo">Lapen</span>
        <p>AI-powered e-signatures &middot; Simple, fast, and secure</p>
      </footer>
    </main>
  );
}
