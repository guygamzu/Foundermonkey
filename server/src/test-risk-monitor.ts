/**
 * Quick smoke test for the Risk Monitor Agent.
 * Run: npx tsx server/src/test-risk-monitor.ts
 *
 * Tests each component independently:
 * 1. Data fetching from OSINT sources
 * 2. AI analysis (if ANTHROPIC_API_KEY is set)
 * 3. Email sending (if RESEND_API_KEY is set)
 */

import { RiskDataService } from './services/RiskDataService.js';
import { RiskAnalysisService } from './services/RiskAnalysisService.js';
import { EmailService } from './services/EmailService.js';

async function main() {
  console.log('=== Risk Monitor Agent - Smoke Test ===\n');

  // --- Step 1: Test data fetching ---
  console.log('1) Fetching from OSINT sources...');
  const dataService = new RiskDataService();

  try {
    const events = await dataService.fetchAllSources();
    console.log(`   ✓ Fetched ${events.length} filtered event(s)`);

    if (events.length > 0) {
      console.log('\n   Sample events:');
      for (const event of events.slice(0, 3)) {
        console.log(`   - [${event.source}] ${event.eventType}: ${event.title}`);
        console.log(`     Location: ${event.location || 'N/A'} | Time: ${event.eventTime.toISOString()}`);
      }
    } else {
      console.log('   (No Israel-related missile/rocket events found right now — this is expected during quiet periods)');
    }
  } catch (err) {
    console.error(`   ✗ Data fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Step 2: Test AI analysis (optional) ---
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('\n2) Testing AI analysis with a mock event...');
    const analysisService = new RiskAnalysisService();

    const mockEvents = [{
      id: 'test-1',
      source: 'test',
      source_event_id: 'test-1',
      event_type: 'rocket_attack',
      title: 'Multiple rockets fired toward northern Israel',
      description: 'At least 10 rockets launched from southern Lebanon toward Galilee region. Iron Dome activated.',
      location: 'Northern Israel, Galilee',
      latitude: 32.9,
      longitude: 35.5,
      event_time: new Date(),
      raw_data: {},
      fetched_at: new Date(),
    }];

    try {
      const analysis = await analysisService.analyzeEvents(mockEvents, [], []);
      console.log(`   ✓ Analysis complete:`);
      console.log(`     Severity:   ${analysis.severity}`);
      console.log(`     Title:      ${analysis.title}`);
      console.log(`     Actionable: ${analysis.isActionable}`);
      console.log(`     Summary:    ${analysis.summary.substring(0, 150)}...`);
    } catch (err) {
      console.error(`   ✗ AI analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log('\n2) Skipping AI analysis test (ANTHROPIC_API_KEY not set)');
  }

  // --- Step 3: Test email (optional, dry run) ---
  console.log('\n3) Testing email service...');
  const emailService = new EmailService();
  const verified = await emailService.verify();
  if (verified) {
    console.log('   ✓ Email service configured and ready');
    if (process.env.RISK_MONITOR_RECIPIENTS) {
      console.log(`   Recipients: ${process.env.RISK_MONITOR_RECIPIENTS}`);
    } else {
      console.log('   ⚠ RISK_MONITOR_RECIPIENTS not set — no one will receive alerts');
    }
  } else {
    console.log('   ⚠ Email service not configured (no RESEND_API_KEY) — alerts will be logged only');
  }

  // --- Summary ---
  console.log('\n=== Summary ===');
  console.log(`RISK_MONITOR_ENABLED:  ${process.env.RISK_MONITOR_ENABLED || 'false'}`);
  console.log(`RISK_MONITOR_RECIPIENTS: ${process.env.RISK_MONITOR_RECIPIENTS || '(not set)'}`);
  console.log(`ANTHROPIC_API_KEY:     ${process.env.ANTHROPIC_API_KEY ? '✓ set' : '✗ not set'}`);
  console.log(`ACLED_API_KEY:         ${process.env.ACLED_API_KEY ? '✓ set' : '✗ not set (ACLED source skipped)'}`);
  console.log(`RESEND_API_KEY:        ${process.env.RESEND_API_KEY ? '✓ set' : '✗ not set (dry-run mode)'}`);
  console.log(`Poll interval:         ${process.env.RISK_MONITOR_POLL_INTERVAL_MS || 180000}ms`);
  console.log('\nDone.');
}

main().catch(console.error);
