import { logger } from '../config/logger.js';

/**
 * Extract text from a PDF buffer using pdfjs-dist legacy build (Node.js compatible).
 * Returns the full text content and page count.
 */
export async function extractPdfText(pdfBuffer: Buffer): Promise<{ text: string; pageCount: number }> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;

    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter((item: any) => 'str' in item && item.str.trim())
        .map((item: any) => item.str)
        .join(' ');
      pages.push(pageText);
    }

    return {
      text: pages.join('\n\n'),
      pageCount: pdf.numPages,
    };
  } catch (err) {
    logger.warn(`PDF text extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    // Try to at least get the page count even if text extraction failed
    const pageCount = extractPageCountFallback(pdfBuffer);
    return { text: '', pageCount };
  }
}

/**
 * Fallback page count extraction by counting /Type /Page entries in the raw PDF.
 * Works even when pdfjs-dist isn't available.
 */
function extractPageCountFallback(pdfBuffer: Buffer): number {
  try {
    const pdfStr = pdfBuffer.toString('latin1');
    // Count occurrences of "/Type /Page" (but not "/Type /Pages")
    const matches = pdfStr.match(/\/Type\s*\/Page(?!s)/g);
    return matches ? matches.length : 1;
  } catch {
    return 1;
  }
}
