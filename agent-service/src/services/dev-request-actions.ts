/**
 * Cross-agent development request processor.
 *
 * Parses [ACTION:DEV_REQUEST]...[/ACTION:DEV_REQUEST] blocks from agent
 * output and inserts them into the dev_queue table for Gilfoyle to pick
 * up during his 11 PM night shift.
 *
 * Safeguards:
 *   - Max 2 agent-created requests per rolling 24-hour window
 *   - Priority capped at 3 (human items are 7+, always take precedence)
 *   - All three fields (TITLE, DESCRIPTION, REASONING) required
 *   - Telegram notification on every submission
 *   - created_by set to agent ID for audit trail
 */

import { query, queryOne } from '../db';
import * as activityLogger from './activity-logger';

export interface DevRequestActionResult {
  actionTaken: boolean;
  result: string;
  originalResponse: string;
  devQueueId?: number;
}

const MAX_AGENT_DEV_REQUESTS_PER_DAY = 2;
const AGENT_DEV_REQUEST_PRIORITY = 3;

/**
 * Parse and execute [ACTION:DEV_REQUEST] blocks in agent response.
 * Returns the modified response with action blocks replaced by result notes.
 */
export async function processDevRequestActions(
  agentResponse: string,
  agentId: string,
  taskId?: number,
  notifier?: (text: string) => Promise<void>
): Promise<DevRequestActionResult> {
  // Match paired tags: [ACTION:DEV_REQUEST]...[/ACTION:DEV_REQUEST]
  const devRequestMatch = agentResponse.match(
    /\[ACTION:DEV_REQUEST\]\s*([\s\S]*?)\s*\[\/ACTION:DEV_REQUEST\]/
  );

  if (!devRequestMatch) {
    return {
      actionTaken: false,
      result: agentResponse,
      originalResponse: agentResponse,
    };
  }

  const blockContent = devRequestMatch[1];
  const fullBlock = devRequestMatch[0];

  // Parse fields from block content
  const title = parseField(blockContent, 'TITLE');
  const description = parseField(blockContent, 'DESCRIPTION');
  const reasoning = parseField(blockContent, 'REASONING');

  // Validate required fields
  if (!title || !description || !reasoning) {
    const missing = [
      !title ? 'TITLE' : null,
      !description ? 'DESCRIPTION' : null,
      !reasoning ? 'REASONING' : null,
    ].filter(Boolean).join(', ');

    console.warn(`[DevRequest] Missing required fields: ${missing}`);
    const cleanResponse = agentResponse.replace(fullBlock, '').trim();
    return {
      actionTaken: false,
      result: cleanResponse + `\n\n(Dev request rejected: missing required fields: ${missing})`,
      originalResponse: agentResponse,
    };
  }

  // Rate limit: max N requests per agent per rolling 24 hours
  try {
    const rateCheck = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM dev_queue
       WHERE created_by = $1
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [agentId]
    );

    const recentCount = parseInt(rateCheck?.count ?? '0', 10);
    if (recentCount >= MAX_AGENT_DEV_REQUESTS_PER_DAY) {
      console.warn(`[DevRequest] Rate limit hit: ${agentId} has ${recentCount} requests in last 24h (max ${MAX_AGENT_DEV_REQUESTS_PER_DAY})`);
      const cleanResponse = agentResponse.replace(fullBlock, '').trim();
      return {
        actionTaken: false,
        result: cleanResponse + `\n\n(Dev request rate-limited: max ${MAX_AGENT_DEV_REQUESTS_PER_DAY} requests per day. Try again tomorrow.)`,
        originalResponse: agentResponse,
      };
    }
  } catch (err) {
    console.error('[DevRequest] Rate limit check failed:', (err as Error).message);
    // Continue anyway; don't block on a rate-limit query failure
  }

  // Build the full description for Gilfoyle (includes reasoning as context)
  const fullDescription = [
    description,
    '',
    '---',
    `Requested by: ${agentId} agent`,
    `Reasoning: ${reasoning}`,
  ].join('\n');

  // Insert into dev_queue
  try {
    const inserted = await queryOne<{ id: number }>(
      `INSERT INTO dev_queue (title, description, priority, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [title.substring(0, 100), fullDescription, AGENT_DEV_REQUEST_PRIORITY, agentId]
    );

    const devQueueId = inserted?.id;
    console.log(`[DevRequest] Created dev_queue #${devQueueId}: "${title}" (by ${agentId}, priority ${AGENT_DEV_REQUEST_PRIORITY})`);

    // Log to activity_log
    await activityLogger.log({
      event_type: 'dev_request_created',
      agent_id: agentId,
      task_id: taskId,
      channel: 'dev_queue',
      summary: `Dev request #${devQueueId}: ${title}`,
      metadata: {
        dev_queue_id: devQueueId,
        priority: AGENT_DEV_REQUEST_PRIORITY,
        reasoning,
      },
    });

    // Telegram notification
    if (notifier) {
      const notification = [
        `*Dev Request from ${agentId} agent*`,
        '',
        `Dev Queue #${devQueueId}: ${title}`,
        `Priority: ${AGENT_DEV_REQUEST_PRIORITY}/10 (agent-created)`,
        `Reasoning: ${reasoning.substring(0, 300)}`,
        '',
        `Gilfoyle will pick this up during his night shift.`,
      ].join('\n');

      try {
        await notifier(notification);
      } catch (notifyErr) {
        console.warn('[DevRequest] Telegram notification failed:', (notifyErr as Error).message);
      }
    }

    // Strip action block and append confirmation
    const cleanResponse = agentResponse.replace(fullBlock, '').trim();
    return {
      actionTaken: true,
      result: cleanResponse + `\n\n(Dev request #${devQueueId} queued: "${title}" at priority ${AGENT_DEV_REQUEST_PRIORITY}. Gilfoyle will pick it up tonight.)`,
      originalResponse: agentResponse,
      devQueueId: devQueueId ?? undefined,
    };
  } catch (err) {
    console.error('[DevRequest] Failed to insert into dev_queue:', (err as Error).message);
    const cleanResponse = agentResponse.replace(fullBlock, '').trim();
    return {
      actionTaken: false,
      result: cleanResponse + `\n\n(Dev request failed: ${(err as Error).message})`,
      originalResponse: agentResponse,
    };
  }
}

/**
 * Parse a KEY: value field from block content.
 * Supports multi-line values (everything until the next KEY: or end of content).
 */
function parseField(content: string, fieldName: string): string | null {
  const regex = new RegExp(
    `${fieldName}:\\s*(.+?)(?=\\n(?:TITLE|DESCRIPTION|REASONING):|$)`,
    's'
  );
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}
