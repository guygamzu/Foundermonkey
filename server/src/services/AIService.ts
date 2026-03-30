import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../config/logger.js';

interface DetectedField {
  type: 'signature' | 'initial' | 'date' | 'text';
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
  ): Promise<DetectedField[]> {
    const prompt = `You are an AI assistant for an e-signature platform. Analyze this document and detect EXACTLY where signature fields, initial fields, date fields, and text fields should be placed.

Document has ${pageCount} pages and ${signerCount} signer(s).

${pdfBuffer ? 'I have attached the actual PDF document. LOOK at each page carefully to find signature lines, date blanks, and other fields that need filling.' : `Document text:\n${documentText.substring(0, 15000)}`}

Identify all fields that need to be filled/signed. Return JSON array:
[
  {
    "type": "signature|initial|date|text",
    "page": number (1-based),
    "x": number (0-1, relative position from left edge of page),
    "y": number (0-1, relative position from top edge of page),
    "width": number (0-1, relative width),
    "height": number (0-1, relative height),
    "signerIndex": number (0-based),
    "label": "optional description"
  }
]

CRITICAL positioning rules:
- x=0 is the LEFT edge, x=1 is the RIGHT edge
- y=0 is the TOP edge, y=1 is the BOTTOM edge
- Position fields PRECISELY over the blank lines, boxes, or spaces where the user should write
- For signature lines (____), place the field directly on top of the line
- Signature fields should typically be about width=0.3, height=0.05
- Date fields should typically be about width=0.15, height=0.04
- Text fields should match the blank space size
- Look for: signature lines (____), "Sign here", "Signature:", "Date:", blank lines after labels, checkbox areas
- If multiple signers, assign each field to the correct signer based on context (e.g., "Buyer" vs "Seller")
- If no explicit fields found, add a signature and date field at the bottom of the last page`;

    const content: Anthropic.MessageParam['content'] = [];

    // If we have the actual PDF, send it as a document for visual analysis
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
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn('AI could not detect fields, adding default signature field');
      return [{
        type: 'signature',
        page: pageCount,
        x: 0.1,
        y: 0.8,
        width: 0.3,
        height: 0.05,
        signerIndex: 0,
        label: 'Signature',
      }, {
        type: 'date',
        page: pageCount,
        x: 0.6,
        y: 0.8,
        width: 0.15,
        height: 0.04,
        signerIndex: 0,
        label: 'Date',
      }];
    }

    const fields = JSON.parse(jsonMatch[0]) as DetectedField[];
    logger.info({ fieldCount: fields.length, fields: fields.map(f => `${f.type}@p${f.page}(${f.x.toFixed(2)},${f.y.toFixed(2)})`) }, 'AI field detection results');
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
