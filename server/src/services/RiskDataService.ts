import { logger } from '../config/logger.js';

export interface RawRiskEvent {
  source: string;
  sourceEventId: string;
  eventType: string;
  title: string;
  description: string;
  location: string;
  latitude?: number;
  longitude?: number;
  eventTime: Date;
  rawData: Record<string, unknown>;
}

// Keywords that indicate missile/rocket threats relevant to Israel
const THREAT_KEYWORDS = [
  'missile', 'rocket', 'ballistic', 'projectile', 'interception',
  'iron dome', 'launch', 'barrage', 'salvo', 'warhead', 'drone',
  'uav', 'cruise missile', 'hypersonic',
];

const ISRAEL_KEYWORDS = [
  'israel', 'tel aviv', 'jerusalem', 'haifa', 'beer sheva',
  'beersheba', 'ashkelon', 'ashdod', 'negev', 'golan',
  'galilee', 'eilat', 'netanya', 'herzliya', 'rishon',
];

export class RiskDataService {
  /**
   * Fetch from all configured OSINT sources in parallel.
   * Each source is independently try/caught so one failure doesn't block others.
   */
  async fetchAllSources(): Promise<RawRiskEvent[]> {
    const results = await Promise.allSettled([
      this.fetchIranWarLive(),
      this.fetchACLED(),
    ]);

    const events: RawRiskEvent[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        events.push(...result.value);
      } else {
        logger.warn({ error: result.reason?.message || String(result.reason) }, 'OSINT source fetch failed');
      }
    }

    logger.info({ totalEvents: events.length }, 'Fetched events from all OSINT sources');
    return events;
  }

  /**
   * Fetch from iranwarlive.com/feed.json
   * Filters for missile/rocket events targeting Israel.
   */
  private async fetchIranWarLive(): Promise<RawRiskEvent[]> {
    const response = await fetch('https://iranwarlive.com/feed.json', {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'RiskMonitorAgent/1.0' },
    });

    if (!response.ok) {
      throw new Error(`iranwarlive returned ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>[];
    if (!Array.isArray(data)) {
      // The feed might be an object with a nested array
      const items = (data as any).events || (data as any).items || (data as any).data || [];
      if (!Array.isArray(items)) {
        logger.warn('iranwarlive feed.json returned unexpected format');
        return [];
      }
      return this.parseIranWarLiveItems(items);
    }

    return this.parseIranWarLiveItems(data);
  }

  private parseIranWarLiveItems(items: any[]): RawRiskEvent[] {
    const events: RawRiskEvent[] = [];

    for (const item of items) {
      const text = [
        item.title || '',
        item.description || item.summary || item.content || '',
        item.location || item.place || '',
        item.type || item.category || '',
      ].join(' ').toLowerCase();

      // Must match both a threat keyword and an Israel keyword
      const isThreat = THREAT_KEYWORDS.some((kw) => text.includes(kw));
      const isIsrael = ISRAEL_KEYWORDS.some((kw) => text.includes(kw));

      if (!isThreat || !isIsrael) continue;

      events.push({
        source: 'iranwarlive',
        sourceEventId: String(item.id || item.event_id || this.hashEvent(item)),
        eventType: this.classifyEventType(text),
        title: item.title || item.headline || 'Untitled event',
        description: item.description || item.summary || item.content || '',
        location: item.location || item.place || item.region || '',
        latitude: parseFloat(item.lat || item.latitude) || undefined,
        longitude: parseFloat(item.lng || item.lon || item.longitude) || undefined,
        eventTime: new Date(item.timestamp || item.date || item.time || Date.now()),
        rawData: item,
      });
    }

    logger.info({ source: 'iranwarlive', matched: events.length, total: items.length }, 'Filtered Iran War Live events');
    return events;
  }

  /**
   * Fetch from ACLED API (Armed Conflict Location & Event Data).
   * Filters for Israel, explosions/remote violence event types.
   */
  private async fetchACLED(): Promise<RawRiskEvent[]> {
    const apiKey = process.env.ACLED_API_KEY;
    const apiEmail = process.env.ACLED_API_EMAIL;

    if (!apiKey || !apiEmail) {
      logger.debug('ACLED API credentials not configured, skipping');
      return [];
    }

    // Fetch events from the last 24 hours for Israel
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const params = new URLSearchParams({
      key: apiKey,
      email: apiEmail,
      country: 'Israel',
      event_date: since,
      event_date_where: '>=',
      event_type: 'Explosions/Remote violence',
      limit: '100',
    });

    const url = `https://api.acleddata.com/acled/read?${params.toString()}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'RiskMonitorAgent/1.0' },
    });

    if (!response.ok) {
      throw new Error(`ACLED API returned ${response.status}`);
    }

    const body = await response.json() as any;
    const items = body.data || [];

    const events: RawRiskEvent[] = [];
    for (const item of items) {
      const text = [item.event_type || '', item.sub_event_type || '', item.notes || ''].join(' ').toLowerCase();
      const isThreat = THREAT_KEYWORDS.some((kw) => text.includes(kw)) || text.includes('shelling') || text.includes('air/drone strike');

      if (!isThreat) continue;

      events.push({
        source: 'acled',
        sourceEventId: String(item.data_id),
        eventType: this.classifyEventType(text),
        title: `${item.sub_event_type || item.event_type} - ${item.admin1 || item.country}`,
        description: item.notes || '',
        location: [item.location, item.admin1, item.admin2].filter(Boolean).join(', '),
        latitude: parseFloat(item.latitude) || undefined,
        longitude: parseFloat(item.longitude) || undefined,
        eventTime: new Date(item.event_date || Date.now()),
        rawData: item,
      });
    }

    logger.info({ source: 'acled', matched: events.length, total: items.length }, 'Filtered ACLED events');
    return events;
  }

  private classifyEventType(text: string): string {
    if (text.includes('ballistic') || text.includes('missile launch')) return 'missile_launch';
    if (text.includes('interception') || text.includes('iron dome') || text.includes('intercept')) return 'interception';
    if (text.includes('rocket') || text.includes('barrage') || text.includes('salvo')) return 'rocket_attack';
    if (text.includes('drone') || text.includes('uav')) return 'drone_attack';
    if (text.includes('cruise missile')) return 'cruise_missile';
    return 'unknown_threat';
  }

  /**
   * Generate a deterministic hash for events without an ID.
   */
  private hashEvent(item: any): string {
    const key = JSON.stringify({
      t: item.title || item.headline || '',
      d: item.timestamp || item.date || '',
      l: item.location || item.place || '',
    });
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return `hash_${Math.abs(hash).toString(36)}`;
  }
}
