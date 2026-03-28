import { logger } from '../config/logger.js';

export class MessagingService {
  private twilioClient: any;

  constructor() {
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      // Dynamic import to avoid requiring Twilio in dev if not configured
      import('twilio').then(({ default: Twilio }) => {
        this.twilioClient = Twilio(
          process.env.TWILIO_ACCOUNT_SID!,
          process.env.TWILIO_AUTH_TOKEN!,
        );
      });
    }
  }

  async sendSMS(to: string, body: string): Promise<string> {
    if (!this.twilioClient) {
      logger.warn('Twilio not configured, SMS not sent');
      return 'sms-not-configured';
    }

    const message = await this.twilioClient.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });

    logger.info({ sid: message.sid, to }, 'SMS sent');
    return message.sid;
  }

  async sendWhatsApp(to: string, body: string): Promise<string> {
    if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_API_TOKEN) {
      logger.warn('WhatsApp not configured, message not sent');
      return 'whatsapp-not-configured';
    }

    const response = await fetch(process.env.WHATSAPP_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/[^0-9]/g, ''),
        type: 'text',
        text: { body },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ to, error }, 'WhatsApp message failed');
      throw new Error(`WhatsApp send failed: ${error}`);
    }

    const result = await response.json() as { messages: Array<{ id: string }> };
    logger.info({ to, messageId: result.messages?.[0]?.id }, 'WhatsApp message sent');
    return result.messages?.[0]?.id || 'sent';
  }

  async sendSigningNotification(
    channel: 'sms' | 'whatsapp',
    to: string,
    senderName: string,
    fileName: string,
    signingUrl: string,
  ): Promise<string> {
    const message = `Hi, ${senderName} has requested your signature on ${fileName}. Review and sign here: ${signingUrl}`;

    if (channel === 'sms') {
      return this.sendSMS(to, message);
    }
    return this.sendWhatsApp(to, message);
  }
}
