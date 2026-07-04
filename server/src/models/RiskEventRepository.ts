import { Knex } from 'knex';

export interface RiskEventRow {
  id: string;
  source: string;
  source_event_id: string;
  event_type: string;
  title: string | null;
  description: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  event_time: Date | null;
  raw_data: Record<string, unknown>;
  fetched_at: Date;
}

export interface RiskAlertRow {
  id: string;
  risk_event_id: string | null;
  severity: string;
  title: string;
  summary: string;
  raw_analysis: Record<string, unknown> | null;
  recipients: string[];
  sent_at: Date | null;
  created_at: Date;
}

export class RiskEventRepository {
  constructor(private db: Knex) {}

  /**
   * Insert a new risk event. Returns the row if inserted, null if it was a duplicate.
   */
  async insertEvent(event: Omit<RiskEventRow, 'id' | 'fetched_at'>): Promise<RiskEventRow | null> {
    const result = await this.db.raw(
      `INSERT INTO risk_events (source, source_event_id, event_type, title, description, location, latitude, longitude, event_time, raw_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
       ON CONFLICT (source, source_event_id) DO NOTHING
       RETURNING *`,
      [
        event.source,
        event.source_event_id,
        event.event_type,
        event.title,
        event.description,
        event.location,
        event.latitude,
        event.longitude,
        event.event_time,
        JSON.stringify(event.raw_data),
      ],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Find events from the last N minutes for context.
   */
  async findRecentEvents(sinceMinutes: number): Promise<RiskEventRow[]> {
    return this.db('risk_events')
      .where('fetched_at', '>=', this.db.raw(`now() - interval '${sinceMinutes} minutes'`))
      .orderBy('event_time', 'desc');
  }

  /**
   * Insert an alert record.
   */
  async insertAlert(alert: Omit<RiskAlertRow, 'id' | 'created_at'>): Promise<RiskAlertRow> {
    const [row] = await this.db('risk_alerts')
      .insert({
        risk_event_id: alert.risk_event_id,
        severity: alert.severity,
        title: alert.title,
        summary: alert.summary,
        raw_analysis: JSON.stringify(alert.raw_analysis),
        recipients: JSON.stringify(alert.recipients),
        sent_at: alert.sent_at,
      })
      .returning('*');
    return row;
  }

  /**
   * Find recent alerts to avoid re-alerting on the same incident.
   */
  async findRecentAlerts(hours: number): Promise<RiskAlertRow[]> {
    return this.db('risk_alerts')
      .where('created_at', '>=', this.db.raw(`now() - interval '${hours} hours'`))
      .orderBy('created_at', 'desc');
  }
}
