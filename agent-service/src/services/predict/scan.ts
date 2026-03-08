/**
 * Predict Agent: Market Scanner
 *
 * Phase 1: Manifold Markets only. Public API for reads, key required for bets.
 * Fetches candidate markets, filters by quality, sends to Claude for probability
 * estimation, then ranks by reward score.
 *
 * Claude is the ONLY non-deterministic element. All math runs in model.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { query, queryOne } from '../../db';
import { kellyFraction, fractionalKelly, betSize, hedgeProfit, isHedgeable, rewardScore, simpleExpectedReturn } from './model';
import { getConfirmedHypotheses } from './learn';
import { buildPerformanceBrief } from './context';
import { logCostEvent } from '../cost-tracker';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface MarketCandidate {
  id: string;
  platform: 'manifold' | 'polymarket';
  question: string;
  category: string;
  asset?: string;
  url: string;
  pYes: number;
  volume: number;
  liquidity: number;
  numTraders: number;
  closeDate: Date;
  daysToResolution: number;
}

export interface AnalyzedMarket extends MarketCandidate {
  pModel: number;
  confidence: number;
  reasoning: string;
  intelAligned: boolean;
  edge: number;
  absEdge: number;
  kellyFrac: number;
  betAmount: number;
  expectedRet: number;
  score: number;
  intelSignalId: number | null;
}

// ── Manifold API ─────────────────────────────────────────────────────

const MANIFOLD_BASE = 'https://api.manifold.markets/v0';

const SEARCH_TERMS = [
  'bitcoin price',
  'ethereum price',
  'BTC',
  'ETH',
  'solana price',
  'XRP price',
  'crypto',
  'OpenAI',
  'AI model release',
  'fed rate',
  'inflation rate',
];

/**
 * Fetch candidate markets from Manifold using keyword-scoped searches.
 * Only returns crypto, AI/tech, and economics markets resolving within 7 days.
 */
export async function scanManifold(): Promise<MarketCandidate[]> {
  console.log(`[Scan] Fetching Manifold markets (${SEARCH_TERMS.length} keyword searches, <=7 days, prob 0.15-0.85, >=20 bettors)`);

  // Parallel keyword-scoped searches
  const results = await Promise.all(
    SEARCH_TERMS.map(term =>
      fetch(`${MANIFOLD_BASE}/search-markets?term=${encodeURIComponent(term)}&sort=score&limit=50`)
        .then(r => r.ok ? r.json() as Promise<any[]> : [])
        .catch(() => [] as any[])
    )
  );

  // Deduplicate
  const all = results.flat();
  const seen = new Set<string>();
  const unique = all.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  console.log(`[Scan] Fetched ${all.length} raw results, ${unique.length} unique after dedup`);

  // Hard filters
  const now = Date.now();
  const candidates: MarketCandidate[] = [];

  for (const m of unique) {
    if (m.isResolved !== false) continue;
    if (m.outcomeType !== 'BINARY') continue;
    if (!m.closeTime) continue;

    const closeDate = new Date(m.closeTime);
    const daysToResolution = (closeDate.getTime() - now) / (1000 * 60 * 60 * 24);

    if (daysToResolution < 0) continue;
    if (daysToResolution > 7) continue;

    const prob = m.probability ?? 0.5;
    if (prob < 0.15 || prob > 0.85) continue;

    if ((m.uniqueBettorCount || 0) < 20) continue;

    const category = categorizeMarket(m.question, m.tags || []);

    candidates.push({
      id: m.id,
      platform: 'manifold',
      question: m.question,
      category,
      asset: extractAsset(m.question),
      url: `https://manifold.markets/${m.creatorUsername}/${m.slug}`,
      pYes: prob,
      volume: m.volume || 0,
      liquidity: m.totalLiquidity || 0,
      numTraders: m.uniqueBettorCount || 0,
      closeDate,
      daysToResolution,
    });
  }

  console.log(`[Scan] Found ${candidates.length} candidate markets from ${unique.length} unique`);
  return candidates;
}

/**
 * Analyze a batch of markets using Claude for probability estimation
 */
export async function analyzeMarkets(
  candidates: MarketCandidate[],
  bankroll: number,
  taskId?: number,
): Promise<AnalyzedMarket[]> {
  // Get intel signals
  const intelContext = await getIntelContext();
  const hypotheses = await getConfirmedHypotheses();
  const perfBrief = await buildPerformanceBrief();

  const analyzed: AnalyzedMarket[] = [];

  // Process in batches of 5 to avoid rate limits
  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);

    const results = await Promise.allSettled(
      batch.map(market => estimateProbability(market, intelContext, hypotheses, perfBrief, taskId))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'rejected') {
        console.warn(`[Scan] Failed to analyze ${batch[j].question.substring(0, 50)}:`, result.reason);
        continue;
      }

      const estimate = result.value;
      const market = batch[j];

      // Compute all math deterministically
      const edge = estimate.pModel - market.pYes;
      const absEdge = Math.abs(edge);
      const direction = edge > 0 ? 'YES' : 'NO';
      const decimalOdds = direction === 'YES' ? 1 / market.pYes : 1 / (1 - market.pYes);
      const kellyFrac = fractionalKelly(estimate.pModel, decimalOdds);
      const betAmount = betSize(estimate.pModel, decimalOdds, bankroll);
      const expectedRet = simpleExpectedReturn(edge, kellyFrac);
      const score = rewardScore({
        edge: absEdge,
        kellyFrac: Math.max(0, kellyFrac),
        liquidity: market.liquidity,
        closeDate: market.closeDate,
        volume: market.volume,
      });

      analyzed.push({
        ...market,
        pModel: estimate.pModel,
        confidence: estimate.confidence,
        reasoning: estimate.reasoning,
        intelAligned: estimate.intelAligned,
        edge,
        absEdge,
        kellyFrac,
        betAmount,
        expectedRet,
        score,
        intelSignalId: estimate.intelSignalId,
      });
    }
  }

  // Sort by reward score descending
  analyzed.sort((a, b) => b.score - a.score);

  // Record all scans to DB
  for (const a of analyzed) {
    try {
      await query(
        `INSERT INTO market_scans
         (platform, market_id, market_url, question, category, current_prob, volume_usd, liquidity_usd,
          close_date, num_traders, claude_prob, claude_confidence, claude_reasoning, edge, abs_edge,
          kelly_fraction, expected_return, reward_score, intel_aligned)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          a.platform, a.id, a.url, a.question, a.category, a.pYes, a.volume, a.liquidity,
          a.closeDate, a.numTraders, a.pModel, a.confidence, a.reasoning, a.edge, a.absEdge,
          a.kellyFrac, a.expectedRet, a.score, a.intelAligned,
        ]
      );
    } catch (err) {
      console.warn(`[Scan] Failed to record scan for ${a.id}:`, (err as Error).message);
    }
  }

  console.log(`[Scan] Analyzed ${analyzed.length} markets. Top score: ${analyzed[0]?.score?.toFixed(4) || 'none'}`);
  return analyzed;
}

// ── Claude Probability Estimation ────────────────────────────────────

const MEMORY_GUARD = `CRITICAL INSTRUCTION ON HYPOTHESIS AUTHORITY:

The confirmed hypotheses listed below are derived from verified trade performance
data; real money tested them. They are not suggestions. They are not one input
among many. They take precedence over any prior belief, recalled pattern, or
general knowledge that contradicts them.

If something you recall or believe contradicts a confirmed hypothesis below:
- The confirmed hypothesis wins. Do not average. Do not hedge.
- A confirmed hypothesis with 8 data points outweighs any recalled prior.`;

interface ProbabilityEstimate {
  pModel: number;
  confidence: number;
  reasoning: string;
  intelAligned: boolean;
  intelSignalId: number | null;
}

async function estimateProbability(
  market: MarketCandidate,
  intelContext: string,
  hypotheses: string,
  perfBrief: string,
  taskId?: number,
): Promise<ProbabilityEstimate> {
  const scanModel = config.PREDICT_SCAN_MODEL;

  const prompt = `You are estimating the true probability for a prediction market.

Market: "${market.question}"
Current market price (p_market): ${market.pYes.toFixed(4)}
Days to resolution: ${market.daysToResolution.toFixed(1)}
Category: ${market.category}
${market.asset ? `Asset: ${market.asset}` : ''}
Volume: ${market.volume.toFixed(0)}
Traders: ${market.numTraders}

${perfBrief ? `RECENT PERFORMANCE DATA:\n${perfBrief}\n` : ''}
CURRENT INTEL SIGNALS (from X trend scan):
${intelContext || 'No recent signals.'}

${MEMORY_GUARD}

CONFIRMED HYPOTHESES (verified by performance data; follow these):
${hypotheses || 'No confirmed hypotheses yet.'}

Estimate the true probability (p_model) for YES.

Reason through:
1. Base rate for this type of event
2. Current market implied probability vs your estimate
3. Whether any intel signal is relevant and directionally aligned
4. Confidence in your estimate (0.0-1.0)

Output JSON only:
{
  "p_model": 0.52,
  "confidence": 0.71,
  "intel_aligned": true,
  "reasoning": "one paragraph explanation of your reasoning chain"
}`;

  const response = await anthropic.messages.create({
    model: scanModel,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  // Track cost
  if (taskId && response.usage) {
    try {
      const pricing = config.MODEL_PRICING[scanModel] || { input: 300, output: 1500 };
      const costCents = Math.ceil(
        (response.usage.input_tokens * pricing.input + response.usage.output_tokens * pricing.output) / 1_000_000
      );
      await logCostEvent({
        agent_id: 'predict-agent',
        task_id: taskId,
        model: scanModel,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        cost_cents: costCents,
        event_type: 'predict_scan',
      });
    } catch { /* non-critical */ }
  }

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Parse JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse Claude response for ${market.id}: ${text.substring(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  // Validate
  const pModel = Math.max(0.01, Math.min(0.99, parseFloat(parsed.p_model)));
  const confidence = Math.max(0, Math.min(1, parseFloat(parsed.confidence)));

  return {
    pModel,
    confidence,
    reasoning: parsed.reasoning || text.substring(0, 500),
    intelAligned: parsed.intel_aligned === true,
    intelSignalId: null, // Will be set if matched to specific signal
  };
}

// ── Intel Context ────────────────────────────────────────────────────

async function getIntelContext(): Promise<string> {
  try {
    const signals = await query<any>(
      `SELECT * FROM shared_signals
       WHERE consumed_by_predict = false
       AND created_at > NOW() - INTERVAL '6 hours'
       ORDER BY strength DESC LIMIT 10`
    );

    if (signals.length === 0) return '';

    return signals.map(s =>
      `- "${s.topic}": ${s.direction} ${s.direction === 'accelerating' ? '(hot)' : ''} (strength: ${parseFloat(s.strength).toFixed(2)})`
    ).join('\n');
  } catch {
    return '';
  }
}

// ── Categorization ───────────────────────────────────────────────────

function categorizeMarket(question: string, tags: string[]): string {
  const q = question.toLowerCase();
  const t = tags.map(tag => tag.toLowerCase());

  if (/\b(btc|bitcoin|eth|ethereum|sol|solana|xrp|crypto|token|defi)\b/.test(q) || t.includes('crypto')) return 'crypto';
  if (/\b(ai|artificial intelligence|gpt|claude|openai|llm|machine learning)\b/.test(q) || t.includes('ai')) return 'ai_tech';
  if (/\b(fed|inflation|gdp|interest rate|recession|economy|jobs|unemployment)\b/.test(q) || t.includes('economics')) return 'economics';
  if (/\b(trump|biden|election|congress|senate|democrat|republican|vote)\b/.test(q) || t.includes('politics')) return 'politics';
  if (/\b(nba|nfl|mlb|soccer|football|championship|game|match|playoffs)\b/.test(q) || t.includes('sports')) return 'sports';
  return 'other';
}

function extractAsset(question: string): string | undefined {
  const q = question.toLowerCase();
  if (/\bbtc\b|bitcoin/i.test(q)) return 'BTC';
  if (/\beth\b|ethereum/i.test(q)) return 'ETH';
  if (/\bsol\b|solana/i.test(q)) return 'SOL';
  if (/\bxrp\b/i.test(q)) return 'XRP';
  return undefined;
}

/**
 * Validate that scan and reviewer models are reachable
 */
export async function validateModelAccess(): Promise<{ scan: boolean; reviewer: boolean }> {
  const results = { scan: false, reviewer: false };

  try {
    await anthropic.messages.create({
      model: config.PREDICT_SCAN_MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    results.scan = true;
    console.log(`[Scan] Model ${config.PREDICT_SCAN_MODEL} reachable`);
  } catch (err) {
    console.error(`[Scan] FATAL: Model ${config.PREDICT_SCAN_MODEL} unreachable:`, (err as Error).message);
  }

  try {
    await anthropic.messages.create({
      model: config.PREDICT_REVIEWER_MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    results.reviewer = true;
    console.log(`[Scan] Model ${config.PREDICT_REVIEWER_MODEL} reachable`);
  } catch (err) {
    console.error(`[Scan] FATAL: Model ${config.PREDICT_REVIEWER_MODEL} unreachable:`, (err as Error).message);
  }

  return results;
}
