'use client';

import { useState, useEffect, useCallback, lazy, Suspense, useRef } from 'react';
import { useParams } from 'next/navigation';
import SignatureCanvas from '@/components/SignatureCanvas';
import {
  getSigningSession,
  submitFieldValue,
  createField,
  completeSigning,
  declineSigning,
  getDocumentProxyUrl,
  askDocumentQuestion,
  type SigningSession,
  type PlacedField,
} from '@/lib/api';

const PDFViewer = lazy(() => import('@/components/PDFViewer'));

type ToolType = 'signature' | 'text' | 'date' | 'checkbox' | null;

interface PlacedItem {
  id: string;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: string | null;
  completed: boolean;
  isLocal?: boolean; // not yet saved to server
}

export default function SigningPage() {
  const params = useParams();
  const token = params.token as string;

  const [session, setSession] = useState<SigningSession | null>(null);
  const [placedItems, setPlacedItems] = useState<PlacedItem[]>([]);
  const [activeTool, setActiveTool] = useState<ToolType>(null);
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCompleted, setIsCompleted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [isDeclined, setIsDeclined] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInputValue, setTextInputValue] = useState('');
  const [showAISummary, setShowAISummary] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await getSigningSession(token);
        setSession(data);
        // Load any pre-existing fields (from previous partial sessions)
        if (data.fields.length > 0) {
          setPlacedItems(data.fields.map(f => ({
            ...f,
            completed: !!f.completed,
          })));
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [token]);

  const hasSignature = placedItems.some(item => item.type === 'signature' && item.completed);

  // Handle clicking on the PDF to place a tool
  const handlePdfClick = useCallback((pageIndex: number, relativeX: number, relativeY: number) => {
    if (!activeTool) return;

    const toolType = activeTool;

    if (toolType === 'signature') {
      // Open signature modal, then place at this position
      setActiveItemId(`pending-${Date.now()}`);
      // Store the pending position
      const pendingItem: PlacedItem = {
        id: `pending-${Date.now()}`,
        type: 'signature',
        page: pageIndex + 1,
        x: Math.max(0, Math.min(0.75, relativeX - 0.125)),
        y: Math.max(0, Math.min(0.95, relativeY - 0.025)),
        width: 0.25,
        height: 0.05,
        value: null,
        completed: false,
        isLocal: true,
      };
      setPlacedItems(prev => [...prev, pendingItem]);
      setShowSignatureModal(true);
      setActiveTool(null);
    } else if (toolType === 'date') {
      // Auto-fill with today's date
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      placeAndSaveField(toolType, pageIndex + 1, relativeX, relativeY, today);
      setActiveTool(null);
    } else if (toolType === 'checkbox') {
      placeAndSaveField(toolType, pageIndex + 1, relativeX, relativeY, '✓');
      setActiveTool(null);
    } else if (toolType === 'text') {
      // Show text input modal, then place
      setActiveItemId(`pending-${Date.now()}`);
      const pendingItem: PlacedItem = {
        id: `pending-${Date.now()}`,
        type: 'text',
        page: pageIndex + 1,
        x: Math.max(0, Math.min(0.85, relativeX - 0.075)),
        y: Math.max(0, Math.min(0.95, relativeY - 0.015)),
        width: 0.15,
        height: 0.035,
        value: null,
        completed: false,
        isLocal: true,
      };
      setPlacedItems(prev => [...prev, pendingItem]);
      setTextInputValue('');
      setShowTextInput(true);
      setActiveTool(null);
    }
  }, [activeTool, token]);

  const placeAndSaveField = useCallback(async (
    type: string, page: number, relativeX: number, relativeY: number, value: string,
  ) => {
    const dims = {
      signature: { w: 0.25, h: 0.05 },
      text: { w: 0.15, h: 0.035 },
      date: { w: 0.12, h: 0.03 },
      checkbox: { w: 0.025, h: 0.025 },
    }[type] || { w: 0.15, h: 0.035 };

    const x = Math.max(0, Math.min(1 - dims.w, relativeX - dims.w / 2));
    const y = Math.max(0, Math.min(1 - dims.h, relativeY - dims.h / 2));

    try {
      const saved = await createField(token, { type, page, x, y, width: dims.w, height: dims.h, value });
      setPlacedItems(prev => [...prev, { ...saved, completed: true }]);
    } catch (err: any) {
      setError(err.message);
    }
  }, [token]);

  const handleSignatureSave = useCallback(async (signatureData: string) => {
    setShowSignatureModal(false);
    const pendingItem = placedItems.find(item => item.id === activeItemId);
    if (!pendingItem) return;

    try {
      const saved = await createField(token, {
        type: 'signature',
        page: pendingItem.page,
        x: pendingItem.x,
        y: pendingItem.y,
        width: pendingItem.width,
        height: pendingItem.height,
        value: signatureData,
      });
      setPlacedItems(prev =>
        prev.map(item => item.id === activeItemId ? { ...saved, completed: true } : item),
      );
    } catch (err: any) {
      setError(err.message);
      setPlacedItems(prev => prev.filter(item => item.id !== activeItemId));
    }
    setActiveItemId(null);
  }, [activeItemId, placedItems, token]);

  const handleTextSubmit = useCallback(async () => {
    const value = textInputValue.trim();
    if (!value) return;
    setShowTextInput(false);

    const pendingItem = placedItems.find(item => item.id === activeItemId);
    if (!pendingItem) return;

    try {
      const saved = await createField(token, {
        type: 'text',
        page: pendingItem.page,
        x: pendingItem.x,
        y: pendingItem.y,
        width: pendingItem.width,
        height: pendingItem.height,
        value,
      });
      setPlacedItems(prev =>
        prev.map(item => item.id === activeItemId ? { ...saved, completed: true } : item),
      );
    } catch (err: any) {
      setError(err.message);
      setPlacedItems(prev => prev.filter(item => item.id !== activeItemId));
    }
    setActiveItemId(null);
  }, [activeItemId, placedItems, textInputValue, token]);

  const handleCancelModal = useCallback(() => {
    setShowSignatureModal(false);
    setShowTextInput(false);
    // Remove the pending item
    if (activeItemId) {
      setPlacedItems(prev => prev.filter(item => item.id !== activeItemId));
    }
    setActiveItemId(null);
  }, [activeItemId]);

  const handleComplete = useCallback(async () => {
    if (!consent || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await completeSigning(token);
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

  const handleAISummary = useCallback(async () => {
    setShowAISummary(prev => !prev);
    if (aiSummary) return; // Already loaded
    setShowAISummary(true);
    setAiSummaryLoading(true);
    try {
      const res = await askDocumentQuestion(token, 'Please provide a concise summary of this document, including its purpose, key parties involved, and important terms or conditions.', []);
      setAiSummary(res.answer);
      setChatMessages([{ role: 'assistant', content: res.answer }]);
    } catch {
      setAiSummary('Unable to generate summary at this time.');
    } finally {
      setAiSummaryLoading(false);
    }
  }, [token, aiSummary]);

  const handleChatSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatInput.trim() || chatLoading) return;
    const question = chatInput.trim();
    setChatInput('');
    const newMessages = [...chatMessages, { role: 'user' as const, content: question }];
    setChatMessages(newMessages);
    setChatLoading(true);
    try {
      const res = await askDocumentQuestion(token, question, newMessages.slice(0, -1));
      setChatMessages(prev => [...prev, { role: 'assistant', content: res.answer }]);
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I could not process your question.' }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }, [token, chatInput, chatLoading, chatMessages]);

  const removeItem = useCallback((itemId: string) => {
    setPlacedItems(prev => prev.filter(item => item.id !== itemId));
  }, []);

  // Drag-to-move placed items
  const dragRef = useRef<{
    itemId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    containerRect: DOMRect;
    itemWidth: number;
    itemHeight: number;
  } | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent, itemId: string) => {
    // Don't drag if clicking the remove button
    if ((e.target as HTMLElement).closest('.remove-item-btn')) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    // Find the overlay container (parent of the placed item)
    const itemEl = (e.target as HTMLElement).closest('.placed-item') as HTMLElement;
    if (!itemEl) return;
    const container = itemEl.closest('.field-overlay-container > div') as HTMLElement;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const item = placedItems.find(i => i.id === itemId);
    if (!item) return;

    e.preventDefault();
    e.stopPropagation();

    dragRef.current = {
      itemId,
      startX: clientX,
      startY: clientY,
      origX: item.x,
      origY: item.y,
      containerRect,
      itemWidth: item.width,
      itemHeight: item.height,
    };

    // Add dragging class for visual feedback
    itemEl.classList.add('dragging');
  }, [placedItems]);

  useEffect(() => {
    const handleDragMove = (e: MouseEvent | TouchEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

      const { itemId, startX, startY, origX, origY, containerRect, itemWidth, itemHeight } = dragRef.current;
      const deltaX = (clientX - startX) / containerRect.width;
      const deltaY = (clientY - startY) / containerRect.height;

      const newX = Math.max(0, Math.min(1 - itemWidth, origX + deltaX));
      const newY = Math.max(0, Math.min(1 - itemHeight, origY + deltaY));

      setPlacedItems(prev =>
        prev.map(item => item.id === itemId ? { ...item, x: newX, y: newY } : item),
      );
    };

    const handleDragEnd = () => {
      if (!dragRef.current) return;
      // Remove dragging class
      document.querySelectorAll('.placed-item.dragging').forEach(el => el.classList.remove('dragging'));
      dragRef.current = null;
    };

    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
    document.addEventListener('touchmove', handleDragMove, { passive: false });
    document.addEventListener('touchend', handleDragEnd);

    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
      document.removeEventListener('touchmove', handleDragMove);
      document.removeEventListener('touchend', handleDragEnd);
    };
  }, []);

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
        <span className="logo">ləˈpɛn</span>
        <h1>{session.document.fileName}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn"
            style={{
              padding: '6px 12px', fontSize: '0.75rem', minHeight: 'auto',
              background: '#f0f7ff', color: 'var(--primary)', border: '1px solid var(--primary)',
            }}
            onClick={handleAISummary}
            title="AI Document Summary"
          >
            <span style={{ marginRight: 4 }}>&#x2728;</span> AI Summary
          </button>
          <button
            className="btn btn-danger"
            style={{ padding: '6px 12px', fontSize: '0.75rem', minHeight: 'auto' }}
            onClick={() => setShowDeclineModal(true)}
          >
            Decline
          </button>
        </div>
      </div>

      {/* AI Summary + Chat Panel */}
      {showAISummary && (
        <div style={{
          background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '16px',
          fontSize: '0.875rem', position: 'relative', maxHeight: '50vh', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <strong style={{ color: '#1e40af' }}>AI Document Assistant</strong>
            <button
              onClick={() => setShowAISummary(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.25rem', color: '#6b7280', lineHeight: 1 }}
            >&times;</button>
          </div>

          {aiSummaryLoading ? (
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
      )}

      {/* Document Viewer */}
      <div className="document-viewer">
        <div className="document-container">
          {/* Toolbar */}
          <div className="signing-toolbar" style={{ position: 'relative', top: 0 }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginRight: 8 }}>Place on document:</span>
            {(['signature', 'text', 'date', 'checkbox'] as ToolType[]).map(tool => (
              <button
                key={tool!}
                className={`toolbar-btn ${activeTool === tool ? 'active' : ''}`}
                onClick={() => setActiveTool(activeTool === tool ? null : tool)}
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

          {activeTool && (
            <div style={{
              background: '#fef3c7', borderBottom: '1px solid #fbbf24', padding: '8px 16px',
              fontSize: '0.8125rem', color: '#92400e', textAlign: 'center',
            }}>
              Click anywhere on the document to place {activeTool === 'signature' ? 'your signature' : `a ${activeTool} field`}
            </div>
          )}
          <Suspense
            fallback={
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)' }}>
                Loading PDF viewer...
              </div>
            }
          >
            <PDFViewer
              url={getDocumentProxyUrl(token)}
              pageCount={session.document.pageCount}
              onPageClick={activeTool ? handlePdfClick : undefined}
              renderOverlay={(pageIndex) => (
                <>
                  {placedItems
                    .filter((item) => item.page === pageIndex + 1)
                    .map((item) => (
                      <div
                        key={item.id}
                        className={`placed-item ${item.completed ? 'completed' : 'pending'} type-${item.type}`}
                        style={{
                          left: `${item.x * 100}%`,
                          top: `${item.y * 100}%`,
                          width: `${item.width * 100}%`,
                          height: `${item.height * 100}%`,
                          cursor: item.completed ? 'grab' : undefined,
                        }}
                        onMouseDown={(e) => item.completed && handleDragStart(e, item.id)}
                        onTouchStart={(e) => item.completed && handleDragStart(e, item.id)}
                      >
                        {item.type === 'signature' && item.value && (
                          <img
                            src={item.value}
                            alt="Signature"
                            draggable={false}
                            style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
                          />
                        )}
                        {item.type === 'text' && item.value && (
                          <span style={{ fontSize: '10px', color: '#111' }}>{item.value}</span>
                        )}
                        {item.type === 'date' && item.value && (
                          <span style={{ fontSize: '10px', color: '#111' }}>{item.value}</span>
                        )}
                        {item.type === 'checkbox' && item.value && (
                          <span style={{ fontSize: '14px', color: '#111', fontWeight: 'bold' }}>✓</span>
                        )}
                        {!item.completed && !item.isLocal && (
                          <span style={{ fontSize: '9px', color: 'var(--primary)' }}>
                            {item.type}
                          </span>
                        )}
                        {item.completed && (
                          <button
                            className="remove-item-btn"
                            onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                            title="Remove"
                          >
                            &times;
                          </button>
                        )}
                      </div>
                    ))}
                </>
              )}
              onError={() => {
                // PDF failed to load — show fallback
                const container = document.querySelector('.document-container');
                if (container) {
                  container.innerHTML = '<div style="padding: 40px; text-align: center; color: #9ca3af;">Document Preview Unavailable</div>';
                }
              }}
            />
          </Suspense>
        </div>
      </div>

      {/* Consent & Complete */}
      {hasSignature && (
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

      {/* Signature Modal */}
      {showSignatureModal && (
        <SignatureCanvas
          onSave={handleSignatureSave}
          onCancel={handleCancelModal}
        />
      )}

      {/* Text Input Modal */}
      {showTextInput && activeItemId && (
        <div className="modal-overlay" onClick={handleCancelModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Enter Text</h2>
              <button className="modal-close" onClick={handleCancelModal}>&times;</button>
            </div>
            <input
              type="text"
              value={textInputValue}
              onChange={(e) => setTextInputValue(e.target.value)}
              placeholder="Type here..."
              autoFocus
              style={{
                width: '100%', padding: 12,
                border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
                marginBottom: 12, fontSize: '1rem',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && textInputValue.trim()) handleTextSubmit();
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleCancelModal}>
                Cancel
              </button>
              <button
                className="btn btn-primary" style={{ flex: 1 }}
                disabled={!textInputValue.trim()}
                onClick={handleTextSubmit}
              >
                Place
              </button>
            </div>
          </div>
        </div>
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
              Are you sure? The sender will be notified.
            </p>
            <textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="Reason (optional)"
              rows={3}
              style={{
                width: '100%', padding: 12,
                border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
                marginBottom: 12, fontSize: '0.875rem', resize: 'vertical',
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

    </div>
  );
}
