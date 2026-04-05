'use client';

import { useState, useEffect, useCallback, lazy, Suspense, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  getSetupDocument,
  getSetupDocumentProxyUrl,
  createSetupField,
  deleteSetupField,
  updateSetupFieldPosition,
  addSetupSigner,
  removeSetupSigner,
  sendForSigning,
  type SetupDocument,
  type SetupField,
  type SetupSigner,
} from '@/lib/api';

const PDFViewer = lazy(() => import('@/components/PDFViewer'));

type ToolType = 'signature' | 'text' | 'date' | 'checkbox' | null;

const SIGNER_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#4f46e5'];

export default function SetupPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [doc, setDoc] = useState<SetupDocument | null>(null);
  const [fields, setFields] = useState<SetupField[]>([]);
  const [activeTool, setActiveTool] = useState<ToolType>(null);
  const [selectedSignerIdx, setSelectedSignerIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showAddSigner, setShowAddSigner] = useState(false);
  const [newSignerEmail, setNewSignerEmail] = useState('');
  const [newSignerName, setNewSignerName] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const data = await getSetupDocument(id);
        setDoc(data);
        setFields(data.fields);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  const signers = doc?.signers ?? [];
  const selectedSigner = signers[selectedSignerIdx];

  const getSignerColor = (signerId: string) => {
    const idx = signers.findIndex(s => s.id === signerId);
    return SIGNER_COLORS[idx % SIGNER_COLORS.length];
  };

  // Place field on PDF click
  const handlePdfClick = useCallback(async (pageIndex: number, relativeX: number, relativeY: number) => {
    if (!activeTool || !selectedSigner) return;

    const type = activeTool;
    const dims = {
      signature: { w: 0.25, h: 0.05 },
      text: { w: 0.15, h: 0.035 },
      date: { w: 0.12, h: 0.03 },
      checkbox: { w: 0.025, h: 0.025 },
    }[type] || { w: 0.15, h: 0.035 };

    const x = Math.max(0, Math.min(1 - dims.w, relativeX - dims.w / 2));
    const y = Math.max(0, Math.min(1 - dims.h, relativeY - dims.h / 2));

    try {
      const field = await createSetupField(id, {
        signerId: selectedSigner.id,
        type,
        page: pageIndex + 1,
        x,
        y,
        width: dims.w,
        height: dims.h,
      });
      setFields(prev => [...prev, field]);
    } catch (err: any) {
      setError(err.message);
    }

    setActiveTool(null);
  }, [activeTool, selectedSigner, id]);

  // Remove field
  const handleRemoveField = useCallback(async (fieldId: string) => {
    try {
      await deleteSetupField(id, fieldId);
      setFields(prev => prev.filter(f => f.id !== fieldId));
    } catch (err: any) {
      setError(err.message);
    }
  }, [id]);

  // Drag-to-move fields
  const dragRef = useRef<{
    fieldId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    containerRect: DOMRect;
    fieldWidth: number;
    fieldHeight: number;
  } | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent, fieldId: string) => {
    if ((e.target as HTMLElement).closest('.remove-item-btn')) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const itemEl = (e.target as HTMLElement).closest('.placed-item') as HTMLElement;
    if (!itemEl) return;
    const container = itemEl.closest('.field-overlay-container > div') as HTMLElement;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const field = fields.find(f => f.id === fieldId);
    if (!field) return;

    e.preventDefault();
    e.stopPropagation();

    dragRef.current = {
      fieldId,
      startX: clientX,
      startY: clientY,
      origX: field.x,
      origY: field.y,
      containerRect,
      fieldWidth: field.width,
      fieldHeight: field.height,
    };

    itemEl.classList.add('dragging');
  }, [fields]);

  useEffect(() => {
    const handleDragMove = (e: MouseEvent | TouchEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

      const { fieldId, startX, startY, origX, origY, containerRect, fieldWidth, fieldHeight } = dragRef.current;
      const deltaX = (clientX - startX) / containerRect.width;
      const deltaY = (clientY - startY) / containerRect.height;

      const newX = Math.max(0, Math.min(1 - fieldWidth, origX + deltaX));
      const newY = Math.max(0, Math.min(1 - fieldHeight, origY + deltaY));

      setFields(prev =>
        prev.map(f => f.id === fieldId ? { ...f, x: newX, y: newY } : f),
      );
    };

    const handleDragEnd = async () => {
      if (!dragRef.current) return;
      const { fieldId } = dragRef.current;
      document.querySelectorAll('.placed-item.dragging').forEach(el => el.classList.remove('dragging'));

      // Persist position to server
      const field = fields.find(f => f.id === fieldId);
      if (field) {
        try {
          await updateSetupFieldPosition(id, fieldId, field.x, field.y);
        } catch {
          // Position update failed — field still shows in correct local position
        }
      }

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
  }, [fields, id]);

  // Add signer
  const handleAddSigner = useCallback(async () => {
    if (!newSignerEmail.trim()) return;
    try {
      const signer = await addSetupSigner(id, { name: newSignerName.trim() || undefined, email: newSignerEmail.trim() });
      setDoc(prev => prev ? { ...prev, signers: [...prev.signers, signer] } : prev);
      setNewSignerEmail('');
      setNewSignerName('');
      setShowAddSigner(false);
      // Select the new signer
      setSelectedSignerIdx(signers.length);
    } catch (err: any) {
      setError(err.message);
    }
  }, [id, newSignerEmail, newSignerName, signers.length]);

  // Remove signer
  const handleRemoveSigner = useCallback(async (signerId: string, idx: number) => {
    try {
      await removeSetupSigner(id, signerId);
      setDoc(prev => {
        if (!prev) return prev;
        const updated = prev.signers.filter(s => s.id !== signerId);
        return { ...prev, signers: updated };
      });
      setFields(prev => prev.filter(f => f.signerId !== signerId));
      if (selectedSignerIdx >= idx && selectedSignerIdx > 0) {
        setSelectedSignerIdx(selectedSignerIdx - 1);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, [id, selectedSignerIdx]);

  // Send for signing
  const handleSend = useCallback(async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await sendForSigning(id);
      router.push(`/status/${id}`);
    } catch (err: any) {
      setError(err.message);
      setSending(false);
    }
  }, [id, sending, router]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading setup...</p>
      </div>
    );
  }

  if (error && !doc) {
    return (
      <div className="message-page">
        <div className="message-card">
          <h2>Error</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!doc) return null;

  const fieldTypeLabel = (type: string) => {
    if (type === 'signature') return 'Sig';
    if (type === 'text') return 'Text';
    if (type === 'date') return 'Date';
    if (type === 'checkbox') return '✓';
    return type;
  };

  return (
    <div className="signing-page">
      {/* Header */}
      <div className="signing-header">
        <span className="logo">ləˈpɛn</span>
        <h1>{doc.fileName}</h1>
        <button
          className="btn btn-primary"
          style={{ padding: '6px 16px', fontSize: '0.8rem', minHeight: 'auto' }}
          onClick={handleSend}
          disabled={sending}
        >
          {sending ? 'Sending...' : 'Send for Signing'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '8px 16px',
          fontSize: '0.8125rem', color: '#991b1b', textAlign: 'center',
          maxWidth: 832, margin: '0 auto', width: '100%',
        }}>
          {error}
          <button onClick={() => setError(null)} style={{
            marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', color: '#991b1b', fontWeight: 700,
          }}>&times;</button>
        </div>
      )}

      {/* Signer Tabs */}
      <div className="signer-tabs">
        {signers.map((signer, idx) => (
          <div
            key={signer.id}
            className={`signer-tab ${idx === selectedSignerIdx ? 'active' : ''}`}
            style={{
              '--signer-color': SIGNER_COLORS[idx % SIGNER_COLORS.length],
            } as React.CSSProperties}
            onClick={() => setSelectedSignerIdx(idx)}
          >
            <span className="signer-tab-dot" style={{ background: SIGNER_COLORS[idx % SIGNER_COLORS.length] }} />
            <span className="signer-tab-name">{signer.name || signer.email}</span>
            {signers.length > 1 && (
              <button
                className="signer-tab-remove"
                onClick={(e) => { e.stopPropagation(); handleRemoveSigner(signer.id, idx); }}
                title="Remove signer"
              >
                &times;
              </button>
            )}
          </div>
        ))}
        <button className="add-signer-btn" onClick={() => setShowAddSigner(true)} title="Add signer">+</button>
      </div>

      {/* Toolbar */}
      <div className="signing-toolbar">
        <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginRight: 8 }}>
          Place for {selectedSigner?.name || selectedSigner?.email || 'signer'}:
        </span>
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
          Click on the document to place a {activeTool} field for {selectedSigner?.name || selectedSigner?.email}
        </div>
      )}

      {/* Document Viewer */}
      <div className="document-viewer">
        <div className="document-container">
          <Suspense
            fallback={
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)' }}>
                Loading PDF viewer...
              </div>
            }
          >
            <PDFViewer
              url={getSetupDocumentProxyUrl(id)}
              pageCount={doc.pageCount}
              onPageClick={activeTool ? handlePdfClick : undefined}
              renderOverlay={(pageIndex) => (
                <>
                  {fields
                    .filter((f) => f.page === pageIndex + 1)
                    .map((f) => {
                      const color = getSignerColor(f.signerId);
                      const signer = signers.find(s => s.id === f.signerId);
                      return (
                        <div
                          key={f.id}
                          className="placed-item completed"
                          style={{
                            left: `${f.x * 100}%`,
                            top: `${f.y * 100}%`,
                            width: `${f.width * 100}%`,
                            height: `${f.height * 100}%`,
                            borderColor: color,
                            background: `${color}15`,
                            cursor: 'grab',
                          }}
                          onMouseDown={(e) => handleDragStart(e, f.id)}
                          onTouchStart={(e) => handleDragStart(e, f.id)}
                        >
                          <span style={{
                            fontSize: '9px',
                            color,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: '100%',
                            padding: '0 2px',
                          }}>
                            {fieldTypeLabel(f.type)} — {signer?.name || signer?.email || ''}
                          </span>
                          <button
                            className="remove-item-btn"
                            onClick={(e) => { e.stopPropagation(); handleRemoveField(f.id); }}
                            title="Remove"
                          >
                            &times;
                          </button>
                        </div>
                      );
                    })}
                </>
              )}
              onError={() => {}}
            />
          </Suspense>
        </div>
      </div>

      {/* Send Banner */}
      <div className="send-banner">
        <div style={{ fontSize: '0.8125rem', color: 'var(--gray-500)' }}>
          {signers.length} signer{signers.length !== 1 ? 's' : ''} &middot; {fields.length} field{fields.length !== 1 ? 's' : ''} placed
        </div>
        <button
          className="btn btn-primary"
          onClick={handleSend}
          disabled={sending || fields.length === 0}
          style={{ padding: '10px 24px' }}
        >
          {sending ? 'Sending...' : 'Send for Signing'}
        </button>
      </div>

      {/* Add Signer Modal */}
      {showAddSigner && (
        <div className="modal-overlay" onClick={() => setShowAddSigner(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Signer</h2>
              <button className="modal-close" onClick={() => setShowAddSigner(false)}>&times;</button>
            </div>
            <input
              type="email"
              value={newSignerEmail}
              onChange={(e) => setNewSignerEmail(e.target.value)}
              placeholder="Email address"
              autoFocus
              style={{
                width: '100%', padding: 12,
                border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
                marginBottom: 8, fontSize: '1rem',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newSignerEmail.trim()) handleAddSigner();
              }}
            />
            <input
              type="text"
              value={newSignerName}
              onChange={(e) => setNewSignerName(e.target.value)}
              placeholder="Name (optional)"
              style={{
                width: '100%', padding: 12,
                border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
                marginBottom: 12, fontSize: '1rem',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newSignerEmail.trim()) handleAddSigner();
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowAddSigner(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary" style={{ flex: 1 }}
                disabled={!newSignerEmail.trim()}
                onClick={handleAddSigner}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
