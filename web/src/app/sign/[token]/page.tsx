'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import SignatureCanvas from '@/components/SignatureCanvas';
import ChatWidget from '@/components/ChatWidget';
import {
  getSigningSession,
  submitFieldValue,
  completeSigning,
  declineSigning,
  type SigningSession,
} from '@/lib/api';

type FieldState = SigningSession['fields'][number];

export default function SigningPage() {
  const params = useParams();
  const token = params.token as string;

  const [session, setSession] = useState<SigningSession | null>(null);
  const [fields, setFields] = useState<FieldState[]>([]);
  const [currentFieldIndex, setCurrentFieldIndex] = useState(0);
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCompleted, setIsCompleted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [isDeclined, setIsDeclined] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = await getSigningSession(token);
        setSession(data);
        setFields(data.fields);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [token]);

  const incompleteFields = fields.filter((f) => f.required && !f.completed);
  const allFieldsCompleted = incompleteFields.length === 0;
  const currentField = incompleteFields[0];

  const handleFieldClick = useCallback((field: FieldState) => {
    if (field.completed) return;
    setActiveFieldId(field.id);

    if (field.type === 'signature' || field.type === 'initial') {
      setShowSignatureModal(true);
    }
  }, []);

  const handleSignatureSave = useCallback(async (value: string) => {
    if (!activeFieldId) return;
    setShowSignatureModal(false);

    try {
      await submitFieldValue(token, activeFieldId, value);
      setFields((prev) =>
        prev.map((f) =>
          f.id === activeFieldId ? { ...f, value, completed: true } : f,
        ),
      );
    } catch (err: any) {
      setError(err.message);
    }
    setActiveFieldId(null);
  }, [activeFieldId, token]);

  const handleTextFieldSubmit = useCallback(async (fieldId: string, value: string) => {
    try {
      await submitFieldValue(token, fieldId, value);
      setFields((prev) =>
        prev.map((f) =>
          f.id === fieldId ? { ...f, value, completed: true } : f,
        ),
      );
    } catch (err: any) {
      setError(err.message);
    }
  }, [token]);

  const handleComplete = useCallback(async () => {
    if (!consent || isSubmitting) return;
    setIsSubmitting(true);

    try {
      const result = await completeSigning(token);
      setIsCompleted(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  }, [consent, isSubmitting, token]);

  const handleDecline = useCallback(async () => {
    try {
      await declineSigning(token, declineReason);
      setIsDeclined(true);
      setShowDeclineModal(false);
    } catch (err: any) {
      setError(err.message);
    }
  }, [token, declineReason]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading document...</p>
      </div>
    );
  }

  if (error === 'already_signed') {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Already Signed</h2>
          <p>You&apos;ve already signed this document. A copy has been sent to your email.</p>
        </div>
      </div>
    );
  }

  if (error === 'expired') {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Link Expired</h2>
          <p>This signing link has expired. Please contact the sender for a new link.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Error</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (isCompleted) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2 style={{ color: 'var(--success)' }}>Document Signed!</h2>
          <p>Thank you for signing. A completed copy will be sent to your email shortly.</p>
        </div>
      </div>
    );
  }

  if (isDeclined) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Signing Declined</h2>
          <p>You have declined to sign this document. The sender has been notified.</p>
        </div>
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="signing-page">
      {/* Header */}
      <div className="signing-header">
        <span className="logo">Lapen</span>
        <h1>{session.document.fileName}</h1>
        <button
          className="btn btn-danger"
          style={{ padding: '6px 12px', fontSize: '0.75rem', minHeight: 'auto' }}
          onClick={() => setShowDeclineModal(true)}
        >
          Decline
        </button>
      </div>

      {/* Document Viewer */}
      <div className="document-viewer">
        <div className="document-container">
          {/* Document pages with field overlays */}
          {Array.from({ length: session.document.pageCount }, (_, pageIndex) => (
            <div key={pageIndex} className="document-page" style={{ position: 'relative', minHeight: 400, background: 'white', borderBottom: '1px solid var(--gray-200)' }}>
              {/* Page placeholder - in production, render actual PDF pages */}
              <div style={{ padding: 40, color: 'var(--gray-300)', textAlign: 'center', fontSize: '0.875rem' }}>
                Page {pageIndex + 1} of {session.document.pageCount}
              </div>

              {/* Field overlays for this page */}
              {fields
                .filter((f) => f.page === pageIndex + 1)
                .map((field) => (
                  <div
                    key={field.id}
                    className={`field-overlay ${field.completed ? 'completed' : ''} ${activeFieldId === field.id ? 'active' : ''}`}
                    style={{
                      left: `${field.x * 100}%`,
                      top: `${field.y * 100}%`,
                      width: `${field.width * 100}%`,
                      height: `${field.height * 100}%`,
                    }}
                    onClick={() => handleFieldClick(field)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${field.type} field${field.completed ? ' (completed)' : ''}`}
                  >
                    {field.completed ? (
                      <span className="field-label" style={{ color: 'var(--success)' }}>
                        {field.type === 'signature' ? 'Signed' : field.value || 'Done'}
                      </span>
                    ) : (
                      <span className="field-label">
                        {field.type === 'signature' ? 'Click to sign' :
                         field.type === 'initial' ? 'Click to initial' :
                         field.type === 'date' ? 'Click to add date' :
                         'Click to fill'}
                      </span>
                    )}
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Consent & Complete */}
      {allFieldsCompleted && (
        <div className="consent-banner">
          <div className="consent-checkbox">
            <input
              type="checkbox"
              id="consent"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <label htmlFor="consent">
              I agree to sign this document electronically. I understand that my electronic signature
              has the same legal effect as a handwritten signature.
            </label>
          </div>
          <button
            className="btn btn-primary btn-block"
            onClick={handleComplete}
            disabled={!consent || isSubmitting}
          >
            {isSubmitting ? 'Completing...' : 'Finish & Agree'}
          </button>
        </div>
      )}

      {/* Start Signing FAB (when fields remain) */}
      {!allFieldsCompleted && currentField && (
        <button
          className="fab btn btn-primary"
          onClick={() => handleFieldClick(currentField)}
        >
          {currentField.type === 'signature' ? 'Sign Here' :
           currentField.type === 'initial' ? 'Initial Here' :
           `Fill ${currentField.type} field`}
          {` (${incompleteFields.length} remaining)`}
        </button>
      )}

      {/* Signature Modal */}
      {showSignatureModal && (
        <SignatureCanvas
          onSave={handleSignatureSave}
          onCancel={() => { setShowSignatureModal(false); setActiveFieldId(null); }}
        />
      )}

      {/* Decline Modal */}
      {showDeclineModal && (
        <div className="modal-overlay" onClick={() => setShowDeclineModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Decline to Sign</h2>
              <button className="modal-close" onClick={() => setShowDeclineModal(false)}>&times;</button>
            </div>
            <p style={{ marginBottom: 12, color: 'var(--gray-500)' }}>
              Are you sure you want to decline? The sender will be notified.
            </p>
            <textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="Reason (optional)"
              rows={3}
              style={{
                width: '100%',
                padding: 12,
                border: '1px solid var(--gray-200)',
                borderRadius: 'var(--radius)',
                marginBottom: 12,
                fontSize: '0.875rem',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowDeclineModal(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" style={{ flex: 1 }} onClick={handleDecline}>
                Decline to Sign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat Widget for Document Q&A */}
      <ChatWidget token={token} />
    </div>
  );
}
