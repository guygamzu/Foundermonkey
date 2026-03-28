import crypto from 'crypto';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { DocumentRepository } from '../models/DocumentRepository.js';
import { AuditRepository } from '../models/AuditRepository.js';
import { StorageService } from './StorageService.js';
import { AIService } from './AIService.js';
import { logger } from '../config/logger.js';

export class DocumentService {
  constructor(
    private documentRepo: DocumentRepository,
    private auditRepo: AuditRepository,
    private storageService: StorageService,
    private aiService: AIService,
  ) {}

  async processUploadedDocument(
    senderId: string,
    fileBuffer: Buffer,
    fileName: string,
    signerCount: number,
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
    const documentText = await this.extractTextFromPdf(pdfDoc);

    // Use AI to detect fields
    const detectedFields = await this.aiService.detectDocumentFields(
      documentText,
      pageCount,
      signerCount,
    );

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

  private async extractTextFromPdf(pdfDoc: PDFDocument): Promise<string> {
    // pdf-lib doesn't support text extraction natively
    // In production, we'd use a library like pdf-parse or send to AI for OCR
    // For now, return a placeholder that the AI service can work with
    const pages = pdfDoc.getPages();
    const textParts: string[] = [];
    for (let i = 0; i < pages.length; i++) {
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
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const fields = await this.documentRepo.findFieldsByDocumentId(documentId);
    const signers = await this.documentRepo.findSignersByDocumentId(documentId);
    const signerMap = new Map(signers.map(s => [s.id, s]));

    for (const field of fields) {
      if (!field.value) continue;

      const page = pdfDoc.getPage(field.page - 1);
      const { width: pageWidth, height: pageHeight } = page.getSize();

      const x = field.x * pageWidth;
      const y = pageHeight - (field.y * pageHeight) - (field.height * pageHeight);
      const width = field.width * pageWidth;
      const height = field.height * pageHeight;

      if (field.type === 'signature' || field.type === 'initial') {
        // Draw signature text (in production, we'd render the actual signature image)
        const signer = signerMap.get(field.signer_id);
        const sigText = field.value || signer?.name || signer?.email || 'Signed';
        page.drawText(sigText, {
          x: x + 4,
          y: y + height / 3,
          size: Math.min(height * 0.6, 14),
          font,
          color: rgb(0, 0, 0.7),
        });
        // Draw underline
        page.drawLine({
          start: { x, y },
          end: { x: x + width, y },
          thickness: 0.5,
          color: rgb(0, 0, 0),
        });
      } else if (field.type === 'date') {
        page.drawText(field.value, {
          x: x + 2,
          y: y + 2,
          size: 10,
          font,
          color: rgb(0, 0, 0),
        });
      } else if (field.type === 'text') {
        page.drawText(field.value, {
          x: x + 2,
          y: y + 2,
          size: 10,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }

    const signedBytes = await pdfDoc.save();
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

    const page = pdfDoc.addPage([612, 792]); // Letter size
    let y = 740;
    const margin = 50;

    // Title
    page.drawText('Certificate of Completion', {
      x: margin,
      y,
      size: 24,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    y -= 40;

    // Document info
    page.drawText(`Document: ${doc.file_name}`, { x: margin, y, size: 12, font });
    y -= 20;
    page.drawText(`Document Hash (SHA-256): ${doc.document_hash}`, { x: margin, y, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
    y -= 20;
    page.drawText(`Completed: ${doc.completed_at?.toISOString() || 'N/A'}`, { x: margin, y, size: 12, font });
    y -= 30;

    // Signers
    page.drawText('Signers', { x: margin, y, size: 16, font: boldFont });
    y -= 25;

    for (const signer of signers) {
      const identifier = signer.email || signer.phone || 'Unknown';
      page.drawText(`• ${signer.name || identifier}`, { x: margin + 10, y, size: 11, font: boldFont });
      y -= 16;
      page.drawText(`  Contact: ${identifier}`, { x: margin + 10, y, size: 10, font });
      y -= 16;
      page.drawText(`  Status: ${signer.status} | Signed: ${signer.signed_at?.toISOString() || 'N/A'}`, { x: margin + 10, y, size: 10, font });
      y -= 22;
    }

    // Audit trail
    y -= 10;
    page.drawText('Audit Trail', { x: margin, y, size: 16, font: boldFont });
    y -= 25;

    for (const event of auditEvents) {
      if (y < 60) {
        // Add new page if needed
        const newPage = pdfDoc.addPage([612, 792]);
        y = 740;
        // Continue on new page - simplified for initial implementation
      }
      const timestamp = event.created_at.toISOString();
      page.drawText(`${timestamp} - ${event.action}`, { x: margin + 10, y, size: 9, font });
      y -= 14;
      page.drawText(`  IP: ${event.ip_address} | UA: ${event.user_agent.substring(0, 60)}`, {
        x: margin + 10, y, size: 8, font, color: rgb(0.5, 0.5, 0.5),
      });
      y -= 18;
    }

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }
}
