/**
 * Hypothesis Engine
 *
 * Self-improvement loop for the X agent. Three exports:
 *   - maybeLogHypothesis(): fire-and-forget after each post, logs implicit hypotheses
 *   - getConfirmedHypotheses(): returns markdown for prompt injection
 *   - runWeeklyReview(): Claude-powered hypothesis evaluation + generation
 */

import { query, queryOne } from '../db';
import { callClaude } from './claude';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Hypothesis {
  id: number;
  hypothesis: string;
  variable: string;
  prediction: string;
  status: string;
  confidence: number;
  supporting_post_ids: string[];
  contradicting_post_ids: string[];
  source: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// maybeLogHypothesis: fire-and-forget after each post
// ---------------------------------------------------------------------------

const MAX_ACTIVE_HYPOTHESES = 10;

/**
 * Called after each post. Creates implicit hypotheses from content choices.
 * Fire-and-forget; never throws.
 */
export async function maybeLogHypothesis(params: {
  tweetId: string;
  contentType: string;
  contentBucket?: string | null;
  hookPattern?: string;
  visualStrategy?: string | null;
  postedHour?: number;
  topic?: string | null;
}): Promise<void> {
  try {
    // Check active count; skip if we already have enough
    const [countRow] = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM content_hypotheses WHERE status = 'active'`
    );
    const activeCount = parseInt(countRow?.total || '0', 10);
    if (activeCount >= MAX_ACTIVE_HYPOTHESES) return;

    const candidates: Array<{ variable: string; hypothesis: string; prediction: string }> = [];

    // Visual strategy hypothesis
    if (params.visualStrategy) {
      candidates.push({
        variable: `visual:${params.visualStrategy.substring(0, 50)}`,
        hypothesis: `Posts with visual strategy "${params.visualStrategy.substring(0, 80)}" outperform average engagement`,
        prediction: 'above_average_engagement',
      });
    }

    // Hook + hour combo hypothesis
    if (params.hookPattern && params.postedHour !== undefined) {
      candidates.push({
        variable: `hook_hour:${params.hookPattern}_${params.postedHour}`,
        hypothesis: `${params.hookPattern} hooks posted at ${params.postedHour}:00 MT outperform other hours for this hook type`,
        prediction: 'above_average_for_hook',
      });
    }

    // Content bucket + content type hypothesis
    if (params.contentBucket && params.contentType) {
      candidates.push({
        variable: `bucket_type:${params.contentBucket}_${params.contentType}`,
        hypothesis: `${params.contentBucket} content as ${params.contentType} outperforms other formats for this category`,
        prediction: 'above_average_for_bucket',
      });
    }

    // Insert candidates that don't already exist (deduplicate by variable)
    for (const c of candidates) {
      if (activeCount + candidates.indexOf(c) >= MAX_ACTIVE_HYPOTHESES) break;

      const existing = await queryOne<{ id: number }>(
        `SELECT id FROM content_hypotheses WHERE variable = $1 AND status = 'active'`,
        [c.variable]
      );

      if (!existing) {
        await query(
          `INSERT INTO content_hypotheses (hypothesis, variable, prediction, source)
           VALUES ($1, $2, $3, 'implicit')`,
          [c.hypothesis, c.variable, c.prediction]
        );
        console.log(`[Hypothesis] Logged implicit: "${c.hypothesis.substring(0, 80)}"`);
      } else {
        // Update supporting_post_ids for existing hypothesis
        await query(
          `UPDATE content_hypotheses
           SET supporting_post_ids = array_append(supporting_post_ids, $1), updated_at = NOW()
           WHERE id = $2`,
          [params.tweetId, existing.id]
        );
      }
    }
  } catch (err) {
    console.warn('[Hypothesis] maybeLogHypothesis failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// getConfirmedHypotheses: returns markdown for prompt injection
// ---------------------------------------------------------------------------

/**
 * Returns a markdown block of confirmed + high-confidence active hypotheses.
 * Injected into agent prompt at runtime.
 */
export async function getConfirmedHypotheses(): Promise<string> {
  try {
    // Get confirmed hypotheses
    const confirmed = await query<Hypothesis>(
      `SELECT * FROM content_hypotheses WHERE status = 'confirmed' ORDER BY confidence DESC LIMIT 10`
    );

    // Get high-confidence active hypotheses (being tested)
    const active = await query<Hypothesis>(
      `SELECT * FROM content_hypotheses WHERE status = 'active' AND confidence >= 60 ORDER BY confidence DESC LIMIT 5`
    );

    if (confirmed.length === 0 && active.length === 0) return '';

    const lines: string[] = ['## CONTENT HYPOTHESES (data-driven learnings)\n'];

    if (confirmed.length > 0) {
      lines.push('**Confirmed (use these as standing content rules):**');
      for (const h of confirmed) {
        const postCount = (h.supporting_post_ids?.length || 0) + (h.contradicting_post_ids?.length || 0);
        lines.push(`- [CONFIRMED, ${h.confidence}% confidence] ${h.hypothesis} (${postCount} posts)`);
      }
    }

    if (active.length > 0) {
      lines.push('\n**Testing (lean into these but not conclusive yet):**');
      for (const h of active) {
        const postCount = (h.supporting_post_ids?.length || 0) + (h.contradicting_post_ids?.length || 0);
        lines.push(`- [TESTING, ${h.confidence}% confidence] ${h.hypothesis} (${postCount} posts)`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    console.warn('[Hypothesis] getConfirmedHypotheses failed:', (err as Error).message);
    return '';
  }
}

// ---------------------------------------------------------------------------
// runWeeklyReview: Claude-powered hypothesis evaluation
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM_PROMPT = `You are the performance analyst for an AI consultant's X (Twitter) account (@AscendIntuition).

You will receive:
1. All posts from the last 14 days with engagement metrics
2. Current active hypotheses about what content performs

Your job:
1. For each active hypothesis, find supporting or refuting evidence in the post data
2. Update confidence scores (0-100) based on evidence weight
3. Mark hypotheses as 'confirmed' (confidence > 80, 3+ data points) or 'refuted' (confidence < 20, 3+ data points)
4. Identify 1-3 NEW hypotheses suggested by the data that aren't yet tracked
5. Flag any surprising patterns worth investigating

Output ONLY valid JSON (no markdown fences, no commentary):
{
  "hypothesis_updates": [
    {
      "id": 123,
      "new_confidence": 85,
      "new_status": "confirmed",
      "reasoning": "short explanation",
      "supporting_post_ids": ["tweet_id_1"],
      "contradicting_post_ids": []
    }
  ],
  "new_hypotheses": [
    {
      "hypothesis": "Posts with specific numbers outperform vague claims",
      "variable": "copy_style:specific_numbers",
      "prediction": "above_average_engagement",
      "confidence": 60,
      "evidence_post_ids": ["tweet_id_1"]
    }
  ],
  "patterns_to_investigate": [
    "Morning posts appear to get 2x impressions"
  ],
  "summary": "3 hypotheses confirmed, 1 refuted, 2 new hypotheses added"
}`;

/**
 * Weekly hypothesis review. Called by the Hypothesis Review cron job.
 * Returns a summary string for Telegram notification.
 */
export async function runWeeklyReview(taskId: number): Promise<string> {
  // 1. Pull posts from last 14 days with performance data
  const posts = await query<{
    id: number;
    tweet_id: string;
    content: string;
    content_type: string;
    content_bucket: string | null;
    hook_pattern: string | null;
    topic: string | null;
    visual_strategy: string | null;
    posted_hour: number;
    posted_day: number;
    engagement_rate: string | null;
    likes: string | null;
    replies: string | null;
    retweets: string | null;
    impressions: string | null;
  }>(`
    SELECT pa.id, pa.tweet_id, pa.content, pa.content_type, pa.content_bucket,
           pa.hook_pattern, pa.topic, pa.visual_strategy, pa.posted_hour, pa.posted_day,
           ps.engagement_rate, ps.likes, ps.replies, ps.retweets, ps.impressions
    FROM post_analytics pa
    LEFT JOIN LATERAL (
      SELECT engagement_rate, likes, replies, retweets, impressions
      FROM post_snapshots
      WHERE post_analytics_id = pa.id
      ORDER BY CASE interval_label
        WHEN '24h' THEN 1 WHEN '7d' THEN 2 WHEN '3d' THEN 3 WHEN '4h' THEN 4 WHEN '1h' THEN 5
      END
      LIMIT 1
    ) ps ON true
    WHERE pa.created_at >= NOW() - INTERVAL '14 days'
    ORDER BY pa.created_at DESC
  `);

  if (posts.length < 3) {
    return 'Not enough posts in last 14 days for hypothesis review (need at least 3)';
  }

  // 2. Pull active hypotheses
  const hypotheses = await query<Hypothesis>(
    `SELECT * FROM content_hypotheses WHERE status = 'active' ORDER BY created_at ASC`
  );

  // 3. Build context for Claude
  const postsContext = posts.map(p => ({
    tweet_id: p.tweet_id,
    content: p.content.substring(0, 150),
    type: p.content_type,
    bucket: p.content_bucket,
    hook: p.hook_pattern,
    topic: p.topic,
    visual: p.visual_strategy,
    hour: p.posted_hour,
    day: p.posted_day,
    engagement_rate: p.engagement_rate ? `${(parseFloat(p.engagement_rate) * 100).toFixed(1)}%` : 'no data',
    likes: p.likes || '0',
    impressions: p.impressions || '0',
  }));

  const hypothesesContext = hypotheses.map(h => ({
    id: h.id,
    hypothesis: h.hypothesis,
    variable: h.variable,
    confidence: h.confidence,
    supporting: h.supporting_post_ids?.length || 0,
    contradicting: h.contradicting_post_ids?.length || 0,
  }));

  const userMessage = `## Posts (last 14 days)\n${JSON.stringify(postsContext, null, 2)}\n\n## Active Hypotheses\n${JSON.stringify(hypothesesContext, null, 2)}`;

  // 4. Run Claude analysis
  const result = await callClaude({
    model: 'claude-sonnet-4-20250514',
    system: REVIEW_SYSTEM_PROMPT,
    userMessage,
    agentId: 'social-media',
    taskId,
    eventType: 'cron',
    maxTokens: 2000,
  });

  // 5. Parse response
  let review: {
    hypothesis_updates?: Array<{
      id: number;
      new_confidence: number;
      new_status?: string;
      reasoning?: string;
      supporting_post_ids?: string[];
      contradicting_post_ids?: string[];
    }>;
    new_hypotheses?: Array<{
      hypothesis: string;
      variable: string;
      prediction: string;
      confidence: number;
      evidence_post_ids?: string[];
    }>;
    patterns_to_investigate?: string[];
    summary?: string;
  };

  try {
    review = JSON.parse(result.content);
  } catch {
    console.error('[Hypothesis] Failed to parse Claude review response:', result.content.substring(0, 500));
    return `Hypothesis review completed but response parsing failed. Raw: ${result.content.substring(0, 200)}`;
  }

  // 6. Apply updates
  let confirmed = 0;
  let refuted = 0;
  let updated = 0;
  let newCount = 0;

  for (const update of review.hypothesis_updates || []) {
    const status = update.new_status || 'active';
    const resolvedAt = (status === 'confirmed' || status === 'refuted') ? 'NOW()' : 'NULL';

    await query(
      `UPDATE content_hypotheses SET
        confidence = $1,
        status = $2,
        supporting_post_ids = supporting_post_ids || $3::text[],
        contradicting_post_ids = contradicting_post_ids || $4::text[],
        updated_at = NOW(),
        resolved_at = ${resolvedAt}
       WHERE id = $5`,
      [
        update.new_confidence,
        status,
        update.supporting_post_ids || [],
        update.contradicting_post_ids || [],
        update.id,
      ]
    );

    if (status === 'confirmed') confirmed++;
    else if (status === 'refuted') refuted++;
    else updated++;
  }

  // 7. Insert new hypotheses
  for (const newH of review.new_hypotheses || []) {
    await query(
      `INSERT INTO content_hypotheses (hypothesis, variable, prediction, confidence, supporting_post_ids, source)
       VALUES ($1, $2, $3, $4, $5, 'weekly_review')
       ON CONFLICT DO NOTHING`,
      [
        newH.hypothesis,
        newH.variable,
        newH.prediction,
        newH.confidence,
        newH.evidence_post_ids || [],
      ]
    );
    newCount++;
  }

  // 8. Build summary
  const patterns = (review.patterns_to_investigate || []).join('; ');
  const summary = review.summary || `${confirmed} confirmed, ${refuted} refuted, ${updated} updated, ${newCount} new`;

  console.log(`[Hypothesis] Weekly review complete: ${summary}`);
  return `*Hypothesis Review Complete*\n\n${summary}${patterns ? `\n\nPatterns to investigate: ${patterns}` : ''}\n\nCost: $${result.costCents ? (result.costCents / 100).toFixed(3) : '0.00'}`;
}
