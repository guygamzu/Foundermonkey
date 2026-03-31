import crypto from 'crypto';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { StorageService } from './StorageService.js';
import { AIService } from './AIService.js';
import { FieldDetectionService } from './FieldDetectionService.js';
import { logger } from '../config/logger.js';

export class DocumentService {
  private fieldDetectionService: FieldDetectionService;

  constructor(
    private documentRepo: DocumentRepository,
    private auditRepo: AuditRepository,
    private storageService: StorageService,
    private aiService: AIService,
  ) {
    this.fieldDetectionService = new FieldDetectionService();
  }

  async processUploadedDocument(
    senderId: string,
    fileBuffer: Buffer,
    fileName: string,
    signerCount: number,
    signerDescriptions?: string[],
  ): Promise<{
    documentId: string;
    fields: Array<{ type: string; page: number; x: number; y: number; width: number; height: number; signerIndex: number }>;
    pageCount: number;
    hash: string;
  }> {
    // Validate PDF
    if (fileBuffer.length > 25 * 1024 * 1024) {
      throw new Error('File too large. Maximum file size is 25MB.');
    }

    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pageCount = pdfDoc.getPageCount();

    if (pageCount > 100) {
      throw new Error('Document too long. Maximum is 100 pages.');
    }

    // Generate document hash
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Extract text for AI analysis
    const documentText = await this.extractTextFromPdf(fileBuffer, pageCount);
    logger.info({ textLength: documentText.length, preview: documentText.substring(0, 200) }, 'PDF text extracted');

    // Multi-layer field detection (AcroForm → TextAnchor → AI)
    const detectedFields = await this.fieldDetectionService.detectFields(
      fileBuffer,
      pageCount,
      signerCount,
      signerDescriptions,
      documentText,
    );
    logger.info({
      fieldCount: detectedFields.length,
      fields: detectedFields.map(f => `${f.type}[${f.source}]@p${f.page}(${f.x.toFixed(3)},${f.y.toFixed(3)}) signer=${f.signerIndex}`),
    }, 'Field detection complete');

    // Upload to S3
    const documentId = crypto.randomUUID();
    const s3Key = this.storageService.generateKey(senderId, documentId, fileName);
    await this.storageService.uploadDocument(s3Key, fileBuffer, 'application/pdf');

    // Create document request record
    const doc = await this.documentRepo.create({
      id: documentId,
      sender_id: senderId,
      status: 'pending_confirmation',
      file_name: fileName,
      file_size: fileBuffer.length,
      page_count: pageCount,
      mime_type: 'application/pdf',
      document_hash: hash,
      s3_key: s3Key,
      is_sequential: false,
      credits_required: signerCount,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    });

    logger.info({ documentId, pageCount, fieldCount: detectedFields.length }, 'Document processed');

    return {
      documentId: doc.id,
      fields: detectedFields,
      pageCount,
      hash,
    };
  }

  private async extractTextFromPdf(fileBuffer: Buffer, pageCount: number): Promise<string> {
    try {
      const pdfParseModule: any = await import('pdf-parse');
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const result = await pdfParse(fileBuffer);
      if (result.text && result.text.trim().length > 0) {
        return result.text;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: errMsg }, 'pdf-parse failed, using page markers');
    }

    // Fallback if text extraction fails (e.g., scanned PDFs)
    const textParts: string[] = [];
    for (let i = 0; i < pageCount; i++) {
      textParts.push(`[Page ${i + 1}]`);
    }
    return textParts.join('\n');
  }

  async applySignaturesToDocument(
    documentId: string,
  ): Promise<Buffer> {
    const doc = await this.documentRepo.findById(documentId);
    if (!doc) throw new Error('Document not found');

    const pdfBuffer = await this.storageService.getDocument(doc.s3_key);
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    const fields = await this.documentRepo.findFieldsByDocumentId(documentId);
    const signers = await this.documentRepo.findSignersByDocumentId(documentId);
    const signerMap = new Map(signers.map(s => [s.id, s]));

    logger.info({
      documentId,
      pageCount: pdfDoc.getPageCount(),
      fieldCount: fields.length,
      fieldsWithValues: fields.filter(f => f.value).length,
    }, 'Applying signatures to document');

    for (const field of fields) {
      if (!field.value) continue;

      if (field.page < 1 || field.page > pdfDoc.getPageCount()) {
        logger.warn({ fieldId: field.id, page: field.page, pageCount: pdfDoc.getPageCount() }, 'Field references invalid page, skipping');
        continue;
      }

      const page = pdfDoc.getPage(field.page - 1);
      const { width: pageWidth, height: pageHeight } = page.getSize();

      // Convert from top-left origin (AI coordinates) to bottom-left origin (pdf-lib)
      const x = field.x * pageWidth;
      const y = pageHeight - (field.y * pageHeight) - (field.height * pageHeight);
      const width = field.width * pageWidth;
      const height = field.height * pageHeight;

      logger.info({
        fieldId: field.id,
        type: field.type,
        page: field.page,
        normalized: { x: field.x, y: field.y, w: field.width, h: field.height },
        absolute: { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) },
        pageSize: { w: Math.round(pageWidth), h: Math.round(pageHeight) },
      }, 'Rendering field on signed PDF');

      if (field.type === 'signature' || field.type === 'initial') {
        // Check if value is a drawn signature (data URL) or typed text
        if (field.value.startsWith('data:image/png;base64,')) {
          try {
            // Extract base64 data and embed as PNG image
            const base64Data = field.value.replace('data:image/png;base64,', '');
            const imageBytes = Buffer.from(base64Data, 'base64');
            const pngImage = await pdfDoc.embedPng(imageBytes);

            // Scale image to fit within the field bounds while preserving aspect ratio
            const imgAspect = pngImage.width / pngImage.height;
            const fieldAspect = width / height;
            let drawWidth = width;
            let drawHeight = height;
            if (imgAspect > fieldAspect) {
              drawHeight = width / imgAspect;
            } else {
              drawWidth = height * imgAspect;
            }

            page.drawImage(pngImage, {
              x: x + (width - drawWidth) / 2,
              y: y + (height - drawHeight) / 2,
              width: drawWidth,
              height: drawHeight,
            });
          } catch (imgErr) {
            // Fallback to text if image embedding fails
            const signer = signerMap.get(field.signer_id);
            const sigText = signer?.name || signer?.email || 'Signed';
            page.drawText(sigText, {
              x: x + 4,
              y: y + height / 3,
              size: Math.min(height * 0.6, 14),
              font: italicFont,
              color: rgb(0, 0, 0.7),
            });
            logger.warn({ error: imgErr instanceof Error ? imgErr.message : String(imgErr) }, 'Failed to embed signature image, using text fallback');
          }
        } else {
          // Typed signature - render in italic/cursive style
          const sigText = field.value;
          const fontSize = Math.min(height * 0.6, 16);
          page.drawText(sigText, {
            x: x + 4,
            y: y + height * 0.3,
            size: fontSize,
            font: italicFont,
            color: rgb(0, 0, 0.7),
          });
        }

        // Draw underline beneath signature
        page.drawLine({
          start: { x, y },
          end: { x: x + width, y },
          thickness: 0.5,
          color: rgb(0, 0, 0),
        });
      } else {
        // Date, text, name, title — all render as text
        const fontSize = Math.min(height * 0.7, 11);
        page.drawText(field.value, {
          x: x + 2,
          y: y + height * 0.25,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }

    // Save with compatibility options to prevent PDF corruption
    const signedBytes = await pdfDoc.save({ useObjectStreams: false });
    logger.info({
      documentId,
      originalSize: pdfBuffer.length,
      signedSize: signedBytes.length,
      pageCount: pdfDoc.getPageCount(),
    }, 'Signed PDF generated');
    return Buffer.from(signedBytes);
  }

  async generateCertificateOfCompletion(documentId: string): Promise<Buffer> {
    const doc = await this.documentRepo.findById(documentId);
    if (!doc) throw new Error('Document not found');

    const signers = await this.documentRepo.findSignersByDocumentId(documentId);
    const auditEvents = await this.auditRepo.findByDocumentId(documentId);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const margin = 50;
    let currentPage = pdfDoc.addPage([612, 792]);
    let y = 740;

    const ensureSpace = (needed: number) => {
      if (y - needed < 50) {
        currentPage = pdfDoc.addPage([612, 792]);
        y = 740;
      }
    };

    // Title
    currentPage.drawText('Certificate of Completion', {
      x: margin,
      y,
      size: 24,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    y -= 40;

    // Document info
    currentPage.drawText(`Document: ${doc.file_name}`, { x: margin, y, size: 12, font });
    y -= 20;
    currentPage.drawText(`Document Hash (SHA-256): ${doc.document_hash}`, { x: margin, y, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
    y -= 20;
    currentPage.drawText(`Completed: ${doc.completed_at?.toISOString() || 'N/A'}`, { x: margin, y, size: 12, font });
    y -= 30;

    // Signers
    currentPage.drawText('Signers', { x: margin, y, size: 16, font: boldFont });
    y -= 25;

    for (const signer of signers) {
      ensureSpace(60);
      const identifier = signer.email || signer.phone || 'Unknown';
      currentPage.drawText(`• ${signer.name || identifier}`, { x: margin + 10, y, size: 11, font: boldFont });
      y -= 16;
      currentPage.drawText(`  Contact: ${identifier}`, { x: margin + 10, y, size: 10, font });
      y -= 16;
      currentPage.drawText(`  Status: ${signer.status} | Signed: ${signer.signed_at?.toISOString() || 'N/A'}`, { x: margin + 10, y, size: 10, font });
      y -= 22;
    }

    // Audit trail
    ensureSpace(40);
    y -= 10;
    currentPage.drawText('Audit Trail', { x: margin, y, size: 16, font: boldFont });
    y -= 25;

    for (const event of auditEvents) {
      ensureSpace(40);
      const timestamp = event.created_at.toISOString();
      currentPage.drawText(`${timestamp} - ${event.action}`, { x: margin + 10, y, size: 9, font });
      y -= 14;
      const ua = event.user_agent ? event.user_agent.substring(0, 60) : 'N/A';
      currentPage.drawText(`  IP: ${event.ip_address || 'N/A'} | UA: ${ua}`, {
        x: margin + 10, y, size: 8, font, color: rgb(0.5, 0.5, 0.5),
      });
      y -= 18;
    }

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }
}
