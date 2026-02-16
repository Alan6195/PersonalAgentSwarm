/**
 * X Intelligence Service
 *
 * Provides structured X/Twitter research capabilities:
 * - Multi-query search with relevance scoring
 * - Trend detection and categorization
 * - Engagement opportunity identification
 * - Persistent trend tracking in DB
 * - Formatted intelligence reports for agents
 */

import * as twitter from './twitter';
import { query as dbQuery } from '../db';
import type { TweetV2 } from 'twitter-api-v2';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TweetInsight {
  id: string;
  text: string;
  authorUsername: string;
  authorName: string;
  likes: number;
  retweets: number;
  replies: number;
  impressions: number;
  createdAt: string;
  relevanceScore: number;
  category: 'hot_lead' | 'warm_prospect' | 'peer_builder' | 'content_idea' | 'industry_discussion' | 'competitor_intel';
  reason: string;
}

export interface XIntelligenceReport {
  query: string;
  timestamp: string;
  totalTweetsScanned: number;
  insights: TweetInsight[];
  trendingSummary: string[];
  engagementOpportunities: TweetInsight[];
  contentIdeas: string[];
}

// ---------------------------------------------------------------------------
// Smart search queries by topic
// ---------------------------------------------------------------------------

const RESEARCH_QUERIES: Record<string, string[]> = {
  ai_agents: [
    'AI agents production deployment -is:retweet',
    'autonomous AI agent business -giveaway -is:retweet',
    'building AI agents -tutorial -course -is:retweet lang:en',
    'multi agent system enterprise -is:retweet lang:en',
    'AI agent swarm OR orchestration -is:retweet lang:en',
  ],
  ai_adoption: [
    '"AI adoption" business struggle -is:retweet lang:en',
    '"AI tools" nobody uses OR unused OR failed -is:retweet lang:en',
    'company bought AI OR copilot OR chatgpt nothing -is:retweet lang:en',
    '"AI consultant" OR "AI consulting" hire OR need -is:retweet lang:en',
  ],
  agent_frameworks: [
    'langchain OR crewai OR autogen OR "claude agent" build -is:retweet lang:en',
    '"agent SDK" OR "agent framework" review OR opinion -is:retweet lang:en',
    'MCP server OR "model context protocol" -is:retweet lang:en',
  ],
  ai_business_value: [
    'AI automation ROI OR "cost savings" OR "time saved" -is:retweet lang:en',
    'AI replaced manual process OR workflow -is:retweet lang:en',
    '"AI agent" built for client OR customer -is:retweet lang:en',
  ],
  competitors_and_peers: [
    '(AI agent OR "AI automation") consultant OR agency OR freelance -is:retweet lang:en',
    '"AI solutions" small business OR SMB -is:retweet lang:en',
  ],
};

// Minimum engagement thresholds for relevance
const MIN_ENGAGEMENT = {
  hot_lead: 0,     // Any engagement from someone needing help
  warm_prospect: 2,
  peer_builder: 5,
  content_idea: 10,
  industry_discussion: 3,
  competitor_intel: 2,
};

// ---------------------------------------------------------------------------
// Core intelligence functions
// ---------------------------------------------------------------------------

/**
 * Classify a tweet into a category based on content analysis
 */
function classifyTweet(tweet: TweetV2): {
  category: TweetInsight['category'];
  reason: string;
  relevanceScore: number;
} {
  const text = (tweet.text || '').toLowerCase();
  const metrics = tweet.public_metrics || { like_count: 0, retweet_count: 0, reply_count: 0, impression_count: 0 };
  const totalEngagement = (metrics.like_count || 0) + (metrics.retweet_count || 0) * 2 + (metrics.reply_count || 0) * 1.5;

  // Hot lead detection: someone explicitly looking for AI agent help
  const hotLeadPatterns = [
    /looking for.*(ai agent|ai consultant|ai automation|ai developer)/,
    /need.*(ai agent|ai help|ai solution|someone to build)/,
    /hire.*(ai|agent|automation)/,
    /who (builds|can build|knows).*(ai agent|automation|ai system)/,
    /recommend.*(ai agent|ai consultant|ai automation)/,
    /anyone know.*(ai agent|automation)/,
  ];
  for (const pattern of hotLeadPatterns) {
    if (pattern.test(text)) {
      return {
        category: 'hot_lead',
        reason: 'Explicitly seeking AI agent help or consulting',
        relevanceScore: 95 + Math.min(5, totalEngagement / 10),
      };
    }
  }

  // Warm prospect: discussing a problem agents solve
  const warmPatterns = [
    /ai tools?.*(not working|nobody uses|waste|useless|disappointing)/,
    /copilot.*(not|nobody|waste|unused)/,
    /chatgpt.*(not enough|limited|can't|doesn't)/,
    /manual process.*(automat|replace|streamline)/,
    /too much time.*(manual|repetitive|data entry)/,
    /struggling with.*(ai|automation|workflow)/,
  ];
  for (const pattern of warmPatterns) {
    if (pattern.test(text)) {
      return {
        category: 'warm_prospect',
        reason: 'Describes a problem that AI agents solve',
        relevanceScore: 70 + Math.min(20, totalEngagement / 5),
      };
    }
  }

  // Peer builder: fellow AI agent builders
  const peerPatterns = [
    /(?:i |just |we )(?:built|shipped|launched|deployed).*(agent|swarm|automation|pipeline)/,
    /building.*(multi.?agent|agent system|agent swarm|autonomous)/,
    /my ai agent.*(just|today|this week)/,
    /agent (?:framework|sdk|architecture)/,
  ];
  for (const pattern of peerPatterns) {
    if (pattern.test(text)) {
      return {
        category: 'peer_builder',
        reason: 'Fellow builder sharing agent work',
        relevanceScore: 60 + Math.min(30, totalEngagement / 3),
      };
    }
  }

  // Content idea: high-engagement AI discussion worth riffing on
  if (totalEngagement >= 50 && (
    text.includes('ai agent') || text.includes('automation') ||
    text.includes('ai tools') || text.includes('artificial intelligence')
  )) {
    return {
      category: 'content_idea',
      reason: `High-engagement AI discussion (${Math.round(totalEngagement)} engagement)`,
      relevanceScore: 50 + Math.min(40, totalEngagement / 10),
    };
  }

  // Competitor intel: other AI consultants/agencies
  const competitorPatterns = [
    /(?:we|our|my) (?:ai|agent) (?:consulting|agency|service|company)/,
    /(?:ai|agent) (?:consulting|agency).*(launch|announce|offer)/,
    /(?:fractional|consulting).*(ai|cto|cio)/,
  ];
  for (const pattern of competitorPatterns) {
    if (pattern.test(text)) {
      return {
        category: 'competitor_intel',
        reason: 'Competitor or similar service provider',
        relevanceScore: 40 + Math.min(20, totalEngagement / 5),
      };
    }
  }

  // Industry discussion (default bucket for relevant but uncategorized)
  if (text.includes('ai agent') || text.includes('autonomous') || text.includes('automation')) {
    return {
      category: 'industry_discussion',
      reason: 'General AI/agent industry discussion',
      relevanceScore: 20 + Math.min(30, totalEngagement / 5),
    };
  }

  return {
    category: 'industry_discussion',
    reason: 'Matched search query',
    relevanceScore: 10 + Math.min(20, totalEngagement / 10),
  };
}

/**
 * Run a comprehensive X intelligence scan across multiple topics
 */
export async function runIntelligenceScan(
  topics: string[] = ['ai_agents', 'ai_adoption', 'agent_frameworks'],
  tweetsPerQuery: number = 15
): Promise<XIntelligenceReport> {
  if (!twitter.isConfigured()) {
    return {
      query: topics.join(', '),
      timestamp: new Date().toISOString(),
      totalTweetsScanned: 0,
      insights: [],
      trendingSummary: ['X/Twitter API not configured'],
      engagementOpportunities: [],
      contentIdeas: [],
    };
  }

  const allInsights: TweetInsight[] = [];
  let totalScanned = 0;
  const seenIds = new Set<string>();

  for (const topic of topics) {
    const queries = RESEARCH_QUERIES[topic] || [topic];

    for (const searchQuery of queries) {
      try {
        const tweets = await twitter.searchTweets(searchQuery, tweetsPerQuery);
        totalScanned += tweets.length;

        for (const tweet of tweets) {
          if (seenIds.has(tweet.id)) continue;
          seenIds.add(tweet.id);

          const classification = classifyTweet(tweet);
          const metrics = tweet.public_metrics || { like_count: 0, retweet_count: 0, reply_count: 0, impression_count: 0 };

          // Only include tweets above minimum engagement for their category
          const minEng = MIN_ENGAGEMENT[classification.category] || 0;
          const totalEng = (metrics.like_count || 0) + (metrics.retweet_count || 0) + (metrics.reply_count || 0);
          if (totalEng < minEng && classification.category !== 'hot_lead') continue;

          allInsights.push({
            id: tweet.id,
            text: tweet.text || '',
            authorUsername: (tweet as any).author_username || tweet.author_id || 'unknown',
            authorName: (tweet as any).author_name || '',
            likes: metrics.like_count || 0,
            retweets: metrics.retweet_count || 0,
            replies: metrics.reply_count || 0,
            impressions: metrics.impression_count || 0,
            createdAt: tweet.created_at || '',
            relevanceScore: classification.relevanceScore,
            category: classification.category,
            reason: classification.reason,
          });
        }
      } catch (err) {
        console.warn(`[XIntelligence] Search failed for "${searchQuery}": ${(err as Error).message}`);
      }
    }
  }

  // Sort by relevance score descending
  allInsights.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Extract top engagement opportunities (hot leads + warm prospects)
  const engagementOpps = allInsights.filter(
    i => i.category === 'hot_lead' || i.category === 'warm_prospect'
  ).slice(0, 10);

  // Extract content ideas from high-engagement discussions
  const contentIdeas = allInsights
    .filter(i => i.category === 'content_idea' || i.category === 'peer_builder')
    .slice(0, 5)
    .map(i => {
      const topicHint = i.text.substring(0, 100);
      return `Riff on: "${topicHint}..." (@${i.authorUsername}, ${i.likes} likes)`;
    });

  // Generate trending summary
  const trendingSummary = generateTrendingSummary(allInsights);

  return {
    query: topics.join(', '),
    timestamp: new Date().toISOString(),
    totalTweetsScanned: totalScanned,
    insights: allInsights.slice(0, 30), // Top 30 most relevant
    trendingSummary,
    engagementOpportunities: engagementOpps,
    contentIdeas,
  };
}

/**
 * Generate a human-readable trending summary from insights
 */
function generateTrendingSummary(insights: TweetInsight[]): string[] {
  const summary: string[] = [];
  const categoryCounts: Record<string, number> = {};
  const topThemes: Record<string, number> = {};

  for (const insight of insights) {
    categoryCounts[insight.category] = (categoryCounts[insight.category] || 0) + 1;

    // Extract themes from text
    const text = insight.text.toLowerCase();
    const themes = [
      ['multi-agent', /multi.?agent/],
      ['MCP/tool use', /mcp|model context protocol|tool use|tool calling/],
      ['Claude/Anthropic', /claude|anthropic/],
      ['OpenAI/GPT', /openai|gpt|chatgpt/],
      ['LangChain', /langchain|langgraph/],
      ['CrewAI', /crewai/],
      ['RAG', /\brag\b|retrieval.augmented/],
      ['automation ROI', /roi|cost.saving|time.saved/],
      ['AI consulting', /consult|advisory|fractional/],
      ['enterprise AI', /enterprise|b2b|business/],
      ['coding agents', /coding.agent|code.agent|devin|cursor/],
      ['AI skepticism', /hype|overhyped|bubble|skeptic/],
    ] as [string, RegExp][];

    for (const [name, pattern] of themes) {
      if (pattern.test(text)) {
        topThemes[name] = (topThemes[name] || 0) + 1;
      }
    }
  }

  // Category breakdown
  const hotLeads = categoryCounts['hot_lead'] || 0;
  const warmProspects = categoryCounts['warm_prospect'] || 0;
  const peers = categoryCounts['peer_builder'] || 0;

  if (hotLeads > 0) {
    summary.push(`${hotLeads} hot lead${hotLeads > 1 ? 's' : ''} found (people actively seeking AI agent help)`);
  }
  if (warmProspects > 0) {
    summary.push(`${warmProspects} warm prospect${warmProspects > 1 ? 's' : ''} (discussing problems agents solve)`);
  }
  if (peers > 0) {
    summary.push(`${peers} peer builder${peers > 1 ? 's' : ''} sharing agent work`);
  }

  // Top trending themes
  const sortedThemes = Object.entries(topThemes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  if (sortedThemes.length > 0) {
    const themeStr = sortedThemes.map(([name, count]) => `${name} (${count})`).join(', ');
    summary.push(`Trending themes: ${themeStr}`);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Trend persistence (DB)
// ---------------------------------------------------------------------------

/**
 * Store a trend snapshot in the database for historical tracking
 */
export async function storeTrendSnapshot(report: XIntelligenceReport): Promise<void> {
  try {
    // Ensure table exists (idempotent)
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS x_trend_snapshots (
        id SERIAL PRIMARY KEY,
        scan_date DATE DEFAULT CURRENT_DATE,
        total_scanned INTEGER,
        hot_leads INTEGER DEFAULT 0,
        warm_prospects INTEGER DEFAULT 0,
        peer_builders INTEGER DEFAULT 0,
        content_ideas INTEGER DEFAULT 0,
        top_themes JSONB DEFAULT '[]',
        top_insights JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const categoryCounts: Record<string, number> = {};
    for (const i of report.insights) {
      categoryCounts[i.category] = (categoryCounts[i.category] || 0) + 1;
    }

    // Extract top themes
    const themeMap: Record<string, number> = {};
    for (const i of report.insights) {
      const text = i.text.toLowerCase();
      const themes = ['multi-agent', 'MCP', 'Claude', 'OpenAI', 'LangChain', 'CrewAI', 'RAG', 'automation', 'consulting'];
      for (const t of themes) {
        if (text.includes(t.toLowerCase())) {
          themeMap[t] = (themeMap[t] || 0) + 1;
        }
      }
    }
    const topThemes = Object.entries(themeMap).sort(([, a], [, b]) => b - a).slice(0, 10);

    // Store top 5 insights for reference
    const topInsights = report.insights.slice(0, 5).map(i => ({
      id: i.id,
      author: i.authorUsername,
      text: i.text.substring(0, 200),
      category: i.category,
      score: i.relevanceScore,
      likes: i.likes,
    }));

    await dbQuery(
      `INSERT INTO x_trend_snapshots (total_scanned, hot_leads, warm_prospects, peer_builders, content_ideas, top_themes, top_insights)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        report.totalTweetsScanned,
        categoryCounts['hot_lead'] || 0,
        categoryCounts['warm_prospect'] || 0,
        categoryCounts['peer_builder'] || 0,
        categoryCounts['content_idea'] || 0,
        JSON.stringify(topThemes),
        JSON.stringify(topInsights),
      ]
    );

    console.log('[XIntelligence] Stored trend snapshot');
  } catch (err) {
    console.warn('[XIntelligence] Failed to store trend snapshot:', (err as Error).message);
  }
}

/**
 * Get recent trend history for context
 */
export async function getRecentTrends(days: number = 7): Promise<any[]> {
  try {
    const rows = await dbQuery(
      `SELECT * FROM x_trend_snapshots
       WHERE created_at > NOW() - INTERVAL '${days} days'
       ORDER BY created_at DESC LIMIT 14`,
    );
    return rows as any[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Formatted output for agents
// ---------------------------------------------------------------------------

/**
 * Format intelligence report for the social-media agent
 */
export function formatForSocialMedia(report: XIntelligenceReport): string {
  const lines: string[] = [];

  lines.push(`## X INTELLIGENCE SCAN`);
  lines.push(`Scanned ${report.totalTweetsScanned} tweets across ${report.query}`);
  lines.push('');

  // Trending summary
  if (report.trendingSummary.length > 0) {
    lines.push('### Trends');
    for (const s of report.trendingSummary) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  // Hot leads first (these are gold)
  const hotLeads = report.insights.filter(i => i.category === 'hot_lead');
  if (hotLeads.length > 0) {
    lines.push('### HOT LEADS (people actively seeking AI agent help)');
    for (const lead of hotLeads.slice(0, 5)) {
      lines.push(`  @${lead.authorUsername} (${lead.likes} likes, ${lead.retweets} RTs)`);
      lines.push(`  "${lead.text.substring(0, 200)}"`);
      lines.push(`  Tweet ID: ${lead.id} | Why: ${lead.reason}`);
      lines.push('');
    }
  }

  // Warm prospects
  const warm = report.insights.filter(i => i.category === 'warm_prospect');
  if (warm.length > 0) {
    lines.push('### WARM PROSPECTS (discussing problems agents solve)');
    for (const w of warm.slice(0, 5)) {
      lines.push(`  @${w.authorUsername}: "${w.text.substring(0, 160)}..." (${w.likes} likes)`);
      lines.push(`  Tweet ID: ${w.id}`);
      lines.push('');
    }
  }

  // Peer builders
  const peers = report.insights.filter(i => i.category === 'peer_builder');
  if (peers.length > 0) {
    lines.push('### PEER BUILDERS (engage authentically)');
    for (const p of peers.slice(0, 5)) {
      lines.push(`  @${p.authorUsername}: "${p.text.substring(0, 160)}..." (${p.likes} likes, ${p.retweets} RTs)`);
      lines.push(`  Tweet ID: ${p.id}`);
      lines.push('');
    }
  }

  // Content ideas
  if (report.contentIdeas.length > 0) {
    lines.push('### CONTENT IDEAS');
    for (const idea of report.contentIdeas) {
      lines.push(`  - ${idea}`);
    }
    lines.push('');
  }

  // High-engagement industry discussions
  const discussions = report.insights.filter(i => i.category === 'content_idea');
  if (discussions.length > 0) {
    lines.push('### HIGH-ENGAGEMENT DISCUSSIONS (potential quote-tweet material)');
    for (const d of discussions.slice(0, 3)) {
      lines.push(`  @${d.authorUsername}: "${d.text.substring(0, 160)}..." (${d.likes} likes, ${d.retweets} RTs)`);
      lines.push(`  Tweet ID: ${d.id}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format intelligence report for the research-analyst agent
 */
export function formatForResearch(report: XIntelligenceReport): string {
  const lines: string[] = [];

  lines.push(`## X/TWITTER INTELLIGENCE REPORT`);
  lines.push(`Scan time: ${new Date(report.timestamp).toLocaleString()}`);
  lines.push(`Total tweets analyzed: ${report.totalTweetsScanned}`);
  lines.push(`Relevant insights found: ${report.insights.length}`);
  lines.push('');

  // Category breakdown
  const cats: Record<string, number> = {};
  for (const i of report.insights) {
    cats[i.category] = (cats[i.category] || 0) + 1;
  }
  lines.push('### Category Breakdown');
  for (const [cat, count] of Object.entries(cats).sort(([, a], [, b]) => b - a)) {
    lines.push(`- ${cat.replace(/_/g, ' ')}: ${count} tweets`);
  }
  lines.push('');

  // Trends
  if (report.trendingSummary.length > 0) {
    lines.push('### Key Trends');
    for (const s of report.trendingSummary) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  // Top tweets by relevance
  lines.push('### Top Tweets by Relevance');
  for (const insight of report.insights.slice(0, 15)) {
    lines.push(`${insight.relevanceScore.toFixed(0)}pts | @${insight.authorUsername} [${insight.category}]`);
    lines.push(`  "${insight.text.substring(0, 200)}"`);
    lines.push(`  ${insight.likes} likes, ${insight.retweets} RTs, ${insight.replies} replies`);
    lines.push(`  Reason: ${insight.reason}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a targeted search result (for [ACTION:SEARCH] with better output)
 */
export function formatSearchResults(tweets: TweetV2[], searchQuery: string): string {
  const lines: string[] = [];
  lines.push(`## Search Results: "${searchQuery}"`);
  lines.push(`Found ${tweets.length} tweets\n`);

  for (let i = 0; i < tweets.length; i++) {
    const t = tweets[i];
    const classification = classifyTweet(t);
    const metrics = t.public_metrics || { like_count: 0, retweet_count: 0, reply_count: 0, impression_count: 0 };
    const username = (t as any).author_username || t.author_id || 'unknown';

    lines.push(`${i + 1}. @${username} [${classification.category.replace(/_/g, ' ')}] (score: ${classification.relevanceScore.toFixed(0)})`);
    lines.push(`   "${t.text?.substring(0, 200) || ''}"`);
    lines.push(`   ${metrics.like_count} likes, ${metrics.retweet_count} RTs, ${metrics.reply_count} replies`);
    if (classification.reason !== 'Matched search query') {
      lines.push(`   Why: ${classification.reason}`);
    }
    lines.push(`   Tweet ID: ${t.id}`);
    lines.push('');
  }

  return lines.join('\n');
}
