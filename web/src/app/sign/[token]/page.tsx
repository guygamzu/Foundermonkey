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
  type OtherField,
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
  required?: boolean;
  isLocal?: boolean; // not yet saved to server
  optionValues?: string[];
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
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(true);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [otherFields, setOtherFields] = useState<OtherField[]>([]);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [inlineTextValue, setInlineTextValue] = useState('');
  const [showOptionSelect, setShowOptionSelect] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Effect 1: Load session data (unblocks page render immediately)
  useEffect(() => {
    async function loadSession() {
      try {
        const data = await getSigningSession(token);
        setSession(data);
        if (data.fields.length > 0) {
          setPlacedItems(data.fields.map(f => ({
            ...f,
            completed: !!f.completed,
            required: f.required,
            optionValues: f.optionValues,
          })));
        }
        if (data.otherFields && data.otherFields.length > 0) {
          setOtherFields(data.otherFields);
        }
      } catch (err: any) {
        setError(err.message);
        setAiSummaryLoading(false);
      } finally {
        setLoading(false);
      }
    }
    loadSession();
  }, [token]);

  // Effect 2: Load AI summary independently (non-blocking)
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function loadSummary() {
      try {
        const res = await askDocumentQuestion(token, 'Summarize this document in one concise sentence: what type of document it is and who the parties are. Be brief.', []);
        if (!cancelled) {
          setAiSummary(res.answer);
          setChatMessages([{ role: 'assistant', content: res.answer }]);
        }
      } catch {
        if (!cancelled) {
          setAiSummary('Unable to generate summary at this time.');
        }
      } finally {
        if (!cancelled) {
          setAiSummaryLoading(false);
        }
      }
    }
    loadSummary();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null]);

  const hasSignature = placedItems.some(item => item.type === 'signature' && item.completed);

  // Detect click-to-fill mode: pre-placed fields exist that haven't been filled yet
  const hasPreplacedFields = placedItems.some(item => item.required && !item.isLocal);
  const completedCount = placedItems.filter(item => item.completed).length;
  const totalFields = placedItems.length;
  const allRequiredFilled = placedItems.filter(item => item.required).every(item => item.completed);

  // Click-to-fill: handle clicking on a pre-placed field
  const handleFieldClick = useCallback(async (item: PlacedItem) => {
    if (item.completed) return; // already filled

    if (item.type === 'signature') {
      setActiveItemId(item.id);
      setShowSignatureModal(true);
    } else if (item.type === 'date') {
      // Auto-fill with today's date
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      try {
        await submitFieldValue(token, item.id, today);
        setPlacedItems(prev => prev.map(i => i.id === item.id ? { ...i, value: today, completed: true } : i));
      } catch (err: any) {
        setError(err.message);
      }
    } else if (item.type === 'checkbox') {
      try {
        await submitFieldValue(token, item.id, '✓');
        setPlacedItems(prev => prev.map(i => i.id === item.id ? { ...i, value: '✓', completed: true } : i));
      } catch (err: any) {
        setError(err.message);
      }
    } else if (item.type === 'text') {
      setEditingFieldId(item.id);
      setInlineTextValue('');
    } else if (item.type === 'option') {
      setEditingFieldId(item.id);
      setShowOptionSelect(true);
    }
  }, [token]);

  // Submit inline text for click-to-fill
  const handleInlineTextSubmit = useCallback(async () => {
    if (!editingFieldId || !inlineTextValue.trim()) return;
    try {
      await submitFieldValue(token, editingFieldId, inlineTextValue.trim());
      setPlacedItems(prev => prev.map(i =>
        i.id === editingFieldId ? { ...i, value: inlineTextValue.trim(), completed: true } : i,
      ));
    } catch (err: any) {
      setError(err.message);
    }
    setEditingFieldId(null);
    setInlineTextValue('');
  }, [token, editingFieldId, inlineTextValue]);

  // Submit option selection for click-to-fill
  const handleOptionSelect = useCallback(async (value: string) => {
    if (!editingFieldId) return;
    try {
      await submitFieldValue(token, editingFieldId, value);
      setPlacedItems(prev => prev.map(i =>
        i.id === editingFieldId ? { ...i, value, completed: true } : i,
      ));
    } catch (err: any) {
      setError(err.message);
    }
    setEditingFieldId(null);
    setShowOptionSelect(false);
  }, [token, editingFieldId]);

  // Handle signature save for click-to-fill pre-placed fields
  const handlePreplacedSignatureSave = useCallback(async (signatureData: string) => {
    setShowSignatureModal(false);
    if (!activeItemId) return;
    try {
      await submitFieldValue(token, activeItemId, signatureData);
      setPlacedItems(prev => prev.map(i =>
        i.id === activeItemId ? { ...i, value: signatureData, completed: true } : i,
      ));
    } catch (err: any) {
      setError(err.message);
    }
    setActiveItemId(null);
  }, [token, activeItemId]);

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
          <h2 style={{ color: 'var(--success)' }}>Already Signed</h2>
          <p>You&apos;ve already signed this document. A copy has been sent to your email.</p>
          <hr style={{ border: 'none', borderTop: '1px solid var(--gray-200)', margin: '20px 0' }} />
          <h3 style={{ fontSize: '1rem', marginBottom: 8 }}>Need documents signed?</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--gray-500)', marginBottom: 16 }}>
            Send documents for e-signature in seconds — just email your PDF to{' '}
            <strong>sign@lapen.ai</strong> along with your recipients.
          </p>
          <a
            href="/"
            style={{
              display: 'inline-block', padding: '10px 24px', background: 'var(--primary)',
              color: 'white', borderRadius: 8, textDecoration: 'none', fontWeight: 600,
              fontSize: '0.875rem',
            }}
          >
            Start Your Free Document
          </a>
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
          <hr style={{ border: 'none', borderTop: '1px solid var(--gray-200)', margin: '20px 0' }} />
          <h3 style={{ fontSize: '1rem', marginBottom: 8 }}>Need documents signed?</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--gray-500)', marginBottom: 16 }}>
            Try Lapen free &mdash; get 5 extra credits when you sign up.
            Just email your PDF to <strong>sign@lapen.ai</strong> along with your signers.
          </p>
          <a
            href={`mailto:sign@lapen.ai?body=${encodeURIComponent('Hi,\n\nThe attached PDF is for your signature. You will receive a follow-up email from Lapen shortly with a secure signing link — no need to sign the attachment directly.\n\nThank you')}`}
            style={{
              display: 'inline-block', padding: '10px 24px', background: 'var(--primary)',
              color: 'white', borderRadius: 8, textDecoration: 'none', fontWeight: 600,
              fontSize: '0.875rem',
            }}
          >
            Try Lapen Free
          </a>
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
        <button
          className="btn btn-danger"
          style={{ padding: '6px 12px', fontSize: '0.75rem', minHeight: 'auto' }}
          onClick={() => setShowDeclineModal(true)}
        >
          Decline
        </button>
      </div>

      {/* Toolbar — hidden in click-to-fill mode */}
      {!hasPreplacedFields && (
        <>
          <div className="signing-toolbar">
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
              maxWidth: 832, margin: '0 auto', width: '100%',
            }}>
              Click anywhere on the document to place {activeTool === 'signature' ? 'your signature' : `a ${activeTool} field`}
            </div>
          )}
        </>
      )}

      {/* Click-to-fill progress bar */}
      {hasPreplacedFields && (
        <div className="field-progress-bar">
          <div style={{ flex: 1, background: '#e5e7eb', borderRadius: 4, height: 6 }}>
            <div style={{
              width: `${totalFields > 0 ? (completedCount / totalFields) * 100 : 0}%`,
              background: allRequiredFilled ? '#16a34a' : '#2563eb',
              height: '100%', borderRadius: 4, transition: 'width 0.3s ease',
            }} />
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)', whiteSpace: 'nowrap' }}>
            {completedCount} of {totalFields} fields completed
          </span>
        </div>
      )}

      {/* Document Viewer */}
      <div className="document-viewer">
        {/* AI Summary + Chat Panel */}
        <div style={{
          background: '#eff6ff', border: '1px solid #bfdbfe', padding: '16px', borderRadius: 8,
          fontSize: '0.875rem', position: 'relative', maxHeight: '50vh', display: 'flex', flexDirection: 'column',
          maxWidth: 800, margin: '0 auto 16px', width: '100%',
        }}>
          <div style={{ marginBottom: 12 }}>
            <strong style={{ color: '#1e40af' }}>AI Document Assistant</strong>
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

        <div className="document-container">
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
                  {/* Other signers' completed fields (read-only, dimmed) */}
                  {otherFields
                    .filter((f) => f.page === pageIndex + 1)
                    .map((f) => (
                      <div
                        key={`other-${f.id}`}
                        className="placed-item completed"
                        style={{
                          left: `${f.x * 100}%`,
                          top: `${f.y * 100}%`,
                          width: `${f.width * 100}%`,
                          height: `${f.height * 100}%`,
                          opacity: 0.7,
                          pointerEvents: 'none',
                          borderColor: '#9ca3af',
                        }}
                      >
                        {f.type === 'signature' && f.value && (
                          <img
                            src={f.value}
                            alt={`${f.signerName || 'Other'}'s signature`}
                            draggable={false}
                            style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
                          />
                        )}
                        {f.type === 'text' && f.value && (
                          <span style={{ fontSize: '10px', color: '#666' }}>{f.value}</span>
                        )}
                        {f.type === 'date' && f.value && (
                          <span style={{ fontSize: '10px', color: '#666' }}>{f.value}</span>
                        )}
                        {f.type === 'checkbox' && f.value && (
                          <span style={{ fontSize: '14px', color: '#666', fontWeight: 'bold' }}>✓</span>
                        )}
                        {f.signerName && (
                          <span style={{
                            position: 'absolute', bottom: -14, left: 0, fontSize: '8px',
                            color: '#6b7280', whiteSpace: 'nowrap',
                          }}>
                            {f.signerName}
                          </span>
                        )}
                      </div>
                    ))}
                  {/* This signer's fields (interactive) */}
                  {placedItems
                    .filter((item) => item.page === pageIndex + 1)
                    .map((item) => (
                      <div
                        key={item.id}
                        className={`placed-item ${item.completed ? 'completed' : 'pending'} type-${item.type}${
                          hasPreplacedFields && !item.completed ? ' field-clickable' : ''
                        }${item.completed ? ' field-filled' : ''}`}
                        style={{
                          left: `${item.x * 100}%`,
                          top: `${item.y * 100}%`,
                          width: `${item.width * 100}%`,
                          height: `${item.height * 100}%`,
                          cursor: hasPreplacedFields && !item.completed ? 'pointer' : item.completed ? 'grab' : undefined,
                        }}
                        onClick={() => hasPreplacedFields && !item.completed && handleFieldClick(item)}
                        onMouseDown={(e) => !hasPreplacedFields && item.completed && handleDragStart(e, item.id)}
                        onTouchStart={(e) => !hasPreplacedFields && item.completed && handleDragStart(e, item.id)}
                      >
                        {/* Filled state: show value */}
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
                        {item.type === 'option' && item.value && (
                          <span style={{ fontSize: '10px', color: '#111' }}>{item.value}</span>
                        )}

                        {/* Click-to-fill: unfilled placeholder labels */}
                        {hasPreplacedFields && !item.completed && (
                          <span className="field-placeholder-label">
                            {item.type === 'signature' && '✍ Signature'}
                            {item.type === 'text' && 'T Text'}
                            {item.type === 'date' && '📅 Date'}
                            {item.type === 'checkbox' && '☑ Check'}
                            {item.type === 'option' && '▼ Select'}
                          </span>
                        )}

                        {/* Inline text input for click-to-fill */}
                        {editingFieldId === item.id && item.type === 'text' && (
                          <input
                            type="text"
                            className="field-inline-input"
                            value={inlineTextValue}
                            onChange={(e) => setInlineTextValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleInlineTextSubmit();
                              if (e.key === 'Escape') { setEditingFieldId(null); setInlineTextValue(''); }
                            }}
                            onBlur={() => { if (inlineTextValue.trim()) handleInlineTextSubmit(); else { setEditingFieldId(null); } }}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            placeholder="Type here..."
                          />
                        )}

                        {/* Inline option select for click-to-fill */}
                        {editingFieldId === item.id && item.type === 'option' && showOptionSelect && (
                          <select
                            className="field-option-select"
                            autoFocus
                            defaultValue=""
                            onChange={(e) => { if (e.target.value) handleOptionSelect(e.target.value); }}
                            onBlur={() => { setEditingFieldId(null); setShowOptionSelect(false); }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="" disabled>Select...</option>
                            {(item.optionValues || []).map(opt => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        )}

                        {/* Free-form mode: type label for unfilled, remove for filled */}
                        {!hasPreplacedFields && !item.completed && !item.isLocal && (
                          <span style={{ fontSize: '9px', color: 'var(--primary)' }}>
                            {item.type}
                          </span>
                        )}
                        {!hasPreplacedFields && item.completed && (
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
      {(hasPreplacedFields ? allRequiredFilled && hasSignature : hasSignature) && (
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
          onSave={hasPreplacedFields ? handlePreplacedSignatureSave : handleSignatureSave}
          onCancel={() => {
            setShowSignatureModal(false);
            if (!hasPreplacedFields) handleCancelModal();
            setActiveItemId(null);
          }}
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
