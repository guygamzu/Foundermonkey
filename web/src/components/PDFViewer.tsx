'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFViewerProps {
  url: string;
  pageCount: number;
  renderOverlay: (pageIndex: number, dimensions: { width: number; height: number }) => React.ReactNode;
  onError?: () => void;
}

export default function PDFViewer({ url, pageCount, renderOverlay, onError }: PDFViewerProps) {
  const [loadError, setLoadError] = useState(false);
  const [numPages, setNumPages] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Measure container width dynamically via ResizeObserver
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

  const totalPages = numPages || pageCount;

  return (
    <div ref={containerRef}>
      {containerWidth > 0 && (
        <Document
          file={url}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={() => { setLoadError(true); onError?.(); }}
          loading={
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)' }}>
              Loading PDF...
            </div>
          }
        >
          {Array.from({ length: totalPages }, (_, pageIndex) => (
            <PageWithOverlay
              key={pageIndex}
              pageIndex={pageIndex}
              width={containerWidth}
              renderOverlay={renderOverlay}
            />
          ))}
        </Document>
      )}
    </div>
  );
}

/**
 * Renders a single PDF page with an overlay container that exactly matches
 * the canvas dimensions, ensuring percentage-based field positioning is accurate.
 */
function PageWithOverlay({ pageIndex, width, renderOverlay }: {
  pageIndex: number;
  width: number;
  renderOverlay: PDFViewerProps['renderOverlay'];
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

  return (
    <div
      ref={wrapperRef}
      className="document-page"
      style={{
        position: 'relative',
        background: 'white',
        borderBottom: '1px solid var(--gray-200)',
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
            pointerEvents: 'none',
          }}
        >
          <div style={{ position: 'relative', width: '100%', height: '100%', pointerEvents: 'auto' }}>
            {renderOverlay(pageIndex, canvasSize)}
          </div>
        </div>
      )}
    </div>
  );
}
