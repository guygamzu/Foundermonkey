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
  const [loadError, setLoadError] = useState(false);
  const [numPages, setNumPages] = useState<number | null>(null);

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
  }, []);

  const pageWidth = typeof window !== 'undefined' ? Math.min(window.innerWidth - 32, 800) : 800;

  if (loadError) {
    return null;
  }

  // Use actual page count from PDF if available, otherwise use provided pageCount
  const totalPages = numPages || pageCount;

  return (
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
        <div
          key={pageIndex}
          className="document-page"
          style={{
            position: 'relative',
            background: 'white',
            borderBottom: '1px solid var(--gray-200)',
            // Ensure the page container doesn't overflow
            overflow: 'hidden',
          }}
        >
          <Page
            pageNumber={pageIndex + 1}
            width={pageWidth}
            renderAnnotationLayer={false}
            renderTextLayer={false}
          />
          {/*
            Overlay container: positioned absolutely over the entire page.
            react-pdf's <Page> with a width prop renders a canvas that fills
            the container, so the parent div's dimensions === canvas dimensions.
            Percentage-based child positions map correctly to the PDF page.
          */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <div style={{ position: 'relative', width: '100%', height: '100%', pointerEvents: 'auto' }}>
              {renderOverlay(pageIndex, { width: pageWidth, height: 0 })}
            </div>
          </div>
        </div>
      ))}
    </Document>
  );
}
