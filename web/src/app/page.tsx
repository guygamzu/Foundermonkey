import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Lapen - E-Signatures as Easy as Sending an Email',
  description: 'No signup. No app. Just email your PDF and Lapen handles the rest. AI-powered e-signatures with free-form signing tools.',
};

export default function Home() {
  return (
    <main className="lp">
      {/* Nav */}
      <nav className="lp-nav">
        <div className="lp-nav-inner">
          <span className="lp-logo">Lapen</span>
          <div className="lp-nav-links">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
          </div>
          <a href="mailto:guygamzu@lapen.ai" className="lp-nav-cta">Get Started</a>
        </div>
      </nav>

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-badge">AI-POWERED E-SIGNATURES</div>
        <h1 className="lp-hero-h1">
          Get documents signed<br />
          <span className="lp-gradient-text">as easy as sending an email</span>
        </h1>
        <p className="lp-hero-p">
          No signup. No app. Email your PDF to Lapen and we handle the rest &mdash;
          AI-powered analysis, free-form signing tools, and legally binding signatures.
        </p>
        <div className="lp-hero-actions">
          <a href="mailto:guygamzu@lapen.ai" className="lp-btn lp-btn-primary">
            Send your first document
          </a>
          <a href="#how" className="lp-btn lp-btn-ghost">
            See how it works
          </a>
        </div>
        <div className="lp-hero-stats">
          <div className="lp-stat">
            <span className="lp-stat-num">98%</span>
            <span className="lp-stat-label">AI accuracy</span>
          </div>
          <div className="lp-stat-divider" />
          <div className="lp-stat">
            <span className="lp-stat-num">&lt;2 min</span>
            <span className="lp-stat-label">Average signing time</span>
          </div>
          <div className="lp-stat-divider" />
          <div className="lp-stat">
            <span className="lp-stat-num">5 free</span>
            <span className="lp-stat-label">Credits to start</span>
          </div>
        </div>
      </section>

      {/* How it works — light */}
      <section className="lp-section lp-section-light" id="how">
        <div className="lp-section-inner">
          <div className="lp-section-label">HOW IT WORKS</div>
          <h2 className="lp-section-h2">Three steps. No account needed.</h2>
          <p className="lp-section-sub">Get your first document signed in under a minute.</p>
          <div className="lp-steps">
            <div className="lp-step">
              <div className="lp-step-num">01</div>
              <h3>Email your document</h3>
              <p>
                Send any PDF to <strong>guygamzu@lapen.ai</strong>. Our AI instantly
                analyzes it and replies with a smart summary.
              </p>
            </div>
            <div className="lp-step">
              <div className="lp-step-num">02</div>
              <h3>Reply with signees</h3>
              <p>
                Reply with the email addresses of people who need to sign.
                Lapen sends each one a personalized, branded signing link.
              </p>
            </div>
            <div className="lp-step">
              <div className="lp-step-num">03</div>
              <h3>Done. Everyone signs.</h3>
              <p>
                Signees place signatures, text, dates, and checkboxes anywhere
                on the document. You get notified when it&apos;s complete.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="lp-section lp-section-dark" id="features">
        <div className="lp-section-inner">
          <div className="lp-section-label">CAPABILITIES</div>
          <h2 className="lp-section-h2">Everything you need, nothing you don&apos;t</h2>
          <div className="lp-features">
            <div className="lp-feature">
              <div className="lp-feature-icon">&#x2728;</div>
              <h3>AI document analysis</h3>
              <p>Instant summary, smart field detection, and an AI assistant that answers questions about the document.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">&#x2709;&#xFE0F;</div>
              <h3>Email-first workflow</h3>
              <p>No app to download, no account to create. The entire flow works through email &mdash; the tool everyone already uses.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">&#x270D;&#xFE0F;</div>
              <h3>Free-form signing</h3>
              <p>Signees drag and place signatures, text, dates, and checkboxes anywhere. No rigid templates or pre-set fields.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">&#x1F512;</div>
              <h3>Legally binding</h3>
              <p>Compliant with ESIGN Act and eIDAS. Full audit trail and certificate of completion for every document.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">&#x1F4F1;</div>
              <h3>Any device</h3>
              <p>Signers review and sign from their phone, tablet, or computer. Responsive design, zero friction.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">&#x26A1;</div>
              <h3>Instant delivery</h3>
              <p>Signing links are sent immediately. Real-time notifications when each person signs.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing — light */}
      <section className="lp-section lp-section-light" id="pricing">
        <div className="lp-section-inner">
          <div className="lp-section-label">PRICING</div>
          <h2 className="lp-section-h2">Simple, transparent pricing</h2>
          <p className="lp-section-sub">
            Start free. Each signature request uses 1 credit per signee.
          </p>
          <div className="lp-pricing">
            <div className="lp-price-card">
              <h3>Starter</h3>
              <div className="lp-price-amount">Free</div>
              <p className="lp-price-desc">5 signature credits</p>
              <ul>
                <li>All features included</li>
                <li>AI document analysis</li>
                <li>No expiration</li>
              </ul>
              <a href="mailto:guygamzu@lapen.ai" className="lp-btn lp-btn-outline">Get started free</a>
            </div>
            <div className="lp-price-card lp-price-featured">
              <div className="lp-price-tag">BEST VALUE</div>
              <h3>Pro</h3>
              <div className="lp-price-amount">$25</div>
              <p className="lp-price-desc">25 signature credits</p>
              <ul>
                <li>Everything in Starter</li>
                <li>$1 per credit</li>
                <li>Priority delivery</li>
              </ul>
              <a href="mailto:guygamzu@lapen.ai" className="lp-btn lp-btn-primary">Get started</a>
            </div>
            <div className="lp-price-card">
              <h3>Business</h3>
              <div className="lp-price-amount">$75</div>
              <p className="lp-price-desc">100 signature credits</p>
              <ul>
                <li>Everything in Pro</li>
                <li>$0.75 per credit</li>
                <li>Bulk sending</li>
              </ul>
              <a href="mailto:guygamzu@lapen.ai" className="lp-btn lp-btn-outline">Get started</a>
            </div>
          </div>
          <p className="lp-referral">
            Refer a friend &mdash; you both get <strong>5 free credits</strong>
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="lp-cta">
        <div className="lp-cta-inner">
          <h2>Ready to get documents signed?</h2>
          <p>No signup. No download. Just send an email.</p>
          <a href="mailto:guygamzu@lapen.ai" className="lp-btn lp-btn-primary lp-btn-lg">
            Send your first document
          </a>
          <span className="lp-cta-email">guygamzu@lapen.ai</span>
        </div>
      </section>

      {/* Footer */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <span className="lp-logo">Lapen</span>
            <p>AI-powered e-signatures.<br />Simple, fast, and secure.</p>
          </div>
          <div className="lp-footer-links">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="mailto:guygamzu@lapen.ai">Contact</a>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <p>&copy; 2026 Lapen. All rights reserved.</p>
        </div>
      </footer>
    </main>
  );
}
