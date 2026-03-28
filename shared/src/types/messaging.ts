export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: EmailAttachment[];
  inReplyTo?: string;
  messageId?: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface ParsedEmailRequest {
  senderEmail: string;
  senderName?: string;
  recipients: ParsedRecipient[];
  isSequential: boolean;
  customMessages: Map<string, string>;
  subject: string;
  originalMessageId: string;
}

export interface ParsedRecipient {
  email?: string;
  phone?: string;
  name?: string;
  deliveryChannel: 'email' | 'sms' | 'whatsapp';
  signingOrder: number;
  customMessage?: string;
}

export interface SMSMessage {
  to: string;
  body: string;
}

export interface WhatsAppMessage {
  to: string;
  body: string;
  templateName?: string;
  templateParams?: string[];
}
