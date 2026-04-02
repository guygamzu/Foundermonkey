import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { logger } from '../config/logger.js';

/** File types we can convert to PDF via LibreOffice */
const CONVERTIBLE_EXTENSIONS = new Set([
  '.doc', '.docx',        // Word
  '.xls', '.xlsx',        // Excel
  '.ppt', '.pptx',        // PowerPoint
  '.odt', '.ods', '.odp', // OpenDocument
  '.rtf',                 // Rich Text
  '.txt',                 // Plain text
]);

const CONVERTIBLE_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf',
  'text/plain',
]);

/**
 * Check if a file can be converted to PDF based on its name or MIME type.
 */
export function isConvertibleToPage(filename: string, contentType?: string): boolean {
  const ext = path.extname(filename || '').toLowerCase();
  if (CONVERTIBLE_EXTENSIONS.has(ext)) return true;
  if (contentType && CONVERTIBLE_MIME_TYPES.has(contentType.toLowerCase())) return true;
  return false;
}

/**
 * Convert a document buffer (DOC, DOCX, etc.) to PDF using LibreOffice.
 * Returns the PDF buffer and the new filename.
 */
export async function convertToPdf(
  content: Buffer,
  originalFilename: string,
): Promise<{ pdfBuffer: Buffer; pdfFilename: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lapen-convert-'));
  const inputPath = path.join(tmpDir, originalFilename || `document-${crypto.randomUUID()}.docx`);

  try {
    // Write input file
    await fs.writeFile(inputPath, content);

    // Convert to PDF via LibreOffice
    await new Promise<void>((resolve, reject) => {
      const cmd = `libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${inputPath}"`;
      exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          logger.error({ error: error.message, stderr }, 'LibreOffice conversion failed');
          reject(new Error(`PDF conversion failed: ${error.message}`));
        } else {
          resolve();
        }
      });
    });

    // Find the output PDF
    const baseName = path.basename(originalFilename || 'document', path.extname(originalFilename || '.docx'));
    const pdfPath = path.join(tmpDir, `${baseName}.pdf`);

    const pdfBuffer = await fs.readFile(pdfPath);
    const pdfFilename = `${baseName}.pdf`;

    logger.info({ original: originalFilename, pdfSize: pdfBuffer.length }, 'Document converted to PDF');

    return { pdfBuffer, pdfFilename };
  } finally {
    // Cleanup temp files
    try {
      const files = await fs.readdir(tmpDir);
      for (const file of files) {
        await fs.unlink(path.join(tmpDir, file));
      }
      await fs.rmdir(tmpDir);
    } catch (_) {
      // Non-critical cleanup failure
    }
  }
}
