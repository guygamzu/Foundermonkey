'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getMyDocuments, type MyDocumentsResponse } from '@/lib/api';

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    sent: 'Sent',
    partially_signed: 'In progress',
    completed: 'Completed',
    declined: 'Declined',
    expired: 'Expired',
    pending_confirmation: 'Pending',
    pending_setup: 'Setup',
    template_ready: 'Ready to send',
  };
  return labels[status] || status;
}

function statusColor(status: string): { bg: string; text: string } {
  switch (status) {
    case 'completed':
      return { bg: '#dcfce7', text: '#166534' };
    case 'declined':
    case 'expired':
      return { bg: '#fee2e2', text: '#991b1b' };
    case 'partially_signed':
      return { bg: '#e0f2fe', text: '#0369a1' };
    case 'sent':
      return { bg: '#dbeafe', text: '#1e40af' };
    case 'template_ready':
      return { bg: '#fef3c7', text: '#92400e' };
    default:
      return { bg: '#f3f4f6', text: '#6b7280' };
  }
}

export default function MyDocumentsPage() {
  const params = useParams();
  const token = params.token as string;
  const [data, setData] = useState<MyDocumentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    (async () => {
      try {
        const res = await getMyDocuments(token);
        setData(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading your documents...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Link invalid or expired</h2>
          <p>{error || 'We couldn\'t find any documents for this link.'}</p>
          <p style={{ marginTop: 12, color: 'var(--gray-500)', fontSize: '0.875rem' }}>
            Check any recent Lapen email for a fresh &quot;View my documents&quot; link.
          </p>
        </div>
      </div>
    );
  }

  const filtered = data.documents.filter(d => {
    if (statusFilter !== 'all' && d.status !== statusFilter) return false;
    if (search.trim() && !d.fileName.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  const counts = data.documents.reduce<Record<string, number>>((acc, d) => {
    acc.all = (acc.all || 0) + 1;
    acc[d.status] = (acc[d.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="status-page" style={{ maxWidth: 900, margin: '0 auto', padding: '20px 16px' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: '1.4rem', fontWeight: 400, color: 'var(--ink)', letterSpacing: '-0.01em' }}>
          La <em style={{ fontWeight: 300 }}>Pen</em><span style={{ color: 'var(--seal)' }}>.</span>
        </div>
      </div>

      <div className="status-card">
        <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 4 }}>
          Your documents
        </h1>
        <p style={{ color: 'var(--gray-500)', fontSize: '0.875rem' }}>
          {data.user.email} · {data.user.credits} credit{data.user.credits === 1 ? '' : 's'} remaining
        </p>
      </div>

      {data.documents.length === 0 ? (
        <div className="status-card" style={{ textAlign: 'center', padding: 48 }}>
          <p style={{ color: 'var(--gray-500)' }}>
            You haven&apos;t sent any documents yet. Email a PDF to <strong>sign@lapen.ai</strong> to get started.
          </p>
        </div>
      ) : (
        <>
          {/* Filters */}
          <div className="status-card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search filename..."
                style={{
                  flex: 1,
                  minWidth: 180,
                  padding: '8px 12px',
                  border: '1px solid var(--gray-200)',
                  borderRadius: 8,
                  fontSize: '0.875rem',
                }}
              />
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[
                  { key: 'all', label: 'All' },
                  { key: 'sent', label: 'Sent' },
                  { key: 'partially_signed', label: 'In progress' },
                  { key: 'completed', label: 'Completed' },
                  { key: 'template_ready', label: 'Ready to send' },
                ].map(f => (
                  <button
                    key={f.key}
                    onClick={() => setStatusFilter(f.key)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 6,
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      border: '1px solid',
                      borderColor: statusFilter === f.key ? '#2c4a35' : 'var(--gray-200)',
                      background: statusFilter === f.key ? '#f0fdf4' : 'white',
                      color: statusFilter === f.key ? '#166534' : 'var(--gray-700)',
                    }}
                  >
                    {f.label}
                    {counts[f.key] !== undefined && (
                      <span style={{ marginLeft: 4, opacity: 0.7 }}>({counts[f.key] || 0})</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Documents list */}
          <div className="status-card" style={{ padding: 0, overflow: 'hidden' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--gray-500)' }}>
                No documents match your filters.
              </div>
            ) : (
              filtered.map((doc, i) => {
                const c = statusColor(doc.status);
                const isSetup = doc.status === 'template_ready' || doc.status === 'pending_setup';
                const linkHref = isSetup ? `/setup/${doc.id}` : `/status/${doc.id}`;
                return (
                  <a
                    key={doc.id}
                    href={linkHref}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '14px 16px',
                      borderTop: i === 0 ? 'none' : '1px solid var(--gray-100)',
                      textDecoration: 'none',
                      color: 'inherit',
                      background: 'white',
                      transition: 'background 100ms',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gray-50)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'white'; }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontWeight: 600, fontSize: '0.95rem', color: 'var(--ink)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {doc.fileName}
                      </div>
                      <div style={{ color: 'var(--gray-500)', fontSize: '0.8125rem', marginTop: 2 }}>
                        {formatDate(doc.createdAt)} · {doc.signedCount}/{doc.signerCount} signed
                        {doc.completedAt && (
                          <> · Completed {formatDate(doc.completedAt)}</>
                        )}
                      </div>
                    </div>
                    <span style={{
                      padding: '3px 10px',
                      borderRadius: 6,
                      background: c.bg,
                      color: c.text,
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.03em',
                      flexShrink: 0,
                    }}>
                      {statusLabel(doc.status)}
                    </span>
                    <span style={{ color: 'var(--gray-400)', fontSize: '1rem', marginLeft: 4 }}>&rsaquo;</span>
                  </a>
                );
              })
            )}
          </div>

          <p style={{ textAlign: 'center', color: 'var(--gray-500)', fontSize: '0.75rem', marginTop: 12 }}>
            {filtered.length} of {data.documents.length} documents shown
          </p>
        </>
      )}
    </div>
  );
}
