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

    const prompt = `You are a document analysis expert for an e-signature platform.

TASK: Find the exact signature blocks in this document that belong to the specified signers and return their precise coordinates.

SIGNERS WHO NEED TO SIGN:
${signerList}

${pdfBuffer ? 'The actual PDF document is attached. LOOK at every page carefully.' : `Document text:\n${documentText.substring(0, 15000)}`}

INSTRUCTIONS:
1. Look through the document for signature blocks — these typically have:
   - A horizontal line (____) for the signature
   - A name printed below or near the line
   - Sometimes "Date:", "Title:", "Name:" fields nearby

2. MATCH each signer to their specific signature block in the document:
   - Match by name: if Signer 0 is "Guy Gamzu", find the signature line near/above "Guy Gamzu" in the document
   - If a signer's name appears in the document near a signature line, that is THEIR signature block
   - Only create fields for the SPECIFIED signers, not for every signature line in the document

3. For each matched signer, create fields for:
   - The signature line itself (type: "signature")
   - A date field if one exists nearby (type: "date")
   - A name/title field if one exists nearby (type: "name" or "title")

COORDINATE SYSTEM:
- Origin (0,0) = TOP-LEFT corner of the page
- x: 0.0 = left edge, 1.0 = right edge
- y: 0.0 = top edge, 1.0 = bottom edge
- Position the field DIRECTLY ON TOP of the blank line/space where the signer writes
- The field should COVER the signature line, not be next to it

FIELD SIZES:
- Signature: width ≈ 0.22, height ≈ 0.04
- Date: width ≈ 0.15, height ≈ 0.03
- Name: width ≈ 0.22, height ≈ 0.03
- Title: width ≈ 0.20, height ≈ 0.03

Return ONLY a JSON array (no markdown fences, no explanation):
[{"type":"signature","page":1,"x":0.55,"y":0.42,"width":0.22,"height":0.04,"signerIndex":0,"label":"Guy Gamzu Signature"}]`;

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
}
