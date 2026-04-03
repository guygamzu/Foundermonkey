'use client';

import { useState, useEffect, lazy, Suspense, useRef } from 'react';
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

  // AI Summary & Chat — always visible on preview
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(true);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

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

  const handleChatSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatInput.trim() || chatLoading) return;
    const question = chatInput.trim();
    setChatInput('');
    const newMessages: ChatMessage[] = [...chatMessages, { role: 'user', content: question }];
    setChatMessages(newMessages);
    setChatLoading(true);
    try {
      const result = await askPreviewQuestion(documentId, question, newMessages.slice(0, -1));
      setChatMessages(prev => [...prev, { role: 'assistant', content: result.answer }]);
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I could not process your question.' }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
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

  const showPdf = preview.documentUrl && !pdfFailed;

  return (
    <div className="signing-page">
      {/* Header — matches signing page but Decline is dimmed */}
      <div className="signing-header">
        <span className="logo">ləˈpɛn</span>
        <h1>{preview.fileName}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-danger"
            style={{ padding: '6px 12px', fontSize: '0.75rem', minHeight: 'auto', opacity: 0.4, pointerEvents: 'none' }}
            disabled
          >
            Decline
          </button>
        </div>
      </div>

      {/* AI Summary + Chat Panel — always visible on preview */}
      <div style={{
        background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '16px',
        fontSize: '0.875rem', position: 'relative', maxHeight: '50vh', display: 'flex', flexDirection: 'column',
        maxWidth: 832, margin: '0 auto', width: '100%',
      }}>
        <div style={{ marginBottom: 12 }}>
          <strong style={{ color: '#1e40af' }}>AI Document Assistant</strong>
        </div>

        {aiLoading ? (
          <div style={{ padding: 16, textAlign: 'center', color: '#6b7280' }}>
            <div className="spinner" style={{ width: 20, height: 20, margin: '0 auto 8px' }} />
            Analyzing document...
          </div>
        ) : (
          <>
            <div style={{ flex: 1, overflowY: 'auto', marginBottom: 12, maxHeight: '35vh' }}>
              {chatMessages.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    padding: '8px 12px',
                    margin: '4px 0',
                    borderRadius: 8,
                    background: msg.role === 'user' ? '#dbeafe' : 'white',
                    borderLeft: msg.role === 'assistant' ? '3px solid #2563eb' : 'none',
                    fontSize: '0.8125rem',
                    lineHeight: 1.5,
                    color: '#374151',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {msg.role === 'user' && <strong style={{ color: '#2563eb' }}>You: </strong>}
                  {msg.content}
                </div>
              ))}
              {chatLoading && (
                <div style={{ padding: '8px 12px', color: '#6b7280', fontSize: '0.8125rem' }}>Thinking...</div>
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleChatSubmit} style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask a question about this document..."
                style={{
                  flex: 1, padding: '8px 12px', border: '1px solid #bfdbfe', borderRadius: 8,
                  fontSize: '0.8125rem', outline: 'none', background: 'white',
                }}
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || chatLoading}
                style={{
                  padding: '8px 14px', background: '#2563eb', color: 'white', border: 'none',
                  borderRadius: 8, cursor: chatInput.trim() && !chatLoading ? 'pointer' : 'not-allowed',
                  opacity: chatInput.trim() && !chatLoading ? 1 : 0.5, fontSize: '0.8125rem', fontWeight: 600,
                }}
              >
                Ask
              </button>
            </form>
          </>
        )}
      </div>

      {/* Toolbar — same layout as signing page but all dimmed/disabled */}
      <div className="signing-toolbar" style={{ opacity: 0.4, pointerEvents: 'none' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginRight: 8 }}>Place on document:</span>
        {(['signature', 'text', 'date', 'checkbox'] as const).map(tool => (
          <button
            key={tool}
            className="toolbar-btn"
            disabled
          >
            <span className="toolbar-icon">
              {tool === 'signature' && '✍'}
              {tool === 'text' && 'T'}
              {tool === 'date' && '📅'}
              {tool === 'checkbox' && '☑'}
            </span>
            <span className="toolbar-label">
              {tool === 'signature' && 'Signature'}
              {tool === 'text' && 'Text'}
              {tool === 'date' && 'Date'}
              {tool === 'checkbox' && 'Checkbox'}
            </span>
          </button>
        ))}
      </div>

      {/* Document Viewer */}
      <div className="document-viewer">
        <div className="document-container">
          {showPdf ? (
            <Suspense
              fallback={
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)' }}>
                  Loading PDF viewer...
                </div>
              }
            >
              <PDFViewer
                url={getPreviewDocumentProxyUrl(documentId)}
                pageCount={preview.pageCount}
                renderOverlay={(pageIndex) => (
                  <>
                    {preview.fields
                      .filter(f => f.page === pageIndex + 1)
                      .map(field => (
                        <div
                          key={field.id}
                          className={`placed-item completed type-${field.type}`}
                          style={{
                            left: `${field.x * 100}%`,
                            top: `${field.y * 100}%`,
                            width: `${field.width * 100}%`,
                            height: `${field.height * 100}%`,
                            pointerEvents: 'none',
                          }}
                        >
                          <span style={{ fontSize: '9px', color: 'var(--primary)', textTransform: 'uppercase', fontWeight: 600 }}>
                            {field.type}
                          </span>
                        </div>
                      ))}
                  </>
                )}
                onError={() => setPdfFailed(true)}
              />
            </Suspense>
          ) : (
            Array.from({ length: preview.pageCount }, (_, pageIndex) => (
              <div key={pageIndex} style={{ position: 'relative', minHeight: 300, background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
                <div style={{ padding: 16, color: 'var(--gray-400)', textAlign: 'center', fontSize: '0.8125rem' }}>
                  Page {pageIndex + 1}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
