'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

interface SignatureCanvasProps {
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
}

export default function SignatureCanvas({ onSave, onCancel }: SignatureCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [mode, setMode] = useState<'draw' | 'type'>('draw');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const getCoords = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();

    if ('touches' in e) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      };
    }
    return {
      x: (e as React.MouseEvent).clientX - rect.left,
      y: (e as React.MouseEvent).clientY - rect.top,
    };
  }, []);

  const startDrawing = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;

    setIsDrawing(true);
    setHasContent(true);
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }, [getCoords]);

  const draw = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;

    const { x, y } = getCoords(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }, [isDrawing, getCoords]);

  const stopDrawing = useCallback(() => {
    setIsDrawing(false);
  }, []);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasContent(false);
    setTypedName('');
  }, []);

  const handleSave = useCallback(() => {
    if (mode === 'type') {
      // Render typed name as an image data URL so it displays correctly
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 120;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'transparent';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#2563eb';
        ctx.font = 'italic 48px "Dancing Script", cursive, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(typedName, canvas.width / 2, canvas.height / 2);
      }
      onSave(canvas.toDataURL('image/png'));
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    onSave(dataUrl);
  }, [mode, typedName, onSave]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Signature</h2>
          <button className="modal-close" onClick={onCancel}>&times;</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            className={`btn ${mode === 'draw' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('draw')}
          >
            Draw
          </button>
          <button
            className={`btn ${mode === 'type' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode('type')}
          >
            Type
          </button>
        </div>

        {mode === 'draw' ? (
          <canvas
            ref={canvasRef}
            className="signature-canvas"
            onMouseDown={startDrawing}
            onMouseMove={draw}
            onMouseUp={stopDrawing}
            onMouseLeave={stopDrawing}
            onTouchStart={startDrawing}
            onTouchMove={draw}
            onTouchEnd={stopDrawing}
          />
        ) : (
          <input
            type="text"
            value={typedName}
            onChange={(e) => { setTypedName(e.target.value); setHasContent(!!e.target.value); }}
            placeholder="Type your full name"
            style={{
              width: '100%',
              padding: '16px',
              fontSize: '1.5rem',
              fontFamily: 'cursive',
              border: '2px solid var(--gray-200)',
              borderRadius: 'var(--radius)',
              outline: 'none',
              textAlign: 'center',
            }}
            autoFocus
          />
        )}

        <div className="signature-actions">
          <button className="btn btn-secondary" onClick={clear}>Clear</button>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={handleSave}
            disabled={!hasContent}
          >
            Apply Signature
          </button>
        </div>
      </div>
    </div>
  );
}
