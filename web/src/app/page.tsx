import type { Metadata } from 'next';
import { ScrollLink } from '../components/ScrollLink';

import { AnimatedSection } from '../components/AnimatedSection';

const SET_MAILTO_BODY = encodeURIComponent(
  '[INSTRUCTIONS - delete before sending]\n\n- Add signer emails to the TO field\n- Attach your PDF\n- Hit send\n- Lapen will email you a link to place signature fields on the PDF\n- Once you place the fields and confirm, your signers receive their signing links\n\n---\n\nHi,\n\nThe attached PDF will need your signature. You will receive a follow-up email from Lapen with a secure signing link once the document is ready.\n\nThank you'
);
const SET_MAILTO = `mailto:?cc=set@lapen.ai&subject=${encodeURIComponent('Document for signature')}&body=${SET_MAILTO_BODY}`;

export const metadata: Metadata = {
  title: 'La Pen. — A quieter way to get things signed',
  description: 'Email a PDF — we\'ll take it from there. No signup, no dashboard, no app. AI-powered e-signatures for freelancers and small studios.',
};

const MAILTO_BODY = encodeURIComponent(
  '[INSTRUCTIONS - delete before sending]\n\n- Add signer emails to the TO field\n- Attach your PDF\n- Hit send\n\n---\n\nHi,\n\nThe attached PDF is for your signature. You will receive a follow-up email from Lapen shortly with a secure signing link.\n\nThank you'
);
const SIGN_MAILTO = `mailto:?cc=sign@lapen.ai&subject=${encodeURIComponent('Document for signature')}&body=${MAILTO_BODY}`;

export default function Home() {
  return (
    <main className="lp">
      {/* Nav */}
      <nav className="lp-nav">
        <div className="lp-nav-inner">
          <ScrollLink href="#" className="lp-logo lapen-mark">La <span className="pen">Pen</span><span className="seal">.</span></ScrollLink>
          <div className="lp-nav-links">
            <ScrollLink href="#how">How it works</ScrollLink>
            <ScrollLink href="#features">Features</ScrollLink>
            <ScrollLink href="#pricing">Pricing</ScrollLink>
          </div>
          <a href={SIGN_MAILTO} className="lp-nav-cta">Try it</a>
        </div>
      </nav>

      {/* Hero */}
      <section className="lp-hero lp-panel" style={{ zIndex: 0 }}>
        <div className="lp-hero-badge">a quieter way to get things signed</div>
        <h1 className="lp-hero-h1">
          Email a&nbsp;PDF.<br />
          <em>We&rsquo;ll take it</em><br />
          <span className="lp-underline">from there</span><span className="lp-seal">.</span>
        </h1>
        <p className="lp-hero-p">
          An e-signature service for freelancers and small studios.
          No dashboard. No app. Just email your PDF, CC <strong style={{ fontWeight: 500 }}>sign@lapen.ai</strong>,
          and a small, careful hand takes it the rest of the way.
        </p>
        <div className="lp-hero-actions">
          <a href={SIGN_MAILTO} className="lp-btn lp-btn-primary">
            Send your first document
          </a>
          <ScrollLink href="#how" className="lp-btn lp-btn-ghost">
            See how it works
          </ScrollLink>
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

      {/* How it works */}
      <section className="lp-section lp-panel" id="how" style={{ zIndex: 2 }}>
        <div className="lp-section-inner">
          <div className="lp-section-label">HOW IT WORKS</div>
          <h2 className="lp-section-h2">One email. That&apos;s it.</h2>
          <p className="lp-section-sub">Get your first document signed in under a minute.</p>

          <AnimatedSection className="lp-how-animated">
            <div className="lp-flow">
              <div className="lp-flow-node">
                <div className="lp-flow-circle">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="7" width="26" height="18" rx="2" />
                    <path d="M3 9l13 9 13-9" />
                  </svg>
                </div>
                <span className="lp-flow-text">You send</span>
              </div>
              <div className="lp-flow-connector" />
              <div className="lp-flow-node">
                <div className="lp-flow-circle">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M16 4v24M4 16h24M8 8l16 16M24 8L8 24" />
                  </svg>
                </div>
                <span className="lp-flow-text">We handle it</span>
              </div>
              <div className="lp-flow-connector" />
              <div className="lp-flow-node">
                <div className="lp-flow-circle">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 16l5 5 11-11" />
                  </svg>
                </div>
                <span className="lp-flow-text">They sign</span>
              </div>
            </div>

            <div className="lp-steps">
              <div className="lp-step">
                <div className="lp-step-num">01</div>
                <h3>Email your PDF + signers</h3>
                <p>
                  Add your signers to TO, CC <strong>sign@lapen.ai</strong>.
                  Attach the PDF. Hit send.
                </p>
              </div>
              <div className="lp-step">
                <div className="lp-step-num">02</div>
                <h3>Signers get instant links</h3>
                <p>
                  Lapen sends each signer a personalized signing link with an AI summary
                  and an assistant to answer questions about the document.
                </p>
              </div>
              <div className="lp-step">
                <div className="lp-step-num">03</div>
                <h3>Done. Everyone signs.</h3>
                <p>
                  Signers place signatures, text, dates, and checkboxes anywhere
                  on the document. You get notified when it&apos;s complete.
                </p>
              </div>
            </div>
          </AnimatedSection>

          <div style={{ textAlign: 'center', marginTop: 40, padding: '24px', background: 'var(--gray-50)', borderRadius: 12, border: '1px solid var(--gray-200)' }}>
            <p style={{ fontSize: '0.95rem', color: 'var(--gray-700)', margin: '0 0 4px', fontWeight: 600 }}>
              Need to place fields before sending?
            </p>
            <p style={{ fontSize: '0.875rem', color: 'var(--gray-500)', margin: 0 }}>
              Email <strong style={{ color: 'var(--primary)' }}>set@lapen.ai</strong> instead &mdash;
              you&apos;ll get a link to visually place signature fields per signer on the PDF before sending.
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="lp-section lp-section-alt lp-panel" id="features" style={{ zIndex: 3 }}>
        <div className="lp-section-inner">
          <div className="lp-section-label">CAPABILITIES</div>
          <h2 className="lp-section-h2">Everything you need, nothing you don&apos;t</h2>
          <div className="lp-features">
            <div className="lp-feature">
              <div className="lp-feature-icon">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--olive)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 3v22M3 14h22M7 7l14 14M21 7L7 21" />
                  <circle cx="14" cy="14" r="4" />
                </svg>
              </div>
              <h3>AI document analysis</h3>
              <p>Instant summary, smart field detection, and an AI assistant that answers questions about the document.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--olive)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="24" height="16" rx="2" />
                  <path d="M2 8l12 8 12-8" />
                </svg>
              </div>
              <h3>Email-first workflow</h3>
              <p>No app to download, no account to create. One email to <strong>sign@lapen.ai</strong> with your signers &mdash; that&apos;s the entire flow.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--olive)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3l-2 6h-4l3.5 3-1.5 5 4-3 4 3-1.5-5L22 9h-4L16 3z" />
                  <rect x="3" y="4" width="8" height="21" rx="1" />
                  <path d="M5 8h4M5 11h4M5 14h3" />
                </svg>
              </div>
              <h3>Free-form or placed fields</h3>
              <p>Let signers place fields freely, or use <strong>set@lapen.ai</strong> to visually assign signature, text, and date fields per signer before sending.</p>
              <a href={SET_MAILTO} className="lp-btn lp-btn-outline lp-btn-sm">Try placed fields</a>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--olive)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="18" height="14" rx="2" />
                  <path d="M9 11V7a5 5 0 0 1 10 0v4" />
                  <circle cx="14" cy="18" r="2" />
                  <path d="M14 20v2" />
                </svg>
              </div>
              <h3>Legally binding</h3>
              <p>Compliant with ESIGN Act and eIDAS. Full audit trail and certificate of completion for every document.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--olive)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="7" y="2" width="14" height="24" rx="3" />
                  <path d="M12 22h4" />
                  <path d="M11 6h6" />
                </svg>
              </div>
              <h3>Any device</h3>
              <p>Signers review and sign from their phone, tablet, or computer. Responsive design, zero friction.</p>
            </div>
            <div className="lp-feature">
              <div className="lp-feature-icon">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="var(--olive)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2v8l4-3" />
                  <path d="M14 10l-4-3" />
                  <circle cx="14" cy="20" r="6" />
                  <path d="M14 17v4l2 1" />
                </svg>
              </div>
              <h3>Instant delivery</h3>
              <p>Signing links are sent immediately. Real-time notifications when each person signs.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="lp-section lp-section-alt lp-panel" id="pricing" style={{ zIndex: 4 }}>
        <div className="lp-section-inner">
          <div className="lp-section-label">PRICING</div>
          <h2 className="lp-section-h2">Signatures for <em>everyone</em></h2>
          <p className="lp-section-sub">
            No subscriptions. No per-seat pricing. Just credits that work when you need them.
          </p>
          <div className="lp-credit-cards">
            <div className="lp-credit-card">
              <span className="lp-credit-num">1</span>
              <h3>1 credit = 1 signature</h3>
              <p>Each request uses 1 credit per signer. Simple, transparent, predictable.</p>
            </div>
            <div className="lp-credit-card">
              <span className="lp-credit-num">&infin;</span>
              <h3>Credits never expire</h3>
              <p>Buy when you need them, use when you&apos;re ready. No monthly pressure.</p>
            </div>
            <div className="lp-credit-card">
              <span className="lp-credit-num">+3</span>
              <h3>Share and earn</h3>
              <p>When your signers start sending documents, you earn 3 free credits.</p>
            </div>
          </div>
          <p className="lp-credit-start">
            Every account starts with <strong>5 free credits</strong> &mdash; no card required.
          </p>

          <h3 className="lp-pricing-title">Need more? Grab a credit pack.</h3>
          <div className="lp-pricing lp-pricing-compact">
            <div className="lp-price-card">
              <h3>Free</h3>
              <div className="lp-price-amount">$0</div>
              <p className="lp-price-desc">5 credits to start</p>
              <ul>
                <li>All features included</li>
                <li>AI document analysis</li>
                <li>No expiration</li>
              </ul>
              <a href={SIGN_MAILTO} className="lp-btn lp-btn-outline">Get started free</a>
            </div>
            <div className="lp-price-card">
              <h3>Starter</h3>
              <div className="lp-price-amount">$4.99</div>
              <p className="lp-price-desc">10 credits</p>
              <ul>
                <li>All features included</li>
                <li>$0.50 per credit</li>
                <li>No expiration</li>
              </ul>
              <a href={SIGN_MAILTO} className="lp-btn lp-btn-outline">Buy credits</a>
            </div>
            <div className="lp-price-card lp-price-featured">
              <div className="lp-price-tag">MOST POPULAR</div>
              <h3>Pro</h3>
              <div className="lp-price-amount">$9.99</div>
              <p className="lp-price-desc">25 credits</p>
              <ul>
                <li>All features included</li>
                <li>$0.40 per credit</li>
                <li>No expiration</li>
              </ul>
              <a href={SIGN_MAILTO} className="lp-btn lp-btn-primary">Buy credits</a>
            </div>
            <div className="lp-price-card">
              <h3>Business</h3>
              <div className="lp-price-amount">$15.99</div>
              <p className="lp-price-desc">50 credits</p>
              <ul>
                <li>All features included</li>
                <li>$0.32 per credit</li>
                <li>No expiration</li>
              </ul>
              <a href={SIGN_MAILTO} className="lp-btn lp-btn-outline">Buy credits</a>
            </div>
            <div className="lp-price-card">
              <h3>Enterprise</h3>
              <div className="lp-price-amount">$24.99</div>
              <p className="lp-price-desc">100 credits</p>
              <ul>
                <li>All features included</li>
                <li>$0.25 per credit</li>
                <li>No expiration</li>
              </ul>
              <a href={SIGN_MAILTO} className="lp-btn lp-btn-outline">Buy credits</a>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="lp-cta" style={{ zIndex: 5 }}>
        <div className="lp-cta-inner">
          <h2>Ready to get documents signed?</h2>
          <p>No signup. No download. Just send an email.</p>
          <a href={SIGN_MAILTO} className="lp-btn lp-btn-primary lp-btn-lg">
            Send your first document
          </a>
          <span className="lp-cta-email">sign@lapen.ai</span>
        </div>
      </section>

      {/* Footer */}
      <footer className="lp-footer" style={{ zIndex: 6 }}>
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <ScrollLink href="#" className="lp-logo lapen-mark">La <span className="pen">Pen</span><span className="seal">.</span></ScrollLink>
            <p>A quieter way to get things signed.</p>
            <span className="lp-footer-hand">&mdash; a quieter pen.</span>
          </div>
          <div className="lp-footer-links">
            <ScrollLink href="#how">How it works</ScrollLink>
            <ScrollLink href="#features">Features</ScrollLink>
            <ScrollLink href="#pricing">Pricing</ScrollLink>
            <a href="mailto:support@lapen.ai">Contact</a>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <p>&copy; 2026 Lapen. All rights reserved.</p>
        </div>
      </footer>
    </main>
  );
}
