'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import { useParams } from 'next/navigation';
import { getPreviewDocumentProxyUrl, askPreviewQuestion } from '@/lib/api';

const PDFViewer = lazy(() => import('@/components/PDFViewer'));

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface DocumentPreview {
  id: string;
  fileName: string;
  pageCount: number;
  documentUrl: string | null;
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

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function PreviewPage() {
  const params = useParams();
  const documentId = params.id as string;

  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pdfFailed, setPdfFailed] = useState(false);

  // AI Summary & Chat — always visible
  const [aiSummary, setAiSummary] = useState('');
  const [aiLoading, setAiLoading] = useState(true);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_URL}/api/documents/preview/${documentId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Not found' }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        setPreview(await res.json());

        // Auto-fetch AI summary
        try {
          const result = await askPreviewQuestion(
            documentId,
            'Summarize this document in 1-2 sentences. State what it is, its purpose, and the key parties.',
            [],
          );
          setAiSummary(result.answer);
          setChatMessages([{ role: 'assistant', content: result.answer }]);
        } catch {
          setAiSummary('Unable to generate summary at this time.');
        } finally {
          setAiLoading(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load preview');
        setAiLoading(false);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [documentId]);

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

    const question = chatInput.trim();
    setChatInput('');
    const newMessages: ChatMessage[] = [...chatMessages, { role: 'user', content: question }];
    setChatMessages(newMessages);
    setChatLoading(true);

    try {
      const result = await askPreviewQuestion(documentId, question, newMessages.slice(0, -1));
      setChatMessages([...newMessages, { role: 'assistant', content: result.answer }]);
    } catch {
      setChatMessages([...newMessages, { role: 'assistant', content: 'Sorry, I could not process your question.' }]);
    } finally {
      setChatLoading(false);
    }
  };

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

  const renderFieldOverlays = (pageIndex: number) => (
    <>
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
              border: '2px dashed #2563eb',
              background: '#2563eb20',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.625rem',
              color: '#2563eb',
              fontWeight: 600,
              textTransform: 'uppercase' as const,
              pointerEvents: 'none' as const,
            }}
          >
            {field.type}
          </div>
        ))}
    </>
  );

  const showPdf = preview.documentUrl && !pdfFailed;

  return (
    <div className="status-page">
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--primary)' }}>ləˈpɛn</div>
      </div>

      {/* AI Summary & Chat Panel — always visible */}
      {(
        <div className="status-card" style={{ borderLeft: '4px solid #2563eb' }}>
          <h2 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            AI Document Assistant
          </h2>

          {aiLoading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--gray-400)' }}>
              <div className="spinner" style={{ width: 24, height: 24, margin: '0 auto 8px' }} />
              Analyzing document...
            </div>
          ) : (
            <>
              <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 12 }}>
                {chatMessages.map((msg, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '10px 14px',
                      margin: '6px 0',
                      borderRadius: 8,
                      background: msg.role === 'user' ? '#eff6ff' : '#f9fafb',
                      borderLeft: msg.role === 'assistant' ? '3px solid #2563eb' : 'none',
                      fontSize: '0.875rem',
                      lineHeight: 1.6,
                      color: '#374151',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {msg.role === 'user' && <strong style={{ color: '#2563eb' }}>You: </strong>}
                    {msg.content}
                  </div>
                ))}
                {chatLoading && (
                  <div style={{ padding: '10px 14px', color: 'var(--gray-400)', fontSize: '0.875rem' }}>
                    Thinking...
                  </div>
                )}
              </div>

              <form onSubmit={handleChatSubmit} style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask a question about this document..."
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    border: '1px solid #d1d5db',
                    borderRadius: 8,
                    fontSize: '0.875rem',
                    outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim() || chatLoading}
                  style={{
                    padding: '10px 16px',
                    background: '#2563eb',
                    color: 'white',
                    border: 'none',
                    borderRadius: 8,
                    cursor: chatInput.trim() && !chatLoading ? 'pointer' : 'not-allowed',
                    opacity: chatInput.trim() && !chatLoading ? 1 : 0.5,
                    fontSize: '0.875rem',
                    fontWeight: 600,
                  }}
                >
                  Ask
                </button>
              </form>
            </>
          )}
        </div>
      )}

      <div className="status-card">
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 8 }}>{preview.fileName}</h1>
        <p style={{ color: 'var(--gray-500)', fontSize: '0.875rem' }}>
          {preview.pageCount} page{preview.pageCount > 1 ? 's' : ''}
        </p>
      </div>

      {/* Signers */}
      <div className="status-card">
        <h2 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          Signers ({preview.signers.length})
        </h2>
        {preview.signers.length === 0 ? (
          <p style={{ color: 'var(--gray-400)', fontSize: '0.875rem' }}>No signers assigned yet. Reply to the email with signee addresses.</p>
        ) : (
          preview.signers.map((signer, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < preview.signers.length - 1 ? '1px solid var(--gray-100)' : 'none' }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--primary)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>
                {signer.order}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{signer.name || 'Unnamed'}</div>
                <div style={{ color: 'var(--gray-500)', fontSize: '0.8125rem' }}>{signer.email || signer.phone || 'No contact'}</div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Document preview */}
      <div className="status-card">
        <h2 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          Document Preview
        </h2>

        {showPdf ? (
          <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)' }}>Loading PDF...</div>}>
            <PDFViewer
              url={getPreviewDocumentProxyUrl(documentId)}
              pageCount={preview.pageCount}
              renderOverlay={(pageIndex) => renderFieldOverlays(pageIndex)}
              onError={() => setPdfFailed(true)}
            />
          </Suspense>
        ) : (
          Array.from({ length: preview.pageCount }, (_, pageIndex) => (
            <div key={pageIndex} style={{ position: 'relative', minHeight: 300, background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ padding: 16, color: 'var(--gray-400)', textAlign: 'center', fontSize: '0.8125rem' }}>
                Page {pageIndex + 1}
              </div>
              {renderFieldOverlays(pageIndex)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
