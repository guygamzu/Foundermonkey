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
  ): Promise<DetectedField[]> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are an AI assistant for an e-signature platform. Analyze this document text and detect where signature fields, initial fields, date fields, and text fields should be placed.

Document has ${pageCount} pages and ${signerCount} signer(s).

Document text:
${documentText.substring(0, 15000)}

Identify all fields that need to be filled/signed. Return JSON array:
[
  {
    "type": "signature|initial|date|text",
    "page": number (1-based),
    "x": number (0-1, relative position from left),
    "y": number (0-1, relative position from top),
    "width": number (0-1, relative width),
    "height": number (0-1, relative height),
    "signerIndex": number (0-based),
    "label": "optional description"
  }
]

Rules:
- Look for signature lines (____), "Sign here", "Signature" labels
- Look for date fields near signatures
- Look for initial boxes/lines
- Look for fill-in-the-blank text fields
- Place fields at appropriate positions on the correct pages
- If no explicit fields found, add a signature field at the bottom of the last page
- Assign fields to signers based on document context`,
      }],
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
      }];
    }

    return JSON.parse(jsonMatch[0]) as DetectedField[];
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
