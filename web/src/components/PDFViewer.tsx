'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure PDF.js worker (self-hosted for faster loading)
pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;

interface PDFViewerProps {
  url: string;
  pageCount: number;
  renderOverlay: (pageIndex: number, dimensions: { width: number; height: number }) => React.ReactNode;
  onPageClick?: (pageIndex: number, relativeX: number, relativeY: number) => void;
  onError?: () => void;
}

export default function PDFViewer({ url, pageCount, renderOverlay, onPageClick, onError }: PDFViewerProps) {
  const [loadError, setLoadError] = useState(false);
  const [numPages, setNumPages] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

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

  if (loadError) {
    return null;
  }

  const totalPages = Math.max(numPages || 0, pageCount || 1);

  return (
    <div ref={containerRef}>
      {containerWidth > 0 && (
        <Document
          file={url}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={() => { setLoadError(true); onError?.(); }}
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
          }}
          onClick={handleClick}
        >
          <div style={{ position: 'relative', width: '100%', height: '100%', pointerEvents: 'auto' }}>
            {renderOverlay(pageIndex, canvasSize)}
          </div>
        </div>
      )}
    </div>
  );
}
