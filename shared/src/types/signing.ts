export enum SignerStatus {
  PENDING = 'pending',
  NOTIFIED = 'notified',
  VIEWED = 'viewed',
  SIGNED = 'signed',
  DECLINED = 'declined',
}

export enum DeliveryChannel {
  EMAIL = 'email',
  SMS = 'sms',
  WHATSAPP = 'whatsapp',
}

export interface Signer {
  id: string;
  documentRequestId: string;
  email?: string;
  phone?: string;
  name?: string;
  status: SignerStatus;
  deliveryChannel: DeliveryChannel;
  signingOrder: number;
  signingToken: string; // cryptographically secure URL token
  customMessage?: string;
  viewedAt?: string;
  signedAt?: string;
  declinedAt?: string;
  declineReason?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  documentRequestId: string;
  signerId?: string;
  action: AuditAction;
  ipAddress: string;
  userAgent: string;
  geolocation?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export enum AuditAction {
  DOCUMENT_CREATED = 'document_created',
  DOCUMENT_SENT = 'document_sent',
  DOCUMENT_VIEWED = 'document_viewed',
  FIELD_COMPLETED = 'field_completed',
  SIGNATURE_APPLIED = 'signature_applied',
  DOCUMENT_SIGNED = 'document_signed',
  DOCUMENT_DECLINED = 'document_declined',
  DOCUMENT_COMPLETED = 'document_completed',
  CONSENT_GIVEN = 'consent_given',
  LINK_EXPIRED = 'link_expired',
  REMINDER_SENT = 'reminder_sent',
}

export interface CertificateOfCompletion {
  documentId: string;
  documentHash: string;
  documentName: string;
  signers: Array<{
    name?: string;
    email?: string;
    phone?: string;
    signedAt: string;
    ipAddress: string;
    userAgent: string;
    consentTimestamp: string;
  }>;
  auditTrail: AuditEvent[];
  completedAt: string;
  archiveUrl: string;
}
