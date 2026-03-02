/**
 * Analytics Context Service
 *
 * Builds a markdown performance brief for injection into the social-media agent prompt.
 * Shows what content types, hooks, topics, and posting times perform best/worst.
 *
 * Graceful: returns empty string if fewer than 5 posts tracked.
 */

import { query } from '../db';

// Cache the brief for 6 hours (rebuilt by daily cron, but also on-demand)
let cachedBrief: string = '';
let cacheExpiry: number = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Build the performance brief markdown section.
 * Called by executor.ts before every social-media agent run.
 * Also called by the daily "Performance Brief" cron to warm the cache.
 */
export async function buildPerformanceBrief(): Promise<string> {
  // Return cached version if still valid
  if (cachedBrief && Date.now() < cacheExpiry) {
    return cachedBrief;
  }

  try {
    // Check minimum post count
    const [countRow] = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM post_analytics`
    );
    const totalPosts = parseInt(countRow?.total || '0', 10);

    if (totalPosts < 5) {
      return '';
    }

    // Check if we have enough snapshots to be meaningful
    const [snapCount] = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM post_snapshots`
    );
    const totalSnaps = parseInt(snapCount?.total || '0', 10);

    if (totalSnaps < 3) {
      return '';
    }

    const sections: string[] = [];

    // Overall stats (30d)
    const [overall] = await query<{
      post_count: string;
      avg_eng: string;
      avg_imp: string;
    }>(`
      SELECT
        COUNT(DISTINCT pa.id) as post_count,
        AVG(ps.engagement_rate) as avg_eng,
        AVG(ps.impressions) as avg_imp
      FROM post_analytics pa
      JOIN post_snapshots ps ON ps.post_analytics_id = pa.id AND ps.interval_label = '24h'
      WHERE pa.created_at >= NOW() - INTERVAL '30 days'
    `);

    const postCount = parseInt(overall?.post_count || '0', 10);
    const avgEng = parseFloat(overall?.avg_eng || '0');
    const avgImp = parseFloat(overall?.avg_imp || '0');

    if (postCount === 0) {
      return '';
    }

    sections.push(`## PERFORMANCE BRIEF (last 30 days)\n\n### Overall: ${postCount} posts | ${(avgEng * 100).toFixed(1)}% avg engagement | ${Math.round(avgImp).toLocaleString()} avg impressions`);

    // What's Working section
    const workingInsights: string[] = [];

    // Best content buckets
    const buckets = await query<{
      dimension_value: string;
      avg_engagement_rate: string;
      post_count: string;
    }>(`
      SELECT dimension_value, avg_engagement_rate, post_count
      FROM content_performance
      WHERE dimension = 'content_bucket' AND period = '30d' AND post_count >= 2
      ORDER BY avg_engagement_rate DESC
      LIMIT 5
    `);

    if (buckets.length >= 2) {
      const best = buckets[0];
      const worst = buckets[buckets.length - 1];
      workingInsights.push(
        `- ${best.dimension_value} (${(parseFloat(best.avg_engagement_rate) * 100).toFixed(1)}% eng, ${best.post_count} posts) outperforms ${worst.dimension_value} (${(parseFloat(worst.avg_engagement_rate) * 100).toFixed(1)}%)`
      );
    }

    // Best hook patterns
    const hooks = await query<{
      dimension_value: string;
      avg_engagement_rate: string;
      post_count: string;
    }>(`
      SELECT dimension_value, avg_engagement_rate, post_count
      FROM content_performance
      WHERE dimension = 'hook_pattern' AND period = '30d' AND post_count >= 2
      ORDER BY avg_engagement_rate DESC
      LIMIT 5
    `);

    if (hooks.length >= 2) {
      const topHooks = hooks.slice(0, 2).map(h =>
        `${h.dimension_value} (${(parseFloat(h.avg_engagement_rate) * 100).toFixed(1)}%)`
      ).join(' and ');
      const worstHook = hooks[hooks.length - 1];
      workingInsights.push(
        `- ${topHooks} hooks beat ${worstHook.dimension_value} (${(parseFloat(worstHook.avg_engagement_rate) * 100).toFixed(1)}%)`
      );
    }

    // Best posting hours
    const hours = await query<{
      dimension_value: string;
      avg_engagement_rate: string;
      post_count: string;
    }>(`
      SELECT dimension_value, avg_engagement_rate, post_count
      FROM content_performance
      WHERE dimension = 'posted_hour' AND period = '30d' AND post_count >= 2
      ORDER BY avg_engagement_rate DESC
      LIMIT 3
    `);

    // Best posting days
    const days = await query<{
      dimension_value: string;
      avg_engagement_rate: string;
      post_count: string;
    }>(`
      SELECT dimension_value, avg_engagement_rate, post_count
      FROM content_performance
      WHERE dimension = 'posted_day' AND period = '30d' AND post_count >= 2
      ORDER BY avg_engagement_rate DESC
      LIMIT 3
    `);

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    if (hours.length > 0 || days.length > 0) {
      const hourStr = hours.length > 0
        ? hours.map(h => `${h.dimension_value}:00`).join(', ')
        : '';
      const dayStr = days.length > 0
        ? days.map(d => dayNames[parseInt(d.dimension_value)] || d.dimension_value).join('/')
        : '';

      const parts = [];
      if (hourStr) parts.push(hourStr + ' Mountain');
      if (dayStr) parts.push(dayStr);
      if (parts.length > 0) {
        workingInsights.push(`- Best posting: ${parts.join(', ')}`);
      }
    }

    // Best content types
    const types = await query<{
      dimension_value: string;
      avg_engagement_rate: string;
      post_count: string;
    }>(`
      SELECT dimension_value, avg_engagement_rate, post_count
      FROM content_performance
      WHERE dimension = 'content_type' AND period = '30d' AND post_count >= 2
      ORDER BY avg_engagement_rate DESC
    `);

    if (types.length >= 2) {
      const best = types[0];
      workingInsights.push(
        `- ${best.dimension_value} format (${(parseFloat(best.avg_engagement_rate) * 100).toFixed(1)}% eng) performs best`
      );
    }

    if (workingInsights.length > 0) {
      sections.push(`### What's Working\n${workingInsights.join('\n')}`);
    }

    // Top 3 Posts
    const topPosts = await query<{
      tweet_id: string;
      content: string;
      engagement_rate: string;
      likes: string;
    }>(`
      SELECT pa.tweet_id, pa.content, ps.engagement_rate, ps.likes
      FROM post_analytics pa
      JOIN post_snapshots ps ON ps.post_analytics_id = pa.id AND ps.interval_label = '24h'
      WHERE pa.created_at >= NOW() - INTERVAL '30 days'
      ORDER BY ps.engagement_rate DESC NULLS LAST
      LIMIT 3
    `);

    if (topPosts.length > 0) {
      const topLines = topPosts.map((p, i) => {
        const snippet = p.content.substring(0, 60).replace(/\n/g, ' ');
        return `${i + 1}. "${snippet}..." (${(parseFloat(p.engagement_rate) * 100).toFixed(1)}% eng, ${p.likes} likes)`;
      });
      sections.push(`### Top ${topPosts.length} Posts\n${topLines.join('\n')}`);
    }

    // Bottom 3 Posts
    const bottomPosts = await query<{
      tweet_id: string;
      content: string;
      engagement_rate: string;
      likes: string;
    }>(`
      SELECT pa.tweet_id, pa.content, ps.engagement_rate, ps.likes
      FROM post_analytics pa
      JOIN post_snapshots ps ON ps.post_analytics_id = pa.id AND ps.interval_label = '24h'
      WHERE pa.created_at >= NOW() - INTERVAL '30 days'
        AND ps.impressions > 0
      ORDER BY ps.engagement_rate ASC NULLS LAST
      LIMIT 3
    `);

    if (bottomPosts.length > 0) {
      const bottomLines = bottomPosts.map((p, i) => {
        const snippet = p.content.substring(0, 60).replace(/\n/g, ' ');
        return `${i + 1}. "${snippet}..." (${(parseFloat(p.engagement_rate) * 100).toFixed(1)}% eng, ${p.likes} likes)`;
      });
      sections.push(`### Bottom ${bottomPosts.length} Posts (avoid these patterns)\n${bottomLines.join('\n')}`);
    }

    sections.push(`USE THIS DATA. Double down on what works. Avoid patterns from bottom posts.`);

    const brief = sections.join('\n\n');

    // Cache the result
    cachedBrief = brief;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    return brief;
  } catch (err) {
    console.error('[Analytics] Failed to build performance brief:', (err as Error).message);
    return '';
  }
}

/**
 * Warm the cache (called by daily cron job).
 * Returns the brief length for logging.
 */
export async function warmBriefCache(): Promise<{ length: number }> {
  // Invalidate cache first
  cachedBrief = '';
  cacheExpiry = 0;

  const brief = await buildPerformanceBrief();
  console.log(`[Analytics] Performance brief cached (${brief.length} chars)`);
  return { length: brief.length };
}
