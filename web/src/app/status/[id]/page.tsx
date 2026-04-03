'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { getDocumentStatus, type DocumentStatus, type DocumentSigner } from '@/lib/api';

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    sent: 'Sent',
    partially_signed: 'Partially Signed',
    completed: 'Completed',
    declined: 'Declined',
    expired: 'Expired',
    pending_confirmation: 'Pending Confirmation',
    pending: 'Pending',
    notified: 'Notified',
    viewed: 'Viewed',
    signed: 'Signed',
  };
  return labels[status] || status;
}

function getStatusBadgeClass(status: string): string {
  switch (status) {
    case 'signed':
    case 'completed':
      return 'status-badge completed';
    case 'declined':
    case 'expired':
      return 'status-badge declined';
    case 'viewed':
    case 'partially_signed':
      return 'status-badge pending';
    case 'sent':
    case 'notified':
      return 'status-badge sent';
    case 'pending':
    case 'pending_confirmation':
    default:
      return 'status-badge sent';
  }
}

function getSignerIcon(status: string): string {
  switch (status) {
    case 'signed':
      return '\u2713';
    case 'declined':
      return '\u2717';
    case 'viewed':
      return '\u25C9';
    default:
      return '\u25CB';
  }
}

function getProgressSteps(doc: DocumentStatus): Array<{ label: string; done: boolean; active: boolean }> {
  const statusOrder = ['sent', 'partially_signed', 'completed'];
  const isDeclined = doc.status === 'declined';
  const isExpired = doc.status === 'expired';

  if (isDeclined) {
    return [
      { label: 'Sent', done: true, active: false },
      { label: 'Declined', done: true, active: true },
    ];
  }
  if (isExpired) {
    return [
      { label: 'Sent', done: true, active: false },
      { label: 'Expired', done: true, active: true },
    ];
  }

  const currentIdx = statusOrder.indexOf(doc.status);
  return [
    { label: 'Sent', done: currentIdx >= 0, active: currentIdx === 0 },
    { label: 'In Progress', done: currentIdx >= 1, active: currentIdx === 1 },
    { label: 'Completed', done: currentIdx >= 2, active: currentIdx === 2 },
  ];
}

export default function StatusPage() {
  const params = useParams();
  const documentId = params.id as string;

  const [doc, setDoc] = useState<DocumentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getDocumentStatus(documentId);
      setDoc(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document status');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading document status...</p>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Document Not Found</h2>
          <p>{error || 'The document you are looking for does not exist or has been removed.'}</p>
        </div>
      </div>
    );
  }

  const steps = getProgressSteps(doc);

  return (
    <div className="status-page">
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--primary)' }}>ləˈpɛn</div>
      </div>

      {/* Document header */}
      <div className="status-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 4, wordBreak: 'break-word' }}>
              {doc.fileName}
            </h1>
            <p style={{ color: 'var(--gray-500)', fontSize: '0.875rem' }}>
              Created {formatDate(doc.createdAt)}
            </p>
          </div>
          <span className={getStatusBadgeClass(doc.status)}>
            {getStatusLabel(doc.status)}
          </span>
        </div>

        {doc.completedAt && (
          <p style={{ color: 'var(--success)', fontSize: '0.875rem', marginTop: 12, fontWeight: 500 }}>
            Completed {formatDate(doc.completedAt)}
          </p>
        )}
      </div>

      {/* Progress timeline */}
      <div className="status-card">
        <h2 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 16 }}>
          Progress
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          {steps.map((step, i) => (
            <div key={step.label} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 'none' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 64 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    background: step.done
                      ? (step.label === 'Declined' || step.label === 'Expired' ? 'var(--danger)' : 'var(--success)')
                      : 'var(--gray-200)',
                    color: step.done ? 'white' : 'var(--gray-500)',
                  }}
                >
                  {step.done ? '\u2713' : i + 1}
                </div>
                <span style={{
                  fontSize: '0.75rem',
                  marginTop: 6,
                  color: step.active ? 'var(--gray-900)' : 'var(--gray-500)',
                  fontWeight: step.active ? 600 : 400,
                  whiteSpace: 'nowrap',
                }}>
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div style={{
                  flex: 1,
                  height: 2,
                  background: steps[i + 1].done ? 'var(--success)' : 'var(--gray-200)',
                  marginBottom: 20,
                  minWidth: 20,
                }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Signers list */}
      <div className="status-card">
        <h2 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 16 }}>
          Signers ({doc.signers.length})
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {doc.signers.map((signer, i) => (
            <SignerRow key={i} signer={signer} />
          ))}
        </div>
      </div>

      {/* Auto-refresh note */}
      <p style={{ textAlign: 'center', color: 'var(--gray-500)', fontSize: '0.75rem', marginTop: 8 }}>
        Auto-refreshes every 30 seconds
      </p>
    </div>
  );
}

function SignerRow({ signer }: { signer: DocumentSigner }) {
  const iconColor = (() => {
    switch (signer.status) {
      case 'signed': return 'var(--success)';
      case 'declined': return 'var(--danger)';
      case 'viewed': return 'var(--warning)';
      default: return 'var(--gray-300)';
    }
  })();

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '12px 0',
      borderBottom: '1px solid var(--gray-100)',
    }}>
      <div style={{
        width: 32,
        height: 32,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '1rem',
        color: iconColor,
        border: `2px solid ${iconColor}`,
        flexShrink: 0,
      }}>
        {getSignerIcon(signer.status)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.9375rem' }}>
          {signer.name || 'Unnamed Signer'}
        </div>
        <div style={{ color: 'var(--gray-500)', fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {signer.email || 'No email'}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <span className={getStatusBadgeClass(signer.status)}>
          {getStatusLabel(signer.status)}
        </span>
        {signer.signedAt && (
          <div style={{ color: 'var(--gray-500)', fontSize: '0.75rem', marginTop: 4 }}>
            {formatDate(signer.signedAt)}
          </div>
        )}
      </div>
    </div>
  );
}
