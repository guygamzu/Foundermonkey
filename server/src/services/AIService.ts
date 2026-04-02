import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../config/logger.js';

interface DetectedField {
  type: 'signature' | 'initial' | 'date' | 'text' | 'name' | 'title';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  signerIndex: number; // 0-based index into signer list
  label?: string;
}

interface ParsedInstructions {
  recipients: Array<{
    email?: string;
    phone?: string;
    name?: string;
    channel: 'email' | 'sms' | 'whatsapp';
    order: number;
    customMessage?: string;
  }>;
  isSequential: boolean;
}

interface QAResponse {
  answer: string;
  citations: Array<{ section: string; text: string }>;
}

export class AIService {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async parseEmailInstructions(emailBody: string, subject: string): Promise<ParsedInstructions> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are an AI assistant for an e-signature platform called Lapen. Parse the following email to extract signature request instructions.

Subject: ${subject}
Body: ${emailBody}

Extract:
1. All recipients (email addresses, phone numbers, names)
2. Whether signing should be sequential (one after another) or parallel
3. Any custom messages for specific recipients
4. The delivery channel for each recipient (email, sms, or whatsapp)

Respond in JSON format:
{
  "recipients": [
    {
      "email": "string or null",
      "phone": "string or null",
      "name": "string or null",
      "channel": "email|sms|whatsapp",
      "order": number,
      "customMessage": "string or null"
    }
  ],
  "isSequential": boolean
}

Rules:
- If the user says "first X, then Y" or "and then", mark as sequential
- Default to parallel signing unless sequential is explicitly indicated
- Detect phone numbers and determine if WhatsApp or SMS based on context (e.g., "via WhatsApp", "text them")
- Default channel is email
- Order starts at 1`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Failed to parse AI response for email instructions');

    return JSON.parse(jsonMatch[0]) as ParsedInstructions;
  }

  async detectDocumentFields(
    documentText: string,
    pageCount: number,
    signerCount: number,
    pdfBuffer?: Buffer,
    signerDescriptions?: string[],
  ): Promise<DetectedField[]> {
    const hasSignerNames = signerDescriptions && signerDescriptions.length > 0;
    const signerList = hasSignerNames
      ? signerDescriptions!.map((d, i) => `  Signer ${i} → ${d}`).join('\n')
      : `  ${signerCount} signer(s) — names not specified`;

    // If we have the PDF text, add it as context to help the AI correlate text positions with visual locations
    const textContext = documentText && documentText.trim().length > 20
      ? `\nEXTRACTED TEXT (for reference — use to identify where signer names and signature blocks appear):\n${documentText.substring(0, 12000)}\n`
      : '';

    const prompt = `You are a document analysis expert for an e-signature platform.

TASK: Find the exact signature blocks in this document that belong to the specified signers and return their precise coordinates.

SIGNERS WHO NEED TO SIGN:
${signerList}

${pdfBuffer ? 'The actual PDF document is attached as a file. LOOK at every page carefully to find signature lines.' : ''}
${textContext}

CRITICAL INSTRUCTIONS:
1. Scan the ENTIRE document visually (all pages) for signature blocks. These typically have:
   - A horizontal line (____) or blank space for the signature
   - The signer's PRINTED NAME below, above, or near the line
   - Sometimes "Date:", "Title:", "Name:" labels nearby
   - Signature blocks are usually near the END of the document (last 1-2 pages)

2. MATCH each signer to their SPECIFIC signature block:
   - Find where each signer's name is PRINTED in the document
   - The signature LINE associated with that printed name belongs to that signer
   - Only create fields for the SPECIFIED signers, not for every signature line

3. For each matched signer, create these fields:
   - "signature": positioned ON the blank signature line (where they draw/write their signature)
   - "date": positioned ON the blank date space near their signature block (if one exists)
   - "name": only if there's a separate blank name field (NOT the pre-printed name)
   - "title": only if there's a separate blank title field

COORDINATE SYSTEM — READ CAREFULLY:
- Origin (0,0) = TOP-LEFT corner of the page
- x: distance from LEFT edge as fraction (0.0=left, 0.5=center, 1.0=right)
- y: distance from TOP edge as fraction (0.0=top, 0.5=middle, 1.0=bottom)

CALIBRATION GUIDE:
- A typical letter/A4 page has ~50 lines of text
- Page header area: y ≈ 0.02–0.08
- First quarter: y ≈ 0.08–0.25
- Middle of page: y ≈ 0.40–0.60
- Three-quarters down: y ≈ 0.70–0.80
- Bottom of page (common for signatures): y ≈ 0.80–0.95
- Left margin text typically starts at x ≈ 0.08–0.12
- Right-aligned signature blocks often start at x ≈ 0.50–0.60
- Signature lines centered on page: x ≈ 0.30, width ≈ 0.40

IMPORTANT: Position each field so it COVERS the blank line/space. The (x, y) is the TOP-LEFT corner of the field rectangle.

FIELD SIZES (use these defaults):
- Signature: width=0.25, height=0.045
- Date: width=0.15, height=0.03
- Name: width=0.22, height=0.03
- Title: width=0.20, height=0.03

Return ONLY a JSON array (no markdown, no explanation, no code fences):
[{"type":"signature","page":1,"x":0.55,"y":0.82,"width":0.25,"height":0.045,"signerIndex":0,"label":"Guy Gamzu Signature"}]`;

    const content: Anthropic.MessageParam['content'] = [];

    if (pdfBuffer) {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: pdfBuffer.toString('base64'),
        },
      } as any);
    }
    content.push({ type: 'text', text: prompt });

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    logger.info({ rawAIResponse: text.substring(0, 500) }, 'AI field detection raw response');
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn('AI could not detect fields, adding default signature + date');
      return this.getDefaultFields(pageCount, signerCount);
    }

    try {
      let fields = JSON.parse(jsonMatch[0]) as DetectedField[];

      // Validate and clamp coordinates
      fields = fields.filter(f => {
        if (!f.type || !f.page || f.page < 1 || f.page > pageCount) return false;
        if (typeof f.x !== 'number' || typeof f.y !== 'number') return false;
        return true;
      }).map(f => ({
        ...f,
        // Normalize type
        type: (['signature', 'initial', 'date', 'text', 'name', 'title'].includes(f.type) ? f.type : 'text') as DetectedField['type'],
        // Clamp coordinates to valid range
        x: Math.max(0, Math.min(0.95, f.x)),
        y: Math.max(0, Math.min(0.95, f.y)),
        width: Math.max(0.05, Math.min(0.5, f.width || 0.25)),
        height: Math.max(0.02, Math.min(0.1, f.height || 0.04)),
        signerIndex: Math.max(0, Math.min(signerCount - 1, f.signerIndex || 0)),
      }));

      if (fields.length === 0) {
        logger.warn('AI returned empty field array after validation, using defaults');
        return this.getDefaultFields(pageCount, signerCount);
      }

      logger.info({
        fieldCount: fields.length,
        fields: fields.map(f => `${f.type}[${f.label || ''}]@p${f.page}(${f.x.toFixed(2)},${f.y.toFixed(2)}) signer=${f.signerIndex}`),
      }, 'AI field detection results');
      return fields;
    } catch (parseErr) {
      logger.error({ error: parseErr instanceof Error ? parseErr.message : String(parseErr) }, 'Failed to parse AI field detection response');
      return this.getDefaultFields(pageCount, signerCount);
    }
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
      });
    }
    return fields;
  }

  async answerDocumentQuestion(
    documentText: string,
    question: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<QAResponse> {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `You are a helpful AI assistant on an e-signature platform. A recipient is about to sign a document and has questions about it. Answer their questions based solely on the document content. Always cite specific sections when possible.

Document content:
${documentText.substring(0, 20000)}

Now answer the following question. Respond in JSON format:
{
  "answer": "your answer here",
  "citations": [{"section": "Section X", "text": "relevant quote"}]
}`,
      },
      { role: 'assistant', content: 'I understand. I will answer questions about this document accurately and cite specific sections.' },
      ...conversationHistory.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      { role: 'user', content: question },
    ];

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages,
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { answer: text, citations: [] };
    }
    return JSON.parse(jsonMatch[0]) as QAResponse;
  }

  /**
   * Summarize a document and generate a suggested cover email text for the sender.
   */
  async summarizeDocumentForSender(documentText: string, fileName: string): Promise<{ summary: string; suggestedCoverText: string }> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are an AI assistant for Lapen, an e-signature service. Read this document and provide:
1. A very concise summary (1-2 sentences max) of what this document is about, its purpose, and the key parties
2. A suggested cover email text to include in the email sent to signers. This text should:
   - Briefly explain what the document is about and why the recipient is receiving it
   - Be professional but warm
   - Be 2-3 sentences max
   - NOT include "Hi" or greetings (those are added automatically)
   - NOT include signature/sign-off (that's added automatically)

Document name: ${fileName}
Document content:
${documentText.substring(0, 15000)}

Respond in JSON format:
{
  "summary": "Brief summary of the document...",
  "suggestedCoverText": "This is a [document type] regarding [purpose]. It outlines [key terms]. Please review carefully before signing."
}`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        summary: 'Document uploaded successfully.',
        suggestedCoverText: `Hi,\n\nPlease review and sign the attached document "${fileName}".\n\nThank you`,
      };
    }
    return JSON.parse(jsonMatch[0]);
  }
}
