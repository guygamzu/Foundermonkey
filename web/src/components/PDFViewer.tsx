'use client';

import { useState, useCallback, useRef } from 'react';
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
  const [renderedSizes, setRenderedSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [loadError, setLoadError] = useState(false);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // After the Page renders, measure the actual canvas element to get precise dimensions
  const onPageRenderSuccess = useCallback((pageIndex: number) => {
    const container = pageRefs.current[pageIndex];
    if (!container) return;
    // react-pdf renders a canvas inside the Page component
    const canvas = container.querySelector('canvas');
    if (canvas) {
      setRenderedSizes(prev => ({
        ...prev,
        [pageIndex]: { width: canvas.clientWidth, height: canvas.clientHeight },
      }));
    }
  }, []);

  const getPageWidth = () => Math.min(typeof window !== 'undefined' ? window.innerWidth - 32 : 800, 800);

  if (loadError) {
    return null;
  }

  return (
    <Document
      file={url}
      onLoadError={() => { setLoadError(true); onError?.(); }}
      loading={
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray-400)' }}>
          Loading PDF...
        </div>
      }
    >
      {Array.from({ length: pageCount }, (_, pageIndex) => {
        const size = renderedSizes[pageIndex];
        return (
          <div
            key={pageIndex}
            className="document-page"
            ref={(el) => { pageRefs.current[pageIndex] = el; }}
            style={{ position: 'relative', background: 'white', borderBottom: '1px solid var(--gray-200)' }}
          >
            <Page
              pageNumber={pageIndex + 1}
              width={getPageWidth()}
              onRenderSuccess={() => onPageRenderSuccess(pageIndex)}
              renderAnnotationLayer={false}
              renderTextLayer={false}
            />
            {/* Overlay positioned exactly over the rendered canvas */}
            {size && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: size.width,
                  height: size.height,
                  zIndex: 10,
                  pointerEvents: 'none',
                }}
              >
                <div style={{ position: 'relative', width: '100%', height: '100%', pointerEvents: 'auto' }}>
                  {renderOverlay(pageIndex, size)}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Document>
  );
}
