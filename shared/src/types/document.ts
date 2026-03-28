export enum DocumentStatus {
  DRAFT = 'draft',
  PENDING_CONFIRMATION = 'pending_confirmation',
  SENT = 'sent',
  PARTIALLY_SIGNED = 'partially_signed',
  COMPLETED = 'completed',
  DECLINED = 'declined',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export enum FieldType {
  SIGNATURE = 'signature',
  INITIAL = 'initial',
  DATE = 'date',
  TEXT = 'text',
  CHECKBOX = 'checkbox',
}

export interface DocumentField {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  signerId: string;
  required: boolean;
  value?: string;
  completedAt?: string;
}

export interface DocumentMetadata {
  fileName: string;
  fileSize: number;
  pageCount: number;
  mimeType: string;
  hash: string; // SHA-256
}

export interface SigningOrder {
  step: number;
  signerId: string;
}

export interface DocumentRequest {
  id: string;
  senderId: string;
  status: DocumentStatus;
  metadata: DocumentMetadata;
  fields: DocumentField[];
  signingOrder: SigningOrder[];
  isSequential: boolean;
  creditsRequired: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  s3Key: string;
  signedS3Key?: string;
  certificateS3Key?: string;
}
