'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface DocumentPreview {
  id: string;
  fileName: string;
  pageCount: number;
  fields: Array<{
    id: string;
    type: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  signers: Array<{
    name: string | null;
    email: string | null;
    phone: string | null;
    order: number;
  }>;
}

export default function PreviewPage() {
  const params = useParams();
  const documentId = params.id as string;

  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_URL}/api/documents/preview/${documentId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Not found' }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        setPreview(await res.json());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load preview');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [documentId]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading preview...</p>
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Document Not Found</h2>
          <p>{error || 'This document does not exist or has been removed.'}</p>
        </div>
      </div>
    );
  }

  const fieldTypeColors: Record<string, string> = {
    signature: '#2563eb',
    initial: '#7c3aed',
    date: '#059669',
    text: '#d97706',
  };

  return (
    <div className="status-page">
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--primary)' }}>Lapen</div>
      </div>

      <div className="status-card">
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 8 }}>{preview.fileName}</h1>
        <p style={{ color: 'var(--gray-500)', fontSize: '0.875rem' }}>
          {preview.pageCount} page{preview.pageCount > 1 ? 's' : ''} &middot; {preview.fields.length} field{preview.fields.length !== 1 ? 's' : ''} detected
        </p>
      </div>

      {/* Signers */}
      <div className="status-card">
        <h2 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          Signers ({preview.signers.length})
        </h2>
        {preview.signers.map((signer, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < preview.signers.length - 1 ? '1px solid var(--gray-100)' : 'none' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--primary)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>
              {signer.order}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{signer.name || 'Unnamed'}</div>
              <div style={{ color: 'var(--gray-500)', fontSize: '0.8125rem' }}>{signer.email || signer.phone || 'No contact'}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Document preview with fields */}
      <div className="status-card">
        <h2 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          Detected Fields
        </h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {Object.entries(fieldTypeColors).map(([type, color]) => {
            const count = preview.fields.filter(f => f.type === type).length;
            if (!count) return null;
            return (
              <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: color, opacity: 0.3, display: 'inline-block' }} />
                {type} ({count})
              </span>
            );
          })}
        </div>

        {Array.from({ length: preview.pageCount }, (_, pageIndex) => (
          <div key={pageIndex} style={{ position: 'relative', minHeight: 300, background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
            <div style={{ padding: 16, color: 'var(--gray-400)', textAlign: 'center', fontSize: '0.8125rem' }}>
              Page {pageIndex + 1}
            </div>
            {preview.fields
              .filter(f => f.page === pageIndex + 1)
              .map(field => (
                <div
                  key={field.id}
                  style={{
                    position: 'absolute',
                    left: `${field.x * 100}%`,
                    top: `${field.y * 100}%`,
                    width: `${field.width * 100}%`,
                    height: `${field.height * 100}%`,
                    border: `2px dashed ${fieldTypeColors[field.type] || '#6b7280'}`,
                    background: `${fieldTypeColors[field.type] || '#6b7280'}15`,
                    borderRadius: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.625rem',
                    color: fieldTypeColors[field.type] || '#6b7280',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                  }}
                >
                  {field.type}
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
