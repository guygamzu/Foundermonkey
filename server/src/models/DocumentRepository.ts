import { Knex } from 'knex';

export interface DocumentRequestRow {
  id: string;
  sender_id: string;
  status: string;
  file_name: string;
  file_size: number;
  page_count: number;
  mime_type: string;
  document_hash: string;
  s3_key: string;
  signed_s3_key: string | null;
  certificate_s3_key: string | null;
  is_sequential: boolean;
  credits_required: number;
  original_email_message_id: string | null;
  subject: string | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SignerRow {
  id: string;
  document_request_id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  status: string;
  delivery_channel: string;
  signing_order: number;
  signing_token: string;
  custom_message: string | null;
  notified_at: Date | null;
  viewed_at: Date | null;
  signed_at: Date | null;
  declined_at: Date | null;
  decline_reason: string | null;
  created_at: Date;
}

export interface DocumentFieldRow {
  id: string;
  document_request_id: string;
  signer_id: string;
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  value: string | null;
  completed_at: Date | null;
}

export class DocumentRepository {
  constructor(private db: Knex) {}

  async create(data: Partial<DocumentRequestRow>): Promise<DocumentRequestRow> {
    const [doc] = await this.db('document_requests').insert(data).returning('*');
    return doc;
  }

  async findById(id: string): Promise<DocumentRequestRow | undefined> {
    return this.db('document_requests').where({ id }).first();
  }

  async findBySenderId(senderId: string): Promise<DocumentRequestRow[]> {
    return this.db('document_requests').where({ sender_id: senderId }).orderBy('created_at', 'desc');
  }

  async updateStatus(id: string, status: string): Promise<DocumentRequestRow> {
    const [doc] = await this.db('document_requests')
      .where({ id })
      .update({ status, updated_at: new Date() })
      .returning('*');
    return doc;
  }

  async markCompleted(id: string, signedS3Key: string, certificateS3Key: string): Promise<DocumentRequestRow> {
    const [doc] = await this.db('document_requests')
      .where({ id })
      .update({
        status: 'completed',
        signed_s3_key: signedS3Key,
        certificate_s3_key: certificateS3Key,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');
    return doc;
  }

  // Signer methods
  async createSigner(data: Partial<SignerRow>): Promise<SignerRow> {
    const [signer] = await this.db('signers').insert(data).returning('*');
    return signer;
  }

  async findSignerByToken(token: string): Promise<SignerRow | undefined> {
    return this.db('signers').where({ signing_token: token }).first();
  }

  async findSignersByDocumentId(documentRequestId: string): Promise<SignerRow[]> {
    return this.db('signers')
      .where({ document_request_id: documentRequestId })
      .orderBy('signing_order', 'asc');
  }

  async updateSignerStatus(id: string, status: string, extra?: Partial<SignerRow>): Promise<SignerRow> {
    const [signer] = await this.db('signers')
      .where({ id })
      .update({ status, ...extra })
      .returning('*');
    return signer;
  }

  async getNextPendingSigner(documentRequestId: string): Promise<SignerRow | undefined> {
    return this.db('signers')
      .where({ document_request_id: documentRequestId, status: 'pending' })
      .orderBy('signing_order', 'asc')
      .first();
  }

  // Field methods
  async createFields(fields: Partial<DocumentFieldRow>[]): Promise<DocumentFieldRow[]> {
    return this.db('document_fields').insert(fields).returning('*');
  }

  async findFieldsByDocumentId(documentRequestId: string): Promise<DocumentFieldRow[]> {
    return this.db('document_fields').where({ document_request_id: documentRequestId });
  }

  async findFieldsBySignerId(signerId: string): Promise<DocumentFieldRow[]> {
    return this.db('document_fields').where({ signer_id: signerId });
  }

  async updateFieldValue(fieldId: string, value: string): Promise<DocumentFieldRow> {
    const [field] = await this.db('document_fields')
      .where({ id: fieldId })
      .update({ value, completed_at: new Date() })
      .returning('*');
    return field;
  }

  async areAllFieldsCompleted(documentRequestId: string, signerId: string): Promise<boolean> {
    const incomplete = await this.db('document_fields')
      .where({ document_request_id: documentRequestId, signer_id: signerId, required: true })
      .whereNull('completed_at')
      .count('id as count')
      .first();
    return Number(incomplete?.count) === 0;
  }
}
