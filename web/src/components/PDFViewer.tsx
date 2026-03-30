'use client';

import { useState, useCallback } from 'react';
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
  const [pageDimensions, setPageDimensions] = useState<Record<number, { width: number; height: number }>>({});
  const [loadError, setLoadError] = useState(false);

  const onPageLoadSuccess = useCallback((pageIndex: number, page: { width: number; height: number }) => {
    setPageDimensions((prev) => ({
      ...prev,
      [pageIndex]: { width: page.width, height: page.height },
    }));
  }, []);

  if (loadError) {
    return null; // Caller will handle fallback
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
      {Array.from({ length: pageCount }, (_, pageIndex) => (
        <div
          key={pageIndex}
          className="document-page"
          style={{ position: 'relative', background: 'white', borderBottom: '1px solid var(--gray-200)' }}
        >
          <Page
            pageNumber={pageIndex + 1}
            width={Math.min(typeof window !== 'undefined' ? window.innerWidth - 32 : 800, 800)}
            onLoadSuccess={(page) =>
              onPageLoadSuccess(pageIndex, { width: page.width, height: page.height })
            }
            renderAnnotationLayer={false}
            renderTextLayer={true}
          />
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <div style={{ position: 'relative', width: '100%', height: '100%', pointerEvents: 'auto' }}>
              {renderOverlay(pageIndex, pageDimensions[pageIndex] || { width: 800, height: 1035 })}
            </div>
          </div>
        </div>
      ))}
    </Document>
  );
}
