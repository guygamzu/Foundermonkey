'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;

interface PDFViewerProps {
  url: string;
  fallbackUrl?: string;
  pageCount: number;
  renderOverlay: (pageIndex: number, dimensions: { width: number; height: number }) => React.ReactNode;
  onPageClick?: (pageIndex: number, relativeX: number, relativeY: number) => void;
  onError?: () => void;
}

export default function PDFViewer({ url, fallbackUrl, pageCount, renderOverlay, onPageClick, onError }: PDFViewerProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [errorDetail, setErrorDetail] = useState('');
  const [numPages, setNumPages] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const MAX_AUTO_RETRIES = 4;
  const objectUrlRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;

    async function fetchPdf() {
      setBlobUrl(null);
      setLoadError(false);
      setErrorDetail('');

      const errors: string[] = [];

      async function tryFetch(fetchUrl: string, label: string): Promise<ArrayBuffer | null> {
        try {
          const res = await fetch(fetchUrl, { signal });
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const detail = `${label}: ${res.status} ${text.slice(0, 100)}`;
            console.error(`[PDFViewer] ${detail}`);
            errors.push(detail);
            return null;
          }
          const ct = res.headers.get('content-type') || '';
          if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
            const detail = `${label}: unexpected content-type "${ct}"`;
            console.error(`[PDFViewer] ${detail}`);
            errors.push(detail);
            return null;
          }
          return res.arrayBuffer();
        } catch (err) {
          if (signal.aborted) return null;
          const msg = err instanceof Error ? err.message : String(err);
          const detail = `${label}: ${msg}`;
          console.error(`[PDFViewer] ${detail}`);
          errors.push(detail);
          return null;
        }
      }

      let buffer = await tryFetch(url, 'primary');
      if (!buffer && fallbackUrl && !signal.aborted) {
        buffer = await tryFetch(fallbackUrl, 'fallback');
      }

      if (signal.aborted) return;

      if (buffer) {
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        const newUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
        objectUrlRef.current = newUrl;
        setBlobUrl(newUrl);
      } else {
        setErrorDetail(errors.join(' | '));
        setLoadError(true);
        onErrorRef.current?.();
      }
    }

    if (retryCount === 0) {
      fetchPdf();
    } else if (retryCount <= MAX_AUTO_RETRIES) {
      const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 10000);
      console.log(`[PDFViewer] Auto-retry ${retryCount}/${MAX_AUTO_RETRIES} in ${delay}ms...`);
      const timer = setTimeout(fetchPdf, delay);
      return () => { controller.abort(); clearTimeout(timer); };
    }

    return () => {
      controller.abort();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [url, fallbackUrl, retryCount]);

  useEffect(() => {
    if (loadError && retryCount < MAX_AUTO_RETRIES) {
      setRetryCount((c) => c + 1);
    }
  }, [loadError]);

  const handleManualRetry = useCallback(() => {
    setRetryCount((c) => c + 1);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      setContainerWidth(el.clientWidth);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
  }, []);

  if (loadError && retryCount >= MAX_AUTO_RETRIES) {
    return (
      <div style={{
        width: '100%', maxWidth: 800, margin: '40px auto', padding: 32,
        textAlign: 'center', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb',
      }}>
        <p style={{ color: '#374151', marginBottom: 8, fontSize: 15 }}>
          Document preview unavailable.
        </p>
        {errorDetail && (
          <p style={{ color: '#9ca3af', marginBottom: 16, fontSize: 12, wordBreak: 'break-word' }}>
            {errorDetail}
          </p>
        )}
        <button
          onClick={handleManualRetry}
          style={{
            padding: '10px 24px', background: '#2c4a35', color: 'white',
            border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 500,
          }}
        >
          Retry Loading
        </button>
      </div>
    );
  }

  if (loadError && retryCount < MAX_AUTO_RETRIES) {
    return (
      <div style={{ width: '100%', maxWidth: 800, margin: '40px auto', textAlign: 'center' }}>
        <div style={{
          width: '100%', aspectRatio: '8.5/11', background: '#f3f4f6',
          borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <p style={{ color: '#6b7280', fontSize: 14 }}>
            Loading document (attempt {retryCount + 1} of {MAX_AUTO_RETRIES + 1})…
          </p>
        </div>
      </div>
    );
  }

  const totalPages = Math.max(numPages || 0, pageCount || 1);

  return (
    <div ref={containerRef}>
      {containerWidth > 0 && blobUrl && (
        <Document
          file={blobUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={(err) => { console.error('[PDFViewer] PDF parse error:', err); setLoadError(true); onError?.(); }}
          loading={
            <div style={{ width: '100%', maxWidth: 800, margin: '0 auto' }}>
              {Array.from({ length: Math.min(pageCount, 2) }, (_, i) => (
                <div key={i} style={{
                  width: '100%', aspectRatio: '8.5/11', background: '#f3f4f6',
                  borderRadius: 4, marginBottom: 8,
                  animation: 'pulse 1.5s ease-in-out infinite',
                }} />
              ))}
            </div>
          }
        >
          {Array.from({ length: totalPages }, (_, pageIndex) => (
            <PageWithOverlay
              key={pageIndex}
              pageIndex={pageIndex}
              width={containerWidth}
              renderOverlay={renderOverlay}
              onPageClick={onPageClick}
            />
          ))}
        </Document>
      )}
      {containerWidth > 0 && !blobUrl && !loadError && (
        <div style={{ width: '100%', maxWidth: 800, margin: '0 auto' }}>
          {Array.from({ length: Math.min(pageCount, 2) }, (_, i) => (
            <div key={i} style={{
              width: '100%', aspectRatio: '8.5/11', background: '#f3f4f6',
              borderRadius: 4, marginBottom: 8,
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

function PageWithOverlay({ pageIndex, width, renderOverlay, onPageClick }: {
  pageIndex: number;
  width: number;
  renderOverlay: PDFViewerProps['renderOverlay'];
  onPageClick?: PDFViewerProps['onPageClick'];
}) {
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const onRenderSuccess = useCallback(() => {
    if (wrapperRef.current) {
      const canvas = wrapperRef.current.querySelector('canvas');
      if (canvas) {
        setCanvasSize({
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        });
      }
    }
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!onPageClick || !canvasSize) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relativeX = (e.clientX - rect.left) / canvasSize.width;
    const relativeY = (e.clientY - rect.top) / canvasSize.height;
    onPageClick(pageIndex, relativeX, relativeY);
  }, [onPageClick, pageIndex, canvasSize]);

  return (
    <div
      ref={wrapperRef}
      className="document-page"
      style={{
        position: 'relative',
        background: 'white',
        borderBottom: '1px solid var(--gray-200)',
        cursor: onPageClick ? 'crosshair' : undefined,
      }}
    >
      <Page
        pageNumber={pageIndex + 1}
        width={width}
        renderAnnotationLayer={false}
        renderTextLayer={false}
        onRenderSuccess={onRenderSuccess}
      />
      {canvasSize && (
        <div
          className="field-overlay-container"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: canvasSize.width,
            height: canvasSize.height,
            zIndex: 10,
            pointerEvents: onPageClick ? 'auto' : 'none',
            touchAction: 'pan-y',
          }}
          onClick={handleClick}
        >
          <div style={{ position: 'relative', width: '100%', height: '100%', pointerEvents: 'none' }}>
            {renderOverlay(pageIndex, canvasSize)}
          </div>
        </div>
      )}
    </div>
  );
}
