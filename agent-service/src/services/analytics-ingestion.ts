/**
 * Analytics Ingestion Service
 *
 * Handles post-publish recording, scheduled metric snapshots,
 * and rolling performance aggregation for the X agent analytics engine.
 *
 * Three main exports:
 *   - recordPost(): called after every tweet/thread publish
 *   - processDueSnapshots(): called by hourly cron job
 *   - recomputeContentPerformance(): called by daily cron job
 */

import { query, queryOne } from '../db';
import * as twitter from './twitter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordPostParams {
  tweetId: string;
  threadId?: string;
  content: string;
  contentType: 'tweet' | 'thread' | 'tweet_with_image' | 'tweet_with_video' | 'reply';
  hasMedia?: boolean;
  mediaType?: string;
  taskId?: number;
  cronJobName?: string;
}

// ---------------------------------------------------------------------------
// Content Classification (heuristic, zero LLM cost)
// ---------------------------------------------------------------------------

const BUCKET_PATTERNS: Record<string, RegExp> = {
  builders_log: /\b(built|building|shipped|deployed|launched|working on|prototype|demo|release|refactor|debug|code|commit|pull request|PR|feature|integration|api|stack)\b/i,
  industry_takes: /\b(think(s|ing)?|opinion|hot take|unpopular|controversial|overrated|underrated|future of|prediction|bet|wrong about|right about|landscape|market|industry)\b/i,
  business_value: /\b(revenue|growth|ROI|conversion|pipeline|customers?|clients?|sales|business|enterprise|adoption|case study|results|metrics|KPI|profit|cost)\b/i,
  direct_cta: /\b(check out|try|sign up|subscribe|join|register|download|link in bio|DM me|reach out|comment|share|retweet|follow|book a|schedule)\b/i,
  engagement: /\b(what do you think|agree\??|thoughts\??|who else|anyone|poll|thread|let me know|drop|tell me|curious|question|unpopular opinion)\b/i,
};

const HOOK_PATTERNS: Record<string, (text: string) => boolean> = {
  question: (t) => /^[^.!]{5,}\?/.test(t.split('\n')[0]),
  stat: (t) => /\b\d+[%x]|\b\d{2,}[+ ]/i.test(t.split('\n')[0]),
  story: (t) => /^(I |We |My |Last |Yesterday|This morning|Today|A few)/i.test(t.split('\n')[0]),
  contrarian: (t) => /\b(stop|don't|won't|isn't|aren't|nobody|unpopular|controversial|hot take|wrong)\b/i.test(t.split('\n')[0]),
  how_to: (t) => /^(How to|Here's how|Step|The way to|Guide|Tutorial)/i.test(t.split('\n')[0]),
  listicle: (t) => /^(\d+\s+(things?|ways?|tips?|reasons?|lessons?|mistakes?)|\d+\.)/i.test(t.split('\n')[0]),
  observation: () => true, // fallback
};

const TOPIC_KEYWORDS: Record<string, RegExp> = {
  ai_agents: /\b(agent(s|ic)?|swarm|autonomous|multi-agent|agentic|crew|orchestrat)\b/i,
  mcp_tools: /\b(MCP|model context protocol|tool use|function call|tool calling)\b/i,
  anthropic: /\b(anthropic|claude|sonnet|opus|haiku)\b/i,
  ai_adoption: /\b(adopt(ion|ing)?|implement(ing|ation)?|enterprise AI|AI strategy|AI transformation)\b/i,
  ai_business: /\b(AI ROI|AI business|productivity|automation|efficiency|cost saving|AI tool)\b/i,
  open_source: /\b(open source|OSS|github|repo|framework|library|SDK)\b/i,
  personal_brand: /\b(personal brand|content|audience|growth|engagement|followers|newsletter)\b/i,
};

function classifyBucket(content: string): string | null {
  for (const [bucket, pattern] of Object.entries(BUCKET_PATTERNS)) {
    if (pattern.test(content)) return bucket;
  }
  return null;
}

function classifyHook(content: string): string {
  for (const [hook, checker] of Object.entries(HOOK_PATTERNS)) {
    if (hook === 'observation') continue; // skip fallback
    if (checker(content)) return hook;
  }
  return 'observation';
}

function classifyTopic(content: string): string | null {
  for (const [topic, pattern] of Object.entries(TOPIC_KEYWORDS)) {
    if (pattern.test(content)) return topic;
  }
  return null;
}

function detectLink(content: string): boolean {
  return /https?:\/\/\S+/.test(content);
}

function detectCta(content: string): boolean {
  return BUCKET_PATTERNS.direct_cta.test(content);
}

/**
 * Get current Mountain Time hour (0-23) and day of week (0=Sunday)
 */
function getMountainTime(): { hour: number; day: number } {
  const now = new Date();
  const mt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Denver' }));
  return { hour: mt.getHours(), day: mt.getDay() };
}

// ---------------------------------------------------------------------------
// Snapshot intervals
// ---------------------------------------------------------------------------

const SNAPSHOT_INTERVALS = [
  { label: '1h', offsetMs: 1 * 60 * 60 * 1000 },
  { label: '4h', offsetMs: 4 * 60 * 60 * 1000 },
  { label: '24h', offsetMs: 24 * 60 * 60 * 1000 },
  { label: '3d', offsetMs: 3 * 24 * 60 * 60 * 1000 },
  { label: '7d', offsetMs: 7 * 24 * 60 * 60 * 1000 },
];

// ---------------------------------------------------------------------------
// recordPost: called after every successful publish
// ---------------------------------------------------------------------------

export async function recordPost(params: RecordPostParams): Promise<number> {
  const { tweetId, threadId, content, contentType, hasMedia, mediaType, taskId, cronJobName } = params;

  // Classify content
  const bucket = classifyBucket(content);
  const hook = classifyHook(content);
  const topic = classifyTopic(content);
  const { hour, day } = getMountainTime();

  // INSERT into post_analytics
  const row = await queryOne<{ id: number }>(
    `INSERT INTO post_analytics (
      tweet_id, thread_id, content, content_type, content_bucket,
      hook_pattern, topic, has_media, media_type, has_link, has_cta,
      char_count, posted_hour, posted_day, task_id, cron_job_name
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (tweet_id) DO NOTHING
    RETURNING id`,
    [
      tweetId, threadId || null, content, contentType, bucket,
      hook, topic, hasMedia || false, mediaType || null,
      detectLink(content), detectCta(content),
      content.length, hour, day, taskId || null, cronJobName || null,
    ]
  );

  if (!row) {
    console.log(`[Analytics] Post ${tweetId} already recorded, skipping`);
    return 0;
  }

  const postId = row.id;
  console.log(`[Analytics] Recorded post ${tweetId} (id=${postId}, type=${contentType}, bucket=${bucket}, hook=${hook}, topic=${topic})`);

  // Schedule 5 metric snapshots
  const now = Date.now();
  for (const interval of SNAPSHOT_INTERVALS) {
    const dueAt = new Date(now + interval.offsetMs);
    await query(
      `INSERT INTO scheduled_snapshots (post_analytics_id, tweet_id, interval_label, due_at)
       VALUES ($1, $2, $3, $4)`,
      [postId, tweetId, interval.label, dueAt]
    );
  }

  console.log(`[Analytics] Scheduled 5 snapshots for post ${tweetId}`);
  return postId;
}

// ---------------------------------------------------------------------------
// processDueSnapshots: called by hourly cron job
// ---------------------------------------------------------------------------

export async function processDueSnapshots(): Promise<{ processed: number; failed: number }> {
  // Find all pending snapshots that are due
  const dueSnapshots = await query<{
    id: number;
    post_analytics_id: number;
    tweet_id: string;
    interval_label: string;
    attempts: number;
  }>(
    `SELECT id, post_analytics_id, tweet_id, interval_label, attempts
     FROM scheduled_snapshots
     WHERE status = 'pending' AND due_at <= NOW()
     ORDER BY due_at ASC
     LIMIT 200`
  );

  if (dueSnapshots.length === 0) {
    console.log('[Analytics] No due snapshots to process');
    return { processed: 0, failed: 0 };
  }

  console.log(`[Analytics] Processing ${dueSnapshots.length} due snapshots`);

  // Batch fetch metrics (deduplicate tweet IDs)
  const uniqueTweetIds = [...new Set(dueSnapshots.map(s => s.tweet_id))];
  let metricsMap = new Map<string, twitter.TweetMetrics>();

  try {
    const metrics = await twitter.getTweetMetrics(uniqueTweetIds);
    for (const m of metrics) {
      metricsMap.set(m.id, m);
    }
    console.log(`[Analytics] Fetched metrics for ${metrics.length}/${uniqueTweetIds.length} tweets`);
  } catch (err) {
    console.error(`[Analytics] Batch metric fetch failed: ${(err as Error).message}`);
    // Mark all as failed attempt
    for (const snap of dueSnapshots) {
      await query(
        `UPDATE scheduled_snapshots SET attempts = attempts + 1, error_message = $1,
         status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
         completed_at = CASE WHEN attempts + 1 >= 3 THEN NOW() ELSE NULL END
         WHERE id = $2`,
        [(err as Error).message.substring(0, 500), snap.id]
      );
    }
    return { processed: 0, failed: dueSnapshots.length };
  }

  let processed = 0;
  let failed = 0;

  for (const snap of dueSnapshots) {
    const metrics = metricsMap.get(snap.tweet_id);

    if (!metrics) {
      // Tweet might have been deleted or not found
      const newAttempts = snap.attempts + 1;
      if (newAttempts >= 3) {
        await query(
          `UPDATE scheduled_snapshots SET status = 'failed', attempts = $1, error_message = 'Tweet not found in API response', completed_at = NOW() WHERE id = $2`,
          [newAttempts, snap.id]
        );
        failed++;
      } else {
        await query(
          `UPDATE scheduled_snapshots SET attempts = $1, error_message = 'Tweet not found, will retry' WHERE id = $2`,
          [newAttempts, snap.id]
        );
        failed++;
      }
      continue;
    }

    // Calculate engagement rate
    const totalEngagement = metrics.likes + metrics.retweets + metrics.replies + metrics.bookmarks;
    const engagementRate = metrics.impressions > 0
      ? totalEngagement / metrics.impressions
      : 0;

    // INSERT snapshot
    await query(
      `INSERT INTO post_snapshots (
        post_analytics_id, tweet_id, interval_label,
        likes, retweets, replies, impressions, bookmarks, quote_tweets,
        engagement_rate
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        snap.post_analytics_id, snap.tweet_id, snap.interval_label,
        metrics.likes, metrics.retweets, metrics.replies,
        metrics.impressions, metrics.bookmarks, metrics.quote_tweets,
        engagementRate,
      ]
    );

    // Mark scheduled snapshot as completed
    await query(
      `UPDATE scheduled_snapshots SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [snap.id]
    );

    processed++;
  }

  console.log(`[Analytics] Snapshot processing complete: ${processed} processed, ${failed} failed`);
  return { processed, failed };
}

// ---------------------------------------------------------------------------
// recomputeContentPerformance: called by daily cron job
// ---------------------------------------------------------------------------

const DIMENSIONS = ['content_type', 'content_bucket', 'hook_pattern', 'topic', 'posted_hour', 'posted_day'];
const PERIODS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export async function recomputeContentPerformance(): Promise<{ dimensions: number }> {
  let totalUpserted = 0;

  for (const period of PERIODS) {
    const cutoff = new Date(Date.now() - period.days * 24 * 60 * 60 * 1000);

    for (const dimension of DIMENSIONS) {
      // Use the 24h snapshot as the canonical metric for each post
      // Falls back to latest available snapshot if 24h not available
      const rows = await query<{
        dimension_value: string;
        post_count: number;
        avg_likes: number;
        avg_retweets: number;
        avg_replies: number;
        avg_impressions: number;
        avg_engagement_rate: number;
        best_tweet_id: string;
        best_engagement_rate: number;
        worst_tweet_id: string;
        worst_engagement_rate: number;
      }>(`
        WITH canonical_metrics AS (
          SELECT DISTINCT ON (pa.id)
            pa.id as post_id,
            pa.tweet_id,
            pa.${dimension} as dim_value,
            ps.likes, ps.retweets, ps.replies,
            ps.impressions, ps.bookmarks, ps.engagement_rate
          FROM post_analytics pa
          JOIN post_snapshots ps ON ps.post_analytics_id = pa.id
          WHERE pa.created_at >= $1
            AND pa.${dimension} IS NOT NULL
          ORDER BY pa.id,
            CASE ps.interval_label
              WHEN '24h' THEN 1
              WHEN '7d' THEN 2
              WHEN '3d' THEN 3
              WHEN '4h' THEN 4
              WHEN '1h' THEN 5
            END
        ),
        best_worst AS (
          SELECT dim_value,
            (ARRAY_AGG(tweet_id ORDER BY engagement_rate DESC NULLS LAST))[1] as best_tweet_id,
            MAX(engagement_rate) as best_engagement_rate,
            (ARRAY_AGG(tweet_id ORDER BY engagement_rate ASC NULLS LAST))[1] as worst_tweet_id,
            MIN(engagement_rate) as worst_engagement_rate
          FROM canonical_metrics
          GROUP BY dim_value
        )
        SELECT
          cm.dim_value as dimension_value,
          COUNT(*)::integer as post_count,
          AVG(cm.likes) as avg_likes,
          AVG(cm.retweets) as avg_retweets,
          AVG(cm.replies) as avg_replies,
          AVG(cm.impressions) as avg_impressions,
          AVG(cm.engagement_rate) as avg_engagement_rate,
          bw.best_tweet_id,
          bw.best_engagement_rate,
          bw.worst_tweet_id,
          bw.worst_engagement_rate
        FROM canonical_metrics cm
        JOIN best_worst bw ON bw.dim_value = cm.dim_value
        GROUP BY cm.dim_value, bw.best_tweet_id, bw.best_engagement_rate, bw.worst_tweet_id, bw.worst_engagement_rate
        HAVING COUNT(*) >= 2
      `, [cutoff]);

      for (const row of rows) {
        await query(
          `INSERT INTO content_performance (
            dimension, dimension_value, period, post_count,
            avg_likes, avg_retweets, avg_replies, avg_impressions, avg_engagement_rate,
            best_tweet_id, best_engagement_rate, worst_tweet_id, worst_engagement_rate,
            computed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
          ON CONFLICT (dimension, dimension_value, period) DO UPDATE SET
            post_count = EXCLUDED.post_count,
            avg_likes = EXCLUDED.avg_likes,
            avg_retweets = EXCLUDED.avg_retweets,
            avg_replies = EXCLUDED.avg_replies,
            avg_impressions = EXCLUDED.avg_impressions,
            avg_engagement_rate = EXCLUDED.avg_engagement_rate,
            best_tweet_id = EXCLUDED.best_tweet_id,
            best_engagement_rate = EXCLUDED.best_engagement_rate,
            worst_tweet_id = EXCLUDED.worst_tweet_id,
            worst_engagement_rate = EXCLUDED.worst_engagement_rate,
            computed_at = NOW()`,
          [
            dimension, row.dimension_value, period.label, row.post_count,
            row.avg_likes, row.avg_retweets, row.avg_replies,
            row.avg_impressions, row.avg_engagement_rate,
            row.best_tweet_id, row.best_engagement_rate,
            row.worst_tweet_id, row.worst_engagement_rate,
          ]
        );
        totalUpserted++;
      }
    }
  }

  console.log(`[Analytics] Content performance recomputed: ${totalUpserted} dimension-period combos updated`);
  return { dimensions: totalUpserted };
}
