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
    // --- Layer 1: AcroForm field extraction (deterministic, perfect accuracy) ---
    const acroFields = await this.extractAcroFormFields(pdfBuffer, pageCount);
    logger.info({ count: acroFields.length }, 'Layer 1 (AcroForm): fields extracted');

    if (acroFields.length >= signerCount) {
      const assigned = await this.assignSignersToFields(
        acroFields, signerCount, signerDescriptions, documentText,
      );
      if (assigned.length > 0) {
        logger.info({ count: assigned.length }, 'Using AcroForm fields with AI signer assignment');
        return assigned;
      }
    }

    // --- Layer 2: Extract text positions ---
    let textItems: TextItem[] = [];
    try {
      textItems = await this.extractTextPositions(pdfBuffer);
      logger.info({ textItems: textItems.length }, 'Text positions extracted');
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Text extraction failed completely');
    }

    // --- Layer 3: Deterministic text-based field placement ---
    // Find signer names and nearby signature/date patterns using exact text positions.
    // This does NOT rely on AI for coordinates — positions come from actual text extraction.
    if (textItems.length > 0) {
      const deterministicFields = this.placeFieldsByTextPositions(
        textItems, pageCount, signerCount, signerDescriptions,
      );
      if (deterministicFields.length > 0) {
        logger.info({
          count: deterministicFields.length,
          fields: deterministicFields.map(f => `${f.type}@p${f.page}(${f.x.toFixed(3)},${f.y.toFixed(3)}) signer=${f.signerIndex}`),
        }, 'Using deterministic text-position field placement');
        return deterministicFields;
      }
    }

    // --- Layer 4: AI visual analysis with text calibration ---
    // Only if deterministic placement couldn't find enough fields
    try {
      const aiFields = await this.aiDetectWithTextContext(
        pdfBuffer, textItems, pageCount, signerCount, signerDescriptions, documentText,
      );
      logger.info({ count: aiFields.length }, 'Layer 4 (AI): fields detected');
      if (aiFields.length > 0) return aiFields;
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'AI field detection failed completely');
    }

    // --- Fallback: place based on any text extraction data we have ---
    if (textItems.length > 0) {
      const lastResort = this.placeFieldsLastResort(textItems, pageCount, signerCount);
      if (lastResort.length > 0) {
        logger.warn({ count: lastResort.length }, 'Using last-resort text-based placement');
        return lastResort;
      }
    }

    logger.warn('All detection layers failed, using default placement');
    return this.getDefaultFields(pageCount, signerCount);
  }

  // =========================================================================
  // Layer 3: Deterministic text-based field placement
  // Finds signer names and signature-related text patterns, places fields
  // at their exact extracted positions. No AI needed.
  // =========================================================================
  private placeFieldsByTextPositions(
    textItems: TextItem[],
    pageCount: number,
    signerCount: number,
    signerDescriptions?: string[],
  ): DetectedField[] {
    const fields: DetectedField[] = [];

    // Extract signer names from descriptions
    const signerNames: string[] = [];
    if (signerDescriptions) {
      for (const desc of signerDescriptions) {
        // First part before ' — ' is usually the name
        const name = desc.split(' — ')[0]?.trim();
        if (name) signerNames.push(name);
      }
    }

    // Find signature blocks: look for patterns near each signer's name
    for (let signerIdx = 0; signerIdx < signerCount; signerIdx++) {
      const signerName = signerNames[signerIdx];
      if (!signerName) continue;

      // Find this signer's name in the text
      const nameItems = textItems.filter(item =>
        item.text.toLowerCase().includes(signerName.toLowerCase()) ||
        signerName.toLowerCase().split(' ').every(part =>
          item.text.toLowerCase().includes(part.toLowerCase()),
        ),
      );

      if (nameItems.length === 0) continue;

      // Use the LAST occurrence (signature blocks are usually at the end)
      const nameItem = nameItems[nameItems.length - 1];
      logger.info({
        signerIdx,
        signerName,
        foundAt: { page: nameItem.page, x: nameItem.x.toFixed(3), y: nameItem.y.toFixed(3) },
        text: nameItem.text,
      }, 'Found signer name in document');

      // Look for signature-related text near this name (within ~10% vertical distance)
      const nearbyItems = textItems.filter(item =>
        item.page === nameItem.page &&
        Math.abs(item.y - nameItem.y) < 0.12,
      );

      // Find "By:", "Signature:", or underline patterns near the name
      let signatureY = nameItem.y - 0.045; // Default: just above the name
      let signatureX = nameItem.x;
      let dateY: number | null = null;
      let dateX: number | null = null;
      let titleY: number | null = null;
      let titleX: number | null = null;

      for (const nearby of nearbyItems) {
        const text = nearby.text.toLowerCase();
        if (/\bby\s*:|signature|sign\s*here/i.test(nearby.text) || /_{3,}/.test(nearby.text)) {
          // This is a signature line — place field above it
          signatureY = nearby.y - 0.045;
          signatureX = nearby.x;
          // If the text has underscores, place the field at the underscores
          if (/_{3,}/.test(nearby.text)) {
            const underIdx = nearby.text.search(/_{3,}/);
            const ratio = underIdx / nearby.text.length;
            signatureX = nearby.x + nearby.width * ratio;
          }
        }
        if (/\bdate\s*:/i.test(nearby.text)) {
          dateY = nearby.y - 0.03;
          dateX = nearby.x + nearby.width + 0.01;
          if (/_{3,}/.test(nearby.text)) {
            const underIdx = nearby.text.search(/_{3,}/);
            const ratio = underIdx / nearby.text.length;
            dateX = nearby.x + nearby.width * ratio;
          }
        }
        if (/\btitle\s*:/i.test(nearby.text)) {
          titleY = nearby.y - 0.03;
          titleX = nearby.x + nearby.width + 0.01;
        }
      }

      // Add signature field
      fields.push({
        type: 'signature',
        page: nameItem.page,
        x: Math.max(0, Math.min(0.95, signatureX)),
        y: Math.max(0, Math.min(0.95, signatureY)),
        width: 0.25,
        height: 0.045,
        signerIndex: signerIdx,
        label: `${signerName} Signature`,
        source: 'textanchor',
      });

      // Add date field
      if (dateY !== null && dateX !== null) {
        fields.push({
          type: 'date',
          page: nameItem.page,
          x: Math.max(0, Math.min(0.95, dateX)),
          y: Math.max(0, Math.min(0.95, dateY)),
          width: 0.15,
          height: 0.03,
          signerIndex: signerIdx,
          label: `${signerName} Date`,
          source: 'textanchor',
        });
      }

      // Add title field
      if (titleY !== null && titleX !== null) {
        fields.push({
          type: 'title',
          page: nameItem.page,
          x: Math.max(0, Math.min(0.95, titleX)),
          y: Math.max(0, Math.min(0.95, titleY)),
          width: 0.20,
          height: 0.03,
          signerIndex: signerIdx,
          label: `${signerName} Title`,
          source: 'textanchor',
        });
      }
    }

    return fields;
  }

  /**
   * Last resort: find ANY signature-related text in the document and place fields there.
   * Better than hardcoded defaults because it uses actual document content positions.
   */
  private placeFieldsLastResort(
    textItems: TextItem[],
    pageCount: number,
    signerCount: number,
  ): DetectedField[] {
    const fields: DetectedField[] = [];
    const sigPatterns = [/\bby\s*:/i, /signature/i, /sign\s*here/i, /_{5,}/];

    // Find all signature-like patterns
    const sigLocations: TextItem[] = [];
    for (const item of textItems) {
      if (sigPatterns.some(p => p.test(item.text))) {
        sigLocations.push(item);
      }
    }

    if (sigLocations.length === 0) return [];

    // Sort by page then y position
    sigLocations.sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    // Assign to signers round-robin
    for (let i = 0; i < Math.min(sigLocations.length, signerCount * 2); i++) {
      const loc = sigLocations[i];
      const signerIdx = i % signerCount;

      fields.push({
        type: 'signature',
        page: loc.page,
        x: Math.max(0, Math.min(0.95, loc.x)),
        y: Math.max(0, Math.min(0.95, loc.y - 0.045)),
        width: 0.25,
        height: 0.045,
        signerIndex: signerIdx,
        label: `Signer ${signerIdx + 1} Signature`,
        source: 'textanchor',
      });
    }

    return fields;
  }
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

      // Also load with pdf-lib to get page dimensions for cross-reference
      const pdfLibDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const textContent = await page.getTextContent();

        // Check if pdfjs-dist and pdf-lib agree on page dimensions
        const pdfLibPage = pdfLibDoc.getPage(pageNum - 1);
        const pdfLibSize = pdfLibPage.getSize();

        // Use pdf-lib dimensions for normalization since that's what
        // applySignaturesToDocument uses for rendering. This ensures
        // consistent coordinates across detection and rendering.
        const normWidth = pdfLibSize.width;
        const normHeight = pdfLibSize.height;

        if (Math.abs(viewport.width - normWidth) > 1 || Math.abs(viewport.height - normHeight) > 1) {
          logger.warn({
            page: pageNum,
            pdfjs: { w: viewport.width, h: viewport.height },
            pdflib: { w: normWidth, h: normHeight },
          }, 'Page dimension mismatch between pdfjs-dist and pdf-lib — using pdf-lib dimensions');
        }

        for (const item of textContent.items) {
          if (!('str' in item) || !item.str.trim()) continue;

          const tx = item.transform;
          // transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
          const pdfX = tx[4];
          const pdfY = tx[5];
          const textWidth = item.width || 0;
          const textHeight = item.height || Math.abs(tx[3]);

          // Normalize using pdf-lib page dimensions (consistent with rendering)
          // Y is flipped: PDF uses bottom-left origin, we use top-left
          items.push({
            text: item.str,
            page: pageNum,
            x: pdfX / normWidth,
            y: 1 - (pdfY / normHeight),
            width: textWidth / normWidth,
            height: textHeight / normHeight,
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
    pageCount: number,
    signerCount: number,
    signerDescriptions?: string[],
    documentText?: string,
  ): Promise<DetectedField[]> {
    const hasSignerNames = signerDescriptions && signerDescriptions.length > 0;
    const signerList = hasSignerNames
      ? signerDescriptions!.map((d, i) => `  Signer ${i} → ${d}`).join('\n')
      : `  ${signerCount} signer(s) — names not specified`;

    // Build calibration anchors: known text items with exact positions
    // These let the AI cross-reference visual locations with ground-truth coordinates
    const calibrationAnchors = this.buildCalibrationAnchors(textItems);

    const prompt = `You are a precise document field detection system for e-signatures.

TASK: Find where each signer must sign/date/fill in the attached PDF document.

SIGNERS:
${signerList}

CALIBRATION ANCHORS — these are exact text positions extracted from the PDF.
Use them as reference points to calibrate your coordinate estimates:
${calibrationAnchors}

HOW TO USE CALIBRATION ANCHORS:
1. Find a text item in the CALIBRATION ANCHORS that you can also see in the PDF
2. Note its exact (x, y) coordinates from the anchor data
3. Use that as a reference to estimate nearby field positions
For example, if you see "Guy Gamzu" in the anchors at y=0.82 on page 3, and
the signature line is visually just above that name, the signature field
should be at approximately y=0.78 (slightly above the name).

WHAT TO LOOK FOR:
- Horizontal lines (drawn lines, underscores, dots) = signature/writing areas
- "Signature", "Sign here", "By:" labels = signature fields
- "Date:" labels with blank space = date fields
- "Name:", "Print Name:" with blank space = name fields
- "Title:", "Position:" with blank space = title fields
- Each signer's PRINTED NAME indicates their signature block

COORDINATE SYSTEM:
- (0,0) = TOP-LEFT corner of the page
- x: 0.0 = left edge, 1.0 = right edge
- y: 0.0 = top edge, 1.0 = bottom edge
- (x, y) = TOP-LEFT corner of the field rectangle
- Field extends DOWNWARD from y by height, RIGHTWARD from x by width

POSITIONING:
- Place signature fields ON the blank line where the person writes
- The field y should position it so the field COVERS the blank writing area
- For a blank line at position lineY, set y = lineY - height
  (field bottom at the line, field body extends upward = writing area)

FIELD DIMENSIONS (normalized):
- signature: width=0.25, height=0.045
- date: width=0.15, height=0.03
- name: width=0.22, height=0.03
- title: width=0.20, height=0.03

Return ONLY a valid JSON array. No markdown fences, no explanation text:
[{"type":"signature","page":1,"x":0.10,"y":0.78,"width":0.25,"height":0.045,"signerIndex":0,"label":"Guy Gamzu Signature"}]`;

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
      logger.info({ rawAIResponse: text.substring(0, 1000) }, 'AI field detection raw response');

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

      // Cross-validate AI coordinates against nearest calibration anchors
      if (textItems.length > 0) {
        for (const field of fields) {
          const nearestAnchor = this.findNearestTextItem(textItems, field.page, field.x, field.y + field.height);
          if (nearestAnchor) {
            logger.info({
              fieldType: field.type,
              fieldLabel: field.label,
              fieldPos: { x: field.x.toFixed(3), y: field.y.toFixed(3) },
              nearestText: nearestAnchor.text.substring(0, 40),
              nearestPos: { x: nearestAnchor.x.toFixed(3), y: nearestAnchor.y.toFixed(3) },
              distance: Math.sqrt(
                Math.pow(field.x - nearestAnchor.x, 2) +
                Math.pow((field.y + field.height) - nearestAnchor.y, 2),
              ).toFixed(3),
            }, 'Field cross-validation with nearest text');
          }
        }
      }

      return fields;
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'AI field detection failed');
      return [];
    }
  }

  private findNearestTextItem(items: TextItem[], page: number, x: number, y: number): TextItem | null {
    let best: TextItem | null = null;
    let bestDist = Infinity;
    for (const item of items) {
      if (item.page !== page) continue;
      const dist = Math.sqrt(Math.pow(item.x - x, 2) + Math.pow(item.y - y, 2));
      if (dist < bestDist) {
        bestDist = dist;
        best = item;
      }
    }
    return best;
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

  private buildCalibrationAnchors(textItems: TextItem[]): string {
    if (textItems.length === 0) return '(no calibration data available — rely on visual analysis only)';

    // Group by page
    const byPage = new Map<number, TextItem[]>();
    for (const item of textItems) {
      if (!byPage.has(item.page)) byPage.set(item.page, []);
      byPage.get(item.page)!.push(item);
    }

    const lines: string[] = [];
    for (const [page, items] of byPage) {
      lines.push(`\n  Page ${page}:`);
      // Sort by Y position (top to bottom)
      items.sort((a, b) => a.y - b.y);

      // Include ALL text items but prioritize signature-related ones
      // This gives the AI maximum calibration data
      const signatureRelated = [
        /signature/i, /sign/i, /date/i, /name/i, /title/i, /initial/i,
        /print/i, /_{3,}/, /by:/i, /authorized/i, /witness/i,
      ];

      // First: all signature-related items (always included)
      for (const item of items) {
        if (signatureRelated.some(p => p.test(item.text))) {
          lines.push(`    ★ x=${item.x.toFixed(3)} y=${item.y.toFixed(3)} "${item.text.substring(0, 80)}"`);
        }
      }

      // Then: other substantial text items for context (limited)
      let contextCount = 0;
      for (const item of items) {
        if (signatureRelated.some(p => p.test(item.text))) continue; // already added
        if (item.text.trim().length < 3) continue;
        if (contextCount >= 15) break;
        lines.push(`    · x=${item.x.toFixed(3)} y=${item.y.toFixed(3)} "${item.text.substring(0, 60)}"`);
        contextCount++;
      }
    }

    return lines.join('\n');
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
