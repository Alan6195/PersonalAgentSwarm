/**
 * Proactive Intelligence Sweep
 *
 * Aggregates data from multiple sources to build a comprehensive context
 * for alan-os proactive sweeps. Checks: wedding deadlines, email counts,
 * budget status, cost spend, agent health, and calendar.
 */

import { query, queryOne } from '../db';
import * as outlookMail from './outlook-mail';
import * as gmailMail from './gmail-mail';
import * as googleCalendar from './google-calendar';

export async function buildProactiveContext(): Promise<string> {
  const sections: string[] = ['## PROACTIVE SWEEP DATA\n'];

  // 1. Wedding countdown
  const weddingDate = new Date('2026-07-12');
  const now = new Date();
  const daysToWedding = Math.ceil((weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  sections.push(`### Wedding Countdown: ${daysToWedding} days to July 12, 2026\n`);

  // 2. Wedding timeline: upcoming deadlines
  try {
    const deadlines = await query<{ title: string; date: string; category: string }>(
      `SELECT title, date, category FROM wedding_timeline
       WHERE completed = false AND date <= CURRENT_DATE + INTERVAL '7 days'
       ORDER BY date ASC LIMIT 10`
    );
    if (deadlines.length > 0) {
      sections.push('### Upcoming Wedding Deadlines (next 7 days)');
      for (const d of deadlines) {
        const dateStr = new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        sections.push(`- ${dateStr}: ${d.title} (${d.category})`);
      }
      sections.push('');
    }
  } catch { /* table may not exist yet */ }

  // 3. Wedding budget status
  try {
    const budgetRow = await queryOne<{ total_est: string; total_actual: string; total_paid: string; item_count: string }>(
      `SELECT
        COALESCE(SUM(estimated_cents), 0) as total_est,
        COALESCE(SUM(actual_cents), 0) as total_actual,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN estimated_cents ELSE 0 END), 0) as total_paid,
        COUNT(*) as item_count
       FROM wedding_budget`
    );
    if (budgetRow && parseInt(budgetRow.item_count) > 0) {
      const est = parseInt(budgetRow.total_est) / 100;
      const actual = parseInt(budgetRow.total_actual) / 100;
      const paid = parseInt(budgetRow.total_paid) / 100;
      const overUnder = est - 45000;
      sections.push(`### Wedding Budget`);
      sections.push(`Allocated: $${est.toFixed(0)} / $45,000 target (${overUnder >= 0 ? `$${overUnder.toFixed(0)} OVER` : `$${Math.abs(overUnder).toFixed(0)} under`})`);
      sections.push(`Paid to date: $${paid.toFixed(0)} | Actual spent: $${actual.toFixed(0)}\n`);
    }
  } catch { /* table may not exist yet */ }

  // 4. Unread email counts
  try {
    if (outlookMail.isConfigured()) {
      const msgs = await outlookMail.getInboxMessages({ top: 5, unreadOnly: true });
      sections.push(`### Outlook Inbox: ${msgs.length}${msgs.length >= 5 ? '+' : ''} unread emails`);
    }
  } catch { /* non-critical */ }

  try {
    if (gmailMail.isConfigured()) {
      const msgs = await gmailMail.getInboxMessages({ maxResults: 5, unreadOnly: true });
      sections.push(`### Wedding Gmail: ${msgs.length}${msgs.length >= 5 ? '+' : ''} unread emails`);
    }
  } catch { /* non-critical */ }

  // 5. Today's calendar events
  try {
    if (googleCalendar.isConfigured()) {
      const events = await googleCalendar.getTodaysEvents();
      if (events.length > 0) {
        const formatted = googleCalendar.formatEventsForAgent(events);
        sections.push(`\n### Today's Calendar\n${formatted}`);
      } else {
        sections.push(`\n### Today's Calendar: No events scheduled`);
      }
    }
  } catch { /* non-critical */ }

  // 6. Today's cost spend
  try {
    const costRow = await queryOne<{ total: string }>(
      "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_events WHERE created_at >= CURRENT_DATE"
    );
    const todaySpend = parseInt(costRow?.total ?? '0', 10) / 100;
    sections.push(`\n### Agent Costs Today: $${todaySpend.toFixed(2)}`);
  } catch { /* non-critical */ }

  // 7. Agent health
  try {
    const errorAgents = await query<{ id: string; name: string }>(
      "SELECT id, name FROM agents WHERE status = 'error'"
    );
    if (errorAgents.length > 0) {
      sections.push(`\n### AGENT HEALTH WARNING`);
      for (const a of errorAgents) {
        sections.push(`- ${a.name} (${a.id}) is in ERROR state`);
      }
    }
  } catch { /* non-critical */ }

  // 8. Failed cron jobs in last 24 hours
  try {
    const failedCrons = await query<{ name: string; last_error: string }>(
      "SELECT name, last_error FROM cron_jobs WHERE last_status = 'failed' AND last_run_at > NOW() - INTERVAL '24 hours'"
    );
    if (failedCrons.length > 0) {
      sections.push(`\n### Failed Cron Jobs (last 24h)`);
      for (const c of failedCrons) {
        sections.push(`- ${c.name}: ${(c.last_error || 'unknown error').substring(0, 100)}`);
      }
    }
  } catch { /* non-critical */ }

  // 9. Dev queue status
  try {
    const pendingRow = await queryOne<{ count: string }>(
      "SELECT COUNT(*) as count FROM dev_queue WHERE status = 'pending'"
    );
    const pending = parseInt(pendingRow?.count ?? '0', 10);
    if (pending > 0) {
      sections.push(`\n### Dev Queue: ${pending} pending items for Gilfoyle`);
    }
  } catch { /* table may not exist yet */ }

  return sections.join('\n');
}
