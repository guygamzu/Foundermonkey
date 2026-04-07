import { getQueue, QUEUE_NAMES } from '../config/queue.js';
import { getDatabase } from '../config/database.js';
import { RiskEventRepository } from '../models/RiskEventRepository.js';
import { RiskDataService } from '../services/RiskDataService.js';
import { RiskAnalysisService, ThreatAnalysis } from '../services/RiskAnalysisService.js';
import { EmailService } from '../services/EmailService.js';
import { logger } from '../config/logger.js';

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#DC2626',
  high: '#EA580C',
  medium: '#D97706',
  low: '#2563EB',
  info: '#6B7280',
};

function renderAlertHtml(analysis: ThreatAnalysis, eventCount: number): string {
  const color = SEVERITY_COLORS[analysis.severity] || '#6B7280';
  const summaryHtml = analysis.summary
    .split('\n')
    .filter((p) => p.trim())
    .map((p) => `<p style="margin: 0 0 12px 0; line-height: 1.6;">${p}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, ${color}, ${color}dd); border-radius: 12px 12px 0 0; padding: 24px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 20px; letter-spacing: 0.5px;">
        ⚠️ RISK ALERT — ${analysis.severity.toUpperCase()}
      </h1>
    </div>
    <div style="background: white; border-radius: 0 0 12px 12px; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
      <h2 style="margin: 0 0 16px 0; color: #111827; font-size: 18px;">
        ${analysis.title}
      </h2>
      <div style="color: #374151; font-size: 14px;">
        ${summaryHtml}
      </div>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
      <div style="color: #9CA3AF; font-size: 12px; text-align: center;">
        <p style="margin: 0;">Risk Monitor Agent — ${eventCount} event(s) analyzed</p>
        <p style="margin: 4px 0 0 0;">${new Date().toUTCString()}</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function startRiskMonitorWorker(): void {
  const queue = getQueue(QUEUE_NAMES.RISK_MONITOR);
  const db = getDatabase();
  const riskEventRepo = new RiskEventRepository(db);
  const riskDataService = new RiskDataService();
  const riskAnalysisService = new RiskAnalysisService();
  const emailService = new EmailService();

  const pollInterval = Number(process.env.RISK_MONITOR_POLL_INTERVAL_MS) || 180000;

  // Schedule repeatable job
  queue.add(
    'poll-risk-sources',
    {},
    {
      repeat: { every: pollInterval },
      jobId: 'risk-monitor-poll',
    },
  );

  queue.process('poll-risk-sources', async (job) => {
    logger.info('Risk monitor: starting poll cycle');

    // 1. Fetch from all OSINT sources
    const rawEvents = await riskDataService.fetchAllSources();

    if (rawEvents.length === 0) {
      logger.info('Risk monitor: no events from sources');
      return { newEvents: 0 };
    }

    // 2. Deduplicate via DB insert (ON CONFLICT DO NOTHING)
    const newEvents = [];
    for (const event of rawEvents) {
      const inserted = await riskEventRepo.insertEvent({
        source: event.source,
        source_event_id: event.sourceEventId,
        event_type: event.eventType,
        title: event.title,
        description: event.description,
        location: event.location,
        latitude: event.latitude || null,
        longitude: event.longitude || null,
        event_time: event.eventTime,
        raw_data: event.rawData,
      });
      if (inserted) newEvents.push(inserted);
    }

    if (newEvents.length === 0) {
      logger.info('Risk monitor: all events already seen');
      return { newEvents: 0 };
    }

    logger.info({ newEventCount: newEvents.length }, 'Risk monitor: new events detected');

    // 3. Get recent context for AI analysis
    const recentEvents = await riskEventRepo.findRecentEvents(360); // 6 hours
    const recentAlerts = await riskEventRepo.findRecentAlerts(6); // 6 hours

    // 4. Analyze with Claude AI
    let analysis: ThreatAnalysis;
    try {
      analysis = await riskAnalysisService.analyzeEvents(newEvents, recentEvents, recentAlerts);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Risk monitor: AI analysis failed');
      return { newEvents: newEvents.length, analysisError: true };
    }

    // 5. Send email alerts if actionable
    if (analysis.isActionable && ['critical', 'high', 'medium'].includes(analysis.severity)) {
      const recipients = (process.env.RISK_MONITOR_RECIPIENTS || '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);

      if (recipients.length === 0) {
        logger.warn('Risk monitor: actionable alert but no recipients configured');
        return { newEvents: newEvents.length, severity: analysis.severity, sent: false };
      }

      // Store alert
      await riskEventRepo.insertAlert({
        risk_event_id: newEvents[0].id,
        severity: analysis.severity,
        title: analysis.title,
        summary: analysis.summary,
        raw_analysis: analysis as unknown as Record<string, unknown>,
        recipients,
        sent_at: new Date(),
      });

      // Send emails
      const html = renderAlertHtml(analysis, newEvents.length);
      for (const recipient of recipients) {
        try {
          await emailService.sendEmail({
            to: recipient,
            subject: `[${analysis.severity.toUpperCase()}] ${analysis.title}`,
            text: `${analysis.title}\n\nSeverity: ${analysis.severity.toUpperCase()}\n\n${analysis.summary}\n\n---\nRisk Monitor Agent — ${newEvents.length} event(s) analyzed\n${new Date().toUTCString()}`,
            html,
          });
          logger.info({ recipient, severity: analysis.severity }, 'Risk alert email sent');
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : String(err), recipient }, 'Failed to send risk alert email');
        }
      }

      logger.info(
        { severity: analysis.severity, recipients: recipients.length, newEvents: newEvents.length },
        'Risk monitor: alert cycle complete',
      );
      return { newEvents: newEvents.length, severity: analysis.severity, sent: true };
    }

    logger.info(
      { severity: analysis.severity, actionable: analysis.isActionable, newEvents: newEvents.length },
      'Risk monitor: events analyzed, no alert needed',
    );
    return { newEvents: newEvents.length, severity: analysis.severity, sent: false };
  });

  logger.info({ pollIntervalMs: pollInterval }, 'Risk monitor worker started');
}
