import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../config/logger.js';
import type { RawRiskEvent } from './RiskDataService.js';
import type { RiskEventRow, RiskAlertRow } from '../models/RiskEventRepository.js';

export interface ThreatAnalysis {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  summary: string;
  isActionable: boolean;
}

export class RiskAnalysisService {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  /**
   * Analyze new risk events using Claude AI.
   * Provides recent context (last 6 hours) so the model can detect escalation patterns.
   */
  async analyzeEvents(
    newEvents: RiskEventRow[],
    recentContext: RiskEventRow[],
    recentAlerts: RiskAlertRow[],
  ): Promise<ThreatAnalysis> {
    const newEventsJson = newEvents.map((e) => ({
      source: e.source,
      type: e.event_type,
      title: e.title,
      description: e.description,
      location: e.location,
      time: e.event_time,
    }));

    const contextJson = recentContext.slice(0, 50).map((e) => ({
      source: e.source,
      type: e.event_type,
      title: e.title,
      location: e.location,
      time: e.event_time,
    }));

    const recentAlertTitles = recentAlerts.slice(0, 10).map((a) => ({
      severity: a.severity,
      title: a.title,
      time: a.created_at,
    }));

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a military intelligence analyst monitoring missile and rocket threats to Israel in real time. Analyze the following new OSINT events and provide a threat assessment.

## New Events (just detected)
${JSON.stringify(newEventsJson, null, 2)}

## Recent Context (last 6 hours of events)
${JSON.stringify(contextJson, null, 2)}

## Recent Alerts Already Sent (avoid duplicating these)
${JSON.stringify(recentAlertTitles, null, 2)}

## Severity Classification Guide
- **critical**: Active missile/rocket barrage targeting populated areas, multiple ballistic missile launches confirmed
- **high**: Confirmed rocket fire toward Israel, interception reported, single ballistic missile launch
- **medium**: Rocket launch detected but intercepted or hit open area, military escalation pattern detected
- **low**: Unconfirmed reports, single event in unpopulated area, routine low-intensity fire
- **info**: General tension increase, military posturing, no direct fire event

## Instructions
1. Assess the threat level of the NEW events in context of recent activity
2. Determine if this warrants an email alert (isActionable). Set to false if:
   - The events are duplicates/updates of already-alerted incidents
   - The severity is "low" or "info"
   - The events are routine with no escalation
3. Write a concise, actionable summary (2-4 paragraphs) suitable for an email alert

Respond ONLY with valid JSON in this exact format:
{
  "severity": "critical|high|medium|low|info",
  "title": "Short alert title (max 80 chars)",
  "summary": "Human-readable situation report for email alert",
  "isActionable": true/false
}`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = JSON.parse(jsonMatch[0]) as ThreatAnalysis;

      // Validate severity
      const validSeverities = ['critical', 'high', 'medium', 'low', 'info'];
      if (!validSeverities.includes(parsed.severity)) {
        parsed.severity = 'info';
      }

      logger.info({ severity: parsed.severity, actionable: parsed.isActionable, title: parsed.title }, 'Threat analysis complete');
      return parsed;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), rawResponse: text.substring(0, 200) }, 'Failed to parse AI threat analysis');

      // Fallback: if we have events but can't parse AI response, default to medium
      return {
        severity: 'medium',
        title: `${newEvents.length} new threat event(s) detected`,
        summary: `${newEvents.length} new event(s) detected from OSINT sources but AI analysis failed to parse. Events: ${newEvents.map((e) => `${e.event_type} at ${e.location || 'unknown location'} (${e.source})`).join('; ')}. Please review manually.`,
        isActionable: newEvents.length > 0,
      };
    }
  }
}
