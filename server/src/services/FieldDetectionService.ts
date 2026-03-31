import { PDFDocument } from 'pdf-lib';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../config/logger.js';

export interface DetectedField {
  type: 'signature' | 'initial' | 'date' | 'text' | 'name' | 'title';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  signerIndex: number;
  label?: string;
  source: 'acroform' | 'textanchor' | 'ai' | 'default';
}

interface TextItem {
  text: string;
  page: number;       // 1-based
  x: number;          // normalized 0–1, from left
  y: number;          // normalized 0–1, from top
  width: number;      // normalized
  height: number;     // normalized
}

/**
 * Multi-layer field detection inspired by DocuSign's architecture:
 *
 * Layer 1: AcroForm parsing — deterministic extraction of existing PDF form fields
 * Layer 2: Text anchor matching — find "Signature:", "Date:", underlines with exact positions
 * Layer 3: AI semantic matching — Claude matches signers to detected field regions
 */
export class FieldDetectionService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async detectFields(
    pdfBuffer: Buffer,
    pageCount: number,
    signerCount: number,
    signerDescriptions?: string[],
    documentText?: string,
  ): Promise<DetectedField[]> {
    // --- Layer 1: AcroForm field extraction ---
    const acroFields = await this.extractAcroFormFields(pdfBuffer, pageCount);
    logger.info({ count: acroFields.length }, 'Layer 1 (AcroForm): fields extracted');

    if (acroFields.length >= signerCount) {
      // AcroForm has enough fields — use AI only for signer assignment
      const assigned = await this.assignSignersToFields(
        acroFields, signerCount, signerDescriptions, documentText,
      );
      if (assigned.length > 0) {
        logger.info({ count: assigned.length }, 'Using AcroForm fields with AI signer assignment');
        return assigned;
      }
    }

    // --- Layer 2: Text anchor matching ---
    const textItems = await this.extractTextPositions(pdfBuffer);
    const anchorFields = this.findFieldsByTextAnchors(textItems, pageCount);
    logger.info({ count: anchorFields.length, textItems: textItems.length }, 'Layer 2 (TextAnchor): fields detected');

    if (anchorFields.length >= signerCount) {
      const assigned = await this.assignSignersToFields(
        anchorFields, signerCount, signerDescriptions, documentText,
      );
      if (assigned.length > 0) {
        logger.info({ count: assigned.length }, 'Using text-anchor fields with AI signer assignment');
        return assigned;
      }
    }

    // --- Layer 3: AI with structured text positions as context ---
    // Instead of asking AI for raw coordinates, give it the text positions
    // and ask it to identify which detected anchors belong to which signer
    const aiFields = await this.aiDetectWithTextContext(
      pdfBuffer, textItems, anchorFields, pageCount, signerCount, signerDescriptions, documentText,
    );
    logger.info({ count: aiFields.length }, 'Layer 3 (AI): fields detected');

    if (aiFields.length > 0) return aiFields;

    // --- Fallback: default fields ---
    logger.warn('All layers failed, using default field placement');
    return this.getDefaultFields(pageCount, signerCount);
  }

  // =========================================================================
  // Layer 1: AcroForm field extraction
  // =========================================================================
  private async extractAcroFormFields(pdfBuffer: Buffer, pageCount: number): Promise<DetectedField[]> {
    const fields: DetectedField[] = [];
    try {
      const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
      const form = pdfDoc.getForm();
      const formFields = form.getFields();

      for (const field of formFields) {
        const fieldName = field.getName().toLowerCase();
        const widgets = field.acroField.getWidgets();

        for (const widget of widgets) {
          const rect = widget.getRectangle();
          // Find which page this widget belongs to
          const widgetPageRef = widget.P();
          let pageIndex = 0;
          if (widgetPageRef) {
            const pages = pdfDoc.getPages();
            for (let i = 0; i < pages.length; i++) {
              if (pages[i].ref === widgetPageRef) {
                pageIndex = i;
                break;
              }
            }
          }

          const page = pdfDoc.getPage(pageIndex);
          const { width: pw, height: ph } = page.getSize();

          // Convert pdf-lib coordinates (bottom-left origin) to top-left origin normalized
          const x = rect.x / pw;
          const y = 1 - (rect.y + rect.height) / ph; // flip Y
          const w = rect.width / pw;
          const h = rect.height / ph;

          // Determine field type from AcroForm field type + name heuristics
          let type: DetectedField['type'] = 'text';
          const fieldType = field.constructor.name;

          if (fieldType === 'PDFSignature' || fieldName.includes('sig')) {
            type = 'signature';
          } else if (fieldName.includes('date')) {
            type = 'date';
          } else if (fieldName.includes('initial')) {
            type = 'initial';
          } else if (fieldName.includes('name') || fieldName.includes('print')) {
            type = 'name';
          } else if (fieldName.includes('title') || fieldName.includes('role')) {
            type = 'title';
          }

          fields.push({
            type,
            page: pageIndex + 1,
            x: Math.max(0, Math.min(0.95, x)),
            y: Math.max(0, Math.min(0.95, y)),
            width: Math.max(0.05, Math.min(0.5, w)),
            height: Math.max(0.02, Math.min(0.1, h)),
            signerIndex: 0, // will be assigned later
            label: field.getName(),
            source: 'acroform',
          });
        }
      }
    } catch (err) {
      // Many PDFs have no form fields — this is expected
      logger.debug({ error: err instanceof Error ? err.message : String(err) }, 'AcroForm extraction: no form fields found');
    }
    return fields;
  }

  // =========================================================================
  // Layer 2: Text anchor matching using pdfjs-dist
  // =========================================================================
  private async extractTextPositions(pdfBuffer: Buffer): Promise<TextItem[]> {
    const items: TextItem[] = [];
    try {
      // Dynamic import for ESM compatibility
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer),
        useSystemFonts: true,
        disableFontFace: true,
      });
      const pdf = await loadingTask.promise;

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const textContent = await page.getTextContent();

        for (const item of textContent.items) {
          if (!('str' in item) || !item.str.trim()) continue;

          const tx = item.transform;
          // transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
          const pdfX = tx[4];
          const pdfY = tx[5];
          const textWidth = item.width || 0;
          const textHeight = item.height || Math.abs(tx[3]);

          // Normalize to 0–1 using viewport dimensions (top-left origin)
          items.push({
            text: item.str,
            page: pageNum,
            x: pdfX / viewport.width,
            y: 1 - (pdfY / viewport.height), // flip Y from bottom-left to top-left
            width: textWidth / viewport.width,
            height: textHeight / viewport.height,
          });
        }

        page.cleanup();
      }
      pdf.cleanup();
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'pdfjs-dist text extraction failed');
    }
    return items;
  }

  private findFieldsByTextAnchors(textItems: TextItem[], pageCount: number): DetectedField[] {
    const fields: DetectedField[] = [];

    // Patterns that indicate signature-related fields
    const signatureAnchors = [
      /signature/i, /sign\s*here/i, /authorized\s*sign/i, /\bsigned?\b/i,
    ];
    const dateAnchors = [/\bdate\b/i, /dated?\s*:/i];
    const nameAnchors = [
      /print\s*name/i, /printed?\s*name/i, /\bname\s*:/i, /\bname\s*\(/i,
    ];
    const titleAnchors = [/\btitle\s*:/i, /\brole\s*:/i, /\bposition\s*:/i];
    const initialAnchors = [/\binitial/i];

    // Also look for underline patterns in the text (sequences of underscores)
    const underlinePattern = /_{3,}|\.{5,}|-{5,}/;

    for (const item of textItems) {
      let type: DetectedField['type'] | null = null;
      let label = '';

      if (signatureAnchors.some(p => p.test(item.text))) {
        type = 'signature';
        label = item.text.trim();
      } else if (dateAnchors.some(p => p.test(item.text))) {
        type = 'date';
        label = item.text.trim();
      } else if (nameAnchors.some(p => p.test(item.text))) {
        type = 'name';
        label = item.text.trim();
      } else if (titleAnchors.some(p => p.test(item.text))) {
        type = 'title';
        label = item.text.trim();
      } else if (initialAnchors.some(p => p.test(item.text))) {
        type = 'initial';
        label = item.text.trim();
      }

      if (type) {
        // Look for an adjacent underline (blank space to fill)
        const nearbyUnderline = this.findNearbyUnderline(textItems, item);

        let fieldX = item.x + item.width + 0.01; // right of label
        let fieldWidth = type === 'signature' ? 0.25 : type === 'date' ? 0.15 : 0.22;
        let fieldHeight = type === 'signature' ? 0.045 : 0.03;

        // CRITICAL: item.y is the text BASELINE position (top-left origin).
        // The field must sit ABOVE the baseline (where the signer writes).
        // So we offset Y upward by the field height: the field BOTTOM aligns
        // with the text baseline, and the field extends UPWARD.
        let fieldY = item.y - fieldHeight;

        if (nearbyUnderline) {
          // Use the underline's position for precise placement
          fieldX = nearbyUnderline.x;
          // Place field so its bottom is at the underline, extending upward
          fieldY = nearbyUnderline.y - fieldHeight;
          fieldWidth = Math.max(fieldWidth, nearbyUnderline.width);
        } else {
          // If the label text contains the underline itself (e.g., "Signature: ________")
          if (underlinePattern.test(item.text)) {
            const underlineStart = item.text.search(underlinePattern);
            const textBeforeUnderline = item.text.substring(0, underlineStart);
            // Estimate position: fraction of text before underline
            const ratio = textBeforeUnderline.length / item.text.length;
            fieldX = item.x + item.width * ratio;
            fieldWidth = item.width * (1 - ratio);
            // Y stays at item.y - fieldHeight (above the line)
          }
        }

        // Clamp values
        fieldX = Math.max(0, Math.min(0.95, fieldX));
        fieldY = Math.max(0, Math.min(0.95, fieldY));
        fieldWidth = Math.max(0.05, Math.min(0.5, fieldWidth));

        fields.push({
          type,
          page: item.page,
          x: fieldX,
          y: fieldY,
          width: fieldWidth,
          height: fieldHeight,
          signerIndex: 0, // will be assigned later
          label,
          source: 'textanchor',
        });
      }
    }

    // Deduplicate: if multiple anchors point to roughly the same location, keep only one
    return this.deduplicateFields(fields);
  }

  private findNearbyUnderline(textItems: TextItem[], anchor: TextItem): TextItem | null {
    const underlinePattern = /^[_\.\-]{3,}$/;
    const tolerance = 0.03; // 3% of page height

    // Look for underline on same line (to the right) or next line (below)
    for (const item of textItems) {
      if (item.page !== anchor.page) continue;
      if (!underlinePattern.test(item.text.trim())) continue;

      const sameRow = Math.abs(item.y - anchor.y) < tolerance;
      const nextRow = item.y > anchor.y && item.y - anchor.y < tolerance * 3;
      const toRight = item.x > anchor.x;

      if ((sameRow && toRight) || nextRow) {
        return item;
      }
    }
    return null;
  }

  private deduplicateFields(fields: DetectedField[]): DetectedField[] {
    const result: DetectedField[] = [];
    for (const field of fields) {
      const isDuplicate = result.some(existing =>
        existing.page === field.page &&
        existing.type === field.type &&
        Math.abs(existing.x - field.x) < 0.08 &&
        Math.abs(existing.y - field.y) < 0.04,
      );
      if (!isDuplicate) result.push(field);
    }
    return result;
  }

  // =========================================================================
  // Layer 3: AI semantic matching
  // =========================================================================
  private async aiDetectWithTextContext(
    pdfBuffer: Buffer,
    textItems: TextItem[],
    anchorFields: DetectedField[],
    pageCount: number,
    signerCount: number,
    signerDescriptions?: string[],
    documentText?: string,
  ): Promise<DetectedField[]> {
    const hasSignerNames = signerDescriptions && signerDescriptions.length > 0;
    const signerList = hasSignerNames
      ? signerDescriptions!.map((d, i) => `  Signer ${i} → ${d}`).join('\n')
      : `  ${signerCount} signer(s) — names not specified`;

    // Build a structured map of text positions for the AI
    const positionMap = this.buildTextPositionSummary(textItems);

    // If we found anchor fields, include them so the AI can refine rather than start from scratch
    const anchorContext = anchorFields.length > 0
      ? `\nPRE-DETECTED FIELD CANDIDATES (from text analysis — refine these positions and assign signers):
${anchorFields.map((f, i) => `  [${i}] type=${f.type} page=${f.page} x=${f.x.toFixed(3)} y=${f.y.toFixed(3)} w=${f.width.toFixed(3)} h=${f.height.toFixed(3)} label="${f.label}"`).join('\n')}\n`
      : '';

    const prompt = `You are an e-signature field detection system. Your job is to identify EXACTLY where each signer should sign, date, and fill fields in the document.

SIGNERS:
${signerList}

${anchorContext}
TEXT POSITION MAP (text found in the document with normalized page coordinates, top-left origin):
${positionMap}

The PDF document is attached. Look at it carefully.

YOUR TASK:
${anchorFields.length > 0
  ? `I've already detected ${anchorFields.length} potential field locations from text analysis (listed above as PRE-DETECTED FIELD CANDIDATES). For each:
1. VERIFY the position is correct by looking at the PDF visually
2. ADJUST coordinates if they seem off (the text extraction coordinates are approximate)
3. ASSIGN each field to the correct signer (signerIndex) by matching signer names to nearby text
4. ADD any missing fields (e.g., if a date field exists but wasn't detected)`
  : `Analyze the document to find signature blocks for each signer. Use the TEXT POSITION MAP above to identify where signer names, "Signature:", "Date:", etc. appear.`}

COORDINATE SYSTEM:
- Origin (0,0) = TOP-LEFT corner of the page
- x: 0.0=left edge, 1.0=right edge
- y: 0.0=top edge, 1.0=bottom edge
- The (x,y) is the TOP-LEFT corner of the field rectangle
- The field EXTENDS DOWNWARD from y by its height

CRITICAL POSITIONING RULE:
- The y coordinate should place the field ABOVE the signature line
- For a signature line at vertical position P, set y = P - height
  so the field bottom touches the line and extends upward
- Example: if a signature line is at y=0.85 on the page,
  set y=0.805 (=0.85-0.045) for a signature field (height=0.045)

FIELD SIZES:
- signature: width=0.25, height=0.045
- date: width=0.15, height=0.03
- name/title: width=0.22, height=0.03

Return ONLY a JSON array (no markdown, no explanation):
[{"type":"signature","page":1,"x":0.12,"y":0.805,"width":0.25,"height":0.045,"signerIndex":0,"label":"Signer Name Signature"}]`;

    const content: Anthropic.MessageParam['content'] = [];

    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: pdfBuffer.toString('base64'),
      },
    } as any);
    content.push({ type: 'text', text: prompt });

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      logger.info({ rawAIResponse: text.substring(0, 500) }, 'AI field detection (Layer 3) raw response');

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn('AI returned no JSON array');
        return [];
      }

      let fields = JSON.parse(jsonMatch[0]) as DetectedField[];

      // Validate and clamp
      fields = fields.filter(f => {
        if (!f.type || !f.page || f.page < 1 || f.page > pageCount) return false;
        if (typeof f.x !== 'number' || typeof f.y !== 'number') return false;
        return true;
      }).map(f => ({
        ...f,
        type: (['signature', 'initial', 'date', 'text', 'name', 'title'].includes(f.type) ? f.type : 'text') as DetectedField['type'],
        x: Math.max(0, Math.min(0.95, f.x)),
        y: Math.max(0, Math.min(0.95, f.y)),
        width: Math.max(0.05, Math.min(0.5, f.width || 0.25)),
        height: Math.max(0.02, Math.min(0.1, f.height || 0.04)),
        signerIndex: Math.max(0, Math.min(signerCount - 1, f.signerIndex || 0)),
        source: 'ai' as const,
      }));

      return fields;
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'AI field detection failed');
      return [];
    }
  }

  /**
   * Use AI to assign signers to pre-detected fields (from AcroForm or text anchors)
   */
  private async assignSignersToFields(
    fields: DetectedField[],
    signerCount: number,
    signerDescriptions?: string[],
    documentText?: string,
  ): Promise<DetectedField[]> {
    if (signerCount <= 1) {
      // Only one signer — assign all fields to signer 0
      return fields.map(f => ({ ...f, signerIndex: 0 }));
    }

    if (!signerDescriptions || signerDescriptions.length === 0) {
      // No signer info — distribute evenly by order
      return fields.map((f, i) => ({ ...f, signerIndex: i % signerCount }));
    }

    // Use AI to match fields to signers based on labels and document context
    const fieldSummary = fields.map((f, i) =>
      `  Field ${i}: type=${f.type}, page=${f.page}, y=${f.y.toFixed(3)}, label="${f.label || ''}"`,
    ).join('\n');

    const signerList = signerDescriptions.map((d, i) => `  Signer ${i}: ${d}`).join('\n');

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Assign each detected form field to the correct signer.

SIGNERS:
${signerList}

DETECTED FIELDS:
${fieldSummary}

${documentText ? `DOCUMENT TEXT (excerpt):\n${documentText.substring(0, 5000)}` : ''}

For each field, determine which signer it belongs to based on:
- Field label/name containing signer's name
- Position on the page (fields near a signer's printed name belong to that signer)
- Document context

Return ONLY a JSON array mapping field index to signer index:
[{"fieldIndex": 0, "signerIndex": 0}, {"fieldIndex": 1, "signerIndex": 1}]`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return fields;

      const assignments = JSON.parse(jsonMatch[0]) as Array<{ fieldIndex: number; signerIndex: number }>;
      const result = [...fields];
      for (const a of assignments) {
        if (a.fieldIndex >= 0 && a.fieldIndex < result.length) {
          result[a.fieldIndex].signerIndex = Math.max(0, Math.min(signerCount - 1, a.signerIndex));
        }
      }
      return result;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'AI signer assignment failed, using fallback');
      return fields;
    }
  }

  private buildTextPositionSummary(textItems: TextItem[]): string {
    if (textItems.length === 0) return '(no text positions available)';

    // Group by page and filter to relevant items (labels, names, underlines)
    const relevantPatterns = [
      /signature/i, /sign/i, /date/i, /name/i, /title/i, /initial/i,
      /print/i, /_{3,}/, /\.{5,}/, /by:/i, /authorized/i, /witness/i,
      /company/i, /address/i, /agreed/i, /party/i,
    ];

    const byPage = new Map<number, TextItem[]>();
    for (const item of textItems) {
      // Include items that match relevant patterns, or are long underlines
      const isRelevant = relevantPatterns.some(p => p.test(item.text)) ||
        item.text.length > 20; // also include substantial text for context

      if (isRelevant) {
        if (!byPage.has(item.page)) byPage.set(item.page, []);
        byPage.get(item.page)!.push(item);
      }
    }

    const lines: string[] = [];
    for (const [page, items] of byPage) {
      lines.push(`  Page ${page}:`);
      // Sort by Y position (top to bottom)
      items.sort((a, b) => a.y - b.y);
      for (const item of items.slice(0, 30)) { // limit per page
        lines.push(`    y=${item.y.toFixed(3)} x=${item.x.toFixed(3)} "${item.text.substring(0, 60)}"`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : '(no relevant text positions found)';
  }

  private getDefaultFields(pageCount: number, signerCount: number): DetectedField[] {
    const fields: DetectedField[] = [];
    for (let i = 0; i < signerCount; i++) {
      const yOffset = 0.78 + i * 0.08;
      fields.push({
        type: 'signature',
        page: pageCount,
        x: 0.08,
        y: Math.min(yOffset, 0.92),
        width: 0.32,
        height: 0.045,
        signerIndex: i,
        label: `Signer ${i + 1} Signature`,
        source: 'default',
      });
      fields.push({
        type: 'date',
        page: pageCount,
        x: 0.55,
        y: Math.min(yOffset, 0.92),
        width: 0.18,
        height: 0.035,
        signerIndex: i,
        label: `Signer ${i + 1} Date`,
        source: 'default',
      });
    }
    return fields;
  }
}
