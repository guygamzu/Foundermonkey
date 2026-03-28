import { Knex } from 'knex';

export interface AuditEventRow {
  id: string;
  document_request_id: string;
  signer_id: string | null;
  action: string;
  ip_address: string;
  user_agent: string;
  geolocation: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export class AuditRepository {
  constructor(private db: Knex) {}

  async log(event: Omit<AuditEventRow, 'id' | 'created_at'>): Promise<AuditEventRow> {
    const [row] = await this.db('audit_events').insert(event).returning('*');
    return row;
  }

  async findByDocumentId(documentRequestId: string): Promise<AuditEventRow[]> {
    return this.db('audit_events')
      .where({ document_request_id: documentRequestId })
      .orderBy('created_at', 'asc');
  }

  async findBySignerId(signerId: string): Promise<AuditEventRow[]> {
    return this.db('audit_events')
      .where({ signer_id: signerId })
      .orderBy('created_at', 'asc');
  }
}
