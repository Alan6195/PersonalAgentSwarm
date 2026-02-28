/**
 * Cron Scheduler
 *
 * Reads enabled cron_jobs from the database every 60 seconds.
 * When a job's next_run_at has passed, executes it and records the result.
 * Uses the executor for single-shot agents and the Twitter action pipeline for social-media.
 *
 * All times are in Mountain Time (America/Denver).
 */

import { query, queryOne } from '../db';
import { config } from '../config';
import * as executor from '../agents/executor';
import * as taskManager from './task-manager';
import * as activityLogger from './activity-logger';
import { processTwitterActions } from './twitter-actions';
import { processEmailActions } from './email-actions';
import { processGmailActions } from './gmail-actions';
import { processWeddingDataActions } from './wedding-data-actions';
import { buildProactiveContext } from './proactive-sweep';
import { executeDeveloperTask } from './developer-executor';
import { getPrompt } from '../agents/registry';
import { checkBudget } from './cost-guardrails';

interface CronJob {
  id: number;
  name: string;
  description: string;
  schedule: string;
  agent_id: string;
  enabled: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
  prompt_override: string | null;
}

let schedulerInterval: NodeJS.Timeout | null = null;
let telegramNotify: ((text: string) => Promise<void>) | null = null;

/**
 * Set the Telegram notification callback (called from index.ts)
 */
export function setCronNotifier(notifier: (text: string) => Promise<void>): void {
  telegramNotify = notifier;
}

/**
 * Start the cron scheduler loop. Checks every 60 seconds.
 */
export function startScheduler(): void {
  console.log('[Cron] Scheduler started, checking every 60s');

  // Run immediately on start, then every 60s
  checkAndRunJobs();
  schedulerInterval = setInterval(checkAndRunJobs, 60_000);
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

/**
 * Main loop: find due jobs and run them.
 */
async function checkAndRunJobs(): Promise<void> {
  try {
    const dueJobs = await query<CronJob>(
      `SELECT * FROM cron_jobs
       WHERE enabled = true
         AND next_run_at IS NOT NULL
         AND next_run_at <= NOW()
         AND last_status != 'running'
       ORDER BY next_run_at ASC`
    );

    for (const job of dueJobs) {
      // Run each job sequentially to avoid overwhelming the API
      await runJob(job).catch(err => {
        console.error(`[Cron] Job "${job.name}" failed:`, (err as Error).message);
      });
    }
  } catch (err) {
    console.error('[Cron] Scheduler check failed:', (err as Error).message);
  }
}

/**
 * Execute a single cron job.
 */
async function runJob(job: CronJob): Promise<void> {
  console.log(`[Cron] Running job: ${job.name} (agent: ${job.agent_id})`);

  // Mark job as running AND advance next_run_at immediately to prevent
  // the scheduler from picking up the same job on the next 60s tick
  // (jobs can take 5+ minutes; without this, duplicates fire every tick)
  const earlyNextRun = calculateNextRun(job.schedule);
  await query(
    `UPDATE cron_jobs SET last_status = 'running', next_run_at = $1, updated_at = NOW() WHERE id = $2`,
    [earlyNextRun, job.id]
  );

  // Create a cron_runs entry
  const run = await queryOne<{ id: number }>(
    `INSERT INTO cron_runs (cron_job_id, status, started_at) VALUES ($1, 'running', NOW()) RETURNING id`,
    [job.id]
  );
  if (!run) throw new Error('Failed to create cron_run');

  // Create a task for tracking
  const task = await taskManager.createTask({
    title: `Cron: ${job.name}`,
    description: job.description || job.name,
    status: 'in_progress',
    priority: 'normal',
    assigned_agent: job.agent_id,
    input_summary: job.prompt_override || job.description || job.name,
    metadata: { cron_job_id: job.id, cron_run_id: run.id, channel: 'cron' },
  });

  await activityLogger.log({
    event_type: 'cron_started',
    agent_id: job.agent_id,
    task_id: task.id,
    channel: 'cron',
    summary: `Cron job started: ${job.name}`,
  });

  const startTime = Date.now();

  try {
    // Budget check before running cron jobs
    try {
      const budget = await checkBudget(job.agent_id);
      if (!budget.allowed) {
        console.warn(`[Cron] Budget exceeded for ${job.agent_id}: ${budget.reason}. Skipping "${job.name}".`);
        const nextRun = calculateNextRun(job.schedule);
        await query(
          `UPDATE cron_jobs SET last_status = 'skipped', last_run_at = NOW(), next_run_at = $1, last_error = $2, updated_at = NOW() WHERE id = $3`,
          [nextRun, `Budget: ${budget.reason}`, job.id]
        );
        await query(
          `UPDATE cron_runs SET status = 'skipped', error_message = $1, completed_at = NOW() WHERE id = $2`,
          [`Budget: ${budget.reason}`, run.id]
        );
        await taskManager.failTask(task.id, `Budget exceeded: ${budget.reason}`);
        return;
      }
    } catch { /* non-critical: proceed if budget check fails */ }

    // Build the prompt: use prompt_override if set, otherwise the job description
    let userMessage = job.prompt_override || job.description || job.name;

    // Proactive sweep: inject aggregated context before the prompt
    const isProactiveSweep = job.name.toLowerCase().includes('proactive sweep');
    if (isProactiveSweep) {
      try {
        const proactiveData = await buildProactiveContext();
        userMessage = `${proactiveData}\n\n---\n\n${userMessage}`;
        console.log(`[Cron] Injected proactive context for ${job.name}`);
      } catch (err) {
        console.warn('[Cron] Failed to build proactive context:', (err as Error).message);
      }
    }

    // Gilfoyle dev queue: pick highest-priority pending item and run in ship mode
    const isGilfoyleDevQueue = job.agent_id === 'gilfoyle' && job.name.toLowerCase().includes('night shift');
    if (isGilfoyleDevQueue) {
      const devItem = await queryOne<{ id: number; title: string; description: string; priority: number }>(
        `SELECT id, title, description, priority FROM dev_queue
         WHERE status = 'pending'
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`
      );

      if (!devItem) {
        console.log('[Cron] Gilfoyle Night Shift: No pending dev queue items. QUEUE_EMPTY.');
        const durationMs = Date.now() - startTime;
        const nextRun = calculateNextRun(job.schedule);
        await query(`UPDATE cron_runs SET status = 'success', output_summary = 'QUEUE_EMPTY', duration_ms = $1, completed_at = NOW() WHERE id = $2`, [durationMs, run.id]);
        await query(`UPDATE cron_jobs SET last_status = 'success', last_run_at = NOW(), next_run_at = $1, last_duration_ms = $2, run_count = run_count + 1, updated_at = NOW() WHERE id = $3`, [nextRun, durationMs, job.id]);
        await taskManager.completeTask(task.id, { content: 'QUEUE_EMPTY', tokensUsed: 0, costCents: 0, durationMs });
        return;
      }

      // Mark dev queue item as in_progress
      await query(`UPDATE dev_queue SET status = 'in_progress', assigned_at = NOW(), task_id = $1, updated_at = NOW() WHERE id = $2`, [task.id, devItem.id]);

      console.log(`[Cron] Gilfoyle Night Shift: Working on dev_queue #${devItem.id}: ${devItem.title}`);

      await taskManager.setAgentStatus('gilfoyle', 'active');

      const devResult = await executeDeveloperTask(
        `Dev Queue Item #${devItem.id}: ${devItem.title}\n\n${devItem.description}`,
        getPrompt('gilfoyle'),
        config.DEV_AGENT_CWD,
        {
          shipMode: true,
          onProgress: telegramNotify ?? undefined,
        }
      );

      await taskManager.setAgentStatus('gilfoyle', 'idle');

      // Update dev_queue with results
      const devStatus = devResult.content.includes('failed') ? 'failed' : 'completed';
      await query(
        `UPDATE dev_queue SET
          status = $1, completed_at = NOW(), result_summary = $2,
          cost_usd = $3, turns_used = $4, files_modified = $5,
          error_message = $6, updated_at = NOW()
         WHERE id = $7`,
        [
          devStatus,
          devResult.content.substring(0, 2000),
          devResult.totalCostUsd,
          devResult.numTurns,
          JSON.stringify(devResult.filesModified),
          devStatus === 'failed' ? devResult.content.substring(0, 500) : null,
          devItem.id,
        ]
      );

      const durationMs = Date.now() - startTime;
      const costCents = Math.ceil(devResult.totalCostUsd * 100);

      // Update cron tracking
      await query(`UPDATE cron_runs SET status = 'success', tokens_used = $1, cost_cents = $2, duration_ms = $3, output_summary = $4, completed_at = NOW() WHERE id = $5`,
        [devResult.totalTokens, costCents, durationMs, devResult.content.substring(0, 2000), run.id]);
      const nextRun = calculateNextRun(job.schedule);
      await query(`UPDATE cron_jobs SET last_status = 'success', last_run_at = NOW(), next_run_at = $1, last_duration_ms = $2, run_count = run_count + 1, updated_at = NOW() WHERE id = $3`,
        [nextRun, durationMs, job.id]);
      await taskManager.completeTask(task.id, { content: devResult.content, tokensUsed: devResult.totalTokens, costCents, durationMs });

      // Notify via Telegram
      if (telegramNotify) {
        const filesStr = devResult.filesModified.length > 0
          ? `\nFiles: ${devResult.filesModified.slice(0, 10).map(f => f.split('/').pop()).join(', ')}`
          : '';
        const notification = `*Gilfoyle Night Shift Complete*\n\nDev Queue #${devItem.id}: ${devItem.title}\nStatus: ${devStatus}\nTurns: ${devResult.numTurns} | Cost: $${devResult.totalCostUsd.toFixed(2)}${filesStr}\n\n${devResult.content.substring(0, 2000)}`;
        try { await telegramNotify(notification); } catch { /* non-critical */ }
      }

      console.log(`[Cron] Gilfoyle Night Shift completed: dev_queue #${devItem.id} (${devResult.numTurns} turns, $${devResult.totalCostUsd.toFixed(2)})`);
      return;
    }

    // Standard execution: run through the executor
    const agentResponse = await executor.run({
      agentId: job.agent_id,
      taskId: task.id,
      userMessage,
    });

    let finalResponse = agentResponse.content;

    // If social-media agent, process Twitter action blocks
    if (job.agent_id === 'social-media') {
      const twitterResult = await processTwitterActions(finalResponse, task.id);
      finalResponse = twitterResult.result;

      if (twitterResult.actionTaken) {
        await activityLogger.log({
          event_type: 'twitter_action',
          agent_id: 'social-media',
          task_id: task.id,
          channel: 'twitter',
          summary: `Cron X action: ${twitterResult.actionType}`,
          metadata: { action_type: twitterResult.actionType, cron_job: job.name },
        });
      }
    }

    // If life-admin agent, process email action blocks
    if (job.agent_id === 'life-admin') {
      const emailResult = await processEmailActions(finalResponse, task.id);
      finalResponse = emailResult.result;

      if (emailResult.actionsTaken) {
        await activityLogger.log({
          event_type: 'email_action',
          agent_id: 'life-admin',
          task_id: task.id,
          channel: 'email',
          summary: `Cron email actions: ${emailResult.actions.join(', ')}`,
          metadata: { actions: emailResult.actions, cron_job: job.name },
        });
      }
    }

    // If wedding-planner agent, process Gmail action blocks
    if (job.agent_id === 'wedding-planner') {
      const gmailResult = await processGmailActions(finalResponse, task.id);
      finalResponse = gmailResult.result;

      if (gmailResult.actionsTaken) {
        await activityLogger.log({
          event_type: 'gmail_action',
          agent_id: 'wedding-planner',
          task_id: task.id,
          channel: 'gmail',
          summary: `Cron Gmail actions: ${gmailResult.actions.join(', ')}`,
          metadata: { actions: gmailResult.actions, cron_job: job.name },
        });
      }

      // Also process any wedding dashboard data blocks
      const weddingDataResult = await processWeddingDataActions(finalResponse, task.id);
      finalResponse = weddingDataResult.result;

      if (weddingDataResult.actionsTaken) {
        await activityLogger.log({
          event_type: 'wedding_data_update',
          agent_id: 'wedding-planner',
          task_id: task.id,
          channel: 'wedding',
          summary: `Cron wedding data: ${weddingDataResult.actions.join(', ')}`,
          metadata: { actions: weddingDataResult.actions, cron_job: job.name },
        });
      }
    }

    const durationMs = Date.now() - startTime;

    // Update cron_runs
    await query(
      `UPDATE cron_runs SET
        status = 'success',
        tokens_used = $1,
        cost_cents = $2,
        duration_ms = $3,
        output_summary = $4,
        completed_at = NOW()
       WHERE id = $5`,
      [agentResponse.tokensUsed.total, agentResponse.costCents, durationMs, finalResponse.substring(0, 2000), run.id]
    );

    // Update cron_jobs
    const nextRun = calculateNextRun(job.schedule);
    await query(
      `UPDATE cron_jobs SET
        last_status = 'success',
        last_run_at = NOW(),
        next_run_at = $1,
        last_duration_ms = $2,
        run_count = run_count + 1,
        avg_tokens = CASE WHEN run_count = 0 THEN $3 ELSE (avg_tokens * run_count + $3) / (run_count + 1) END,
        avg_cost_cents = CASE WHEN run_count = 0 THEN $4 ELSE (avg_cost_cents * run_count + $4) / (run_count + 1) END,
        updated_at = NOW()
       WHERE id = $5`,
      [nextRun, durationMs, agentResponse.tokensUsed.total, agentResponse.costCents, job.id]
    );

    // Complete the task
    await taskManager.completeTask(task.id, {
      content: finalResponse,
      tokensUsed: agentResponse.tokensUsed.total,
      costCents: agentResponse.costCents,
      durationMs,
    });

    await activityLogger.log({
      event_type: 'cron_completed',
      agent_id: job.agent_id,
      task_id: task.id,
      channel: 'cron',
      summary: `Cron completed: ${job.name} (${durationMs}ms, ${agentResponse.costCents}c)`,
    });

    // Notify via Telegram for social-media posts (so Alan can see what was posted)
    if (job.agent_id === 'social-media' && telegramNotify) {
      const notification = `*Autonomous post (${job.name})*\n\n${finalResponse.substring(0, 3000)}`;
      try {
        await telegramNotify(notification);
      } catch { /* non-critical */ }
    }

    // Notify via Telegram for life-admin email triage jobs
    if (job.agent_id === 'life-admin' && telegramNotify && job.name.toLowerCase().includes('email')) {
      const notification = `*Email Triage (${job.name})*\n\n${finalResponse.substring(0, 3000)}`;
      try {
        await telegramNotify(notification);
      } catch { /* non-critical */ }
    }

    // Notify via Telegram for wedding-planner email triage jobs
    if (job.agent_id === 'wedding-planner' && telegramNotify && job.name.toLowerCase().includes('email')) {
      const notification = `*Wedding Email (${job.name})*\n\n${finalResponse.substring(0, 3000)}`;
      try {
        await telegramNotify(notification);
      } catch { /* non-critical */ }
    }

    // Notify via Telegram for proactive sweeps (only if actionable, skip ALL_CLEAR)
    if (isProactiveSweep && telegramNotify) {
      const trimmed = finalResponse.trim();
      if (!trimmed.includes('ALL_CLEAR') && trimmed.length > 20) {
        const notification = `*Proactive Sweep (${job.name})*\n\n${finalResponse.substring(0, 3000)}`;
        try {
          await telegramNotify(notification);
        } catch { /* non-critical */ }
      } else {
        console.log(`[Cron] Proactive sweep "${job.name}": ALL_CLEAR, no notification.`);
      }
    }

    console.log(`[Cron] Job "${job.name}" completed (${durationMs}ms)`);

  } catch (err) {
    const errorMsg = (err as Error).message;
    const durationMs = Date.now() - startTime;

    // Update cron_runs
    await query(
      `UPDATE cron_runs SET
        status = 'failed',
        duration_ms = $1,
        error_message = $2,
        completed_at = NOW()
       WHERE id = $3`,
      [durationMs, errorMsg, run.id]
    );

    // Update cron_jobs
    const nextRun = calculateNextRun(job.schedule);
    await query(
      `UPDATE cron_jobs SET
        last_status = 'failed',
        last_run_at = NOW(),
        next_run_at = $1,
        last_error = $2,
        last_duration_ms = $3,
        run_count = run_count + 1,
        fail_count = fail_count + 1,
        updated_at = NOW()
       WHERE id = $4`,
      [nextRun, errorMsg, durationMs, job.id]
    );

    await taskManager.failTask(task.id, errorMsg);

    await activityLogger.log({
      event_type: 'cron_failed',
      agent_id: job.agent_id,
      task_id: task.id,
      channel: 'cron',
      summary: `Cron failed: ${job.name}: ${errorMsg.substring(0, 200)}`,
    });

    console.error(`[Cron] Job "${job.name}" failed: ${errorMsg}`);
  }
}

/**
 * Parse a cron schedule string and compute the next run time.
 * Supports standard 5-field cron: minute hour day month weekday
 *
 * For simplicity, this does a forward scan from "now" up to 7 days out.
 * All times are calculated in Mountain Time.
 */
function calculateNextRun(schedule: string): Date {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    // Fallback: run again in 24 hours
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  const [minSpec, hourSpec, domSpec, monSpec, dowSpec] = parts;

  // Scan forward from 1 minute from now, minute by minute, up to 7 days
  const now = new Date();
  const start = new Date(now.getTime() + 60_000); // at least 1 minute from now
  start.setSeconds(0, 0);

  const maxScan = 7 * 24 * 60; // 7 days in minutes

  for (let i = 0; i < maxScan; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);

    // Convert to Mountain Time for matching
    const mt = new Date(candidate.toLocaleString('en-US', { timeZone: 'America/Denver' }));
    const min = mt.getMinutes();
    const hour = mt.getHours();
    const dom = mt.getDate();
    const mon = mt.getMonth() + 1;
    const dow = mt.getDay(); // 0=Sunday

    if (
      matchesCronField(minSpec, min, 0, 59) &&
      matchesCronField(hourSpec, hour, 0, 23) &&
      matchesCronField(domSpec, dom, 1, 31) &&
      matchesCronField(monSpec, mon, 1, 12) &&
      matchesCronField(dowSpec, dow, 0, 6)
    ) {
      return candidate;
    }
  }

  // Fallback: 24 hours
  return new Date(Date.now() + 24 * 60 * 60 * 1000);
}

/**
 * Check if a value matches a cron field spec.
 * Supports: *, specific numbers, comma-separated lists, ranges (1-5), step values (asterisk/N)
 */
function matchesCronField(spec: string, value: number, min: number, max: number): boolean {
  if (spec === '*') return true;

  // Handle step: */N
  if (spec.startsWith('*/')) {
    const step = parseInt(spec.substring(2), 10);
    return !isNaN(step) && step > 0 && value % step === 0;
  }

  // Handle comma-separated values and ranges
  const parts = spec.split(',');
  for (const part of parts) {
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && value === num) return true;
    }
  }

  return false;
}
