/**
 * Predict Agent: Polymarket 5-Minute Scanner
 *
 * Fetches active 5-minute BTC/ETH/SOL/XRP Up/Down markets from the
 * Polymarket CLOB API, computes LMSR probability + Bayesian update
 * with intel signals, and returns ranked candidates.
 *
 * No Claude call: 5-minute windows are too fast for LLM roundtrip.
 * All probability estimation is deterministic LMSR + Bayes.
 */

import { config } from '../../config';
import { query } from '../../db';
import { lmsrProb, bayesUpdate, fractionalKelly, betSize as calcBetSize, rewardScore } from './model';

const CLOB_BASE = 'https://clob.polymarket.com';
const POLY_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];

export interface PolyMarketRaw {
  condition_id: string;
  question_id: string;
  question: string;
  tokens: { token_id: string; outcome: string }[];
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  market_slug: string;
  description: string;
  tags?: string[];
}

export interface PolyCandidate {
  id: string;
  platform: 'polymarket';
  question: string;
  category: string;
  asset: string;
  url: string;
  pYes: number;           // CLOB mid price
  pLmsr: number;          // LMSR implied probability
  pBayes: number;         // Bayesian posterior with intel
  edge: number;           // pBayes - pYes
  direction: 'YES' | 'NO';
  betAmount: number;
  kellyFrac: number;
  expectedRet: number;
  score: number;
  resolutionMinutes: number;
  intelAligned: boolean;
  intelSignalId: number | null;
  reasoning: string;
  yesTokenId: string;
  noTokenId: string;
}

/**
 * Fetch active 5-minute Up/Down crypto markets from Polymarket CLOB
 */
export async function scanPolymarket(): Promise<PolyCandidate[]> {
  if (!config.POLYMARKET_API_KEY) {
    console.log('[PolyScan] POLYMARKET_API_KEY not configured. Skipping.');
    return [];
  }

  console.log(`[PolyScan] Fetching active markets for ${POLY_ASSETS.join(', ')}`);

  try {
    // Fetch active markets
    const res = await fetch(`${CLOB_BASE}/markets?active=true&closed=false&limit=200`, {
      headers: {
        'Authorization': `Bearer ${config.POLYMARKET_API_KEY}`,
      },
    });

    if (!res.ok) {
      console.error(`[PolyScan] CLOB API error: ${res.status} ${await res.text()}`);
      return [];
    }

    const data = await res.json();
    const markets: PolyMarketRaw[] = Array.isArray(data) ? data : (data.data || data.markets || []);

    console.log(`[PolyScan] Fetched ${markets.length} active markets`);

    // Filter to 5-15 minute resolution on target assets
    const candidates: PolyMarketRaw[] = [];
    const now = Date.now();

    for (const m of markets) {
      if (!m.active || m.closed) continue;
      if (!m.end_date_iso) continue;

      const question = m.question.toLowerCase();
      const asset = POLY_ASSETS.find(a => question.includes(a.toLowerCase()));
      if (!asset) continue;

      // Check resolution window: 5-15 minutes
      const endTime = new Date(m.end_date_iso).getTime();
      const minutesToResolution = (endTime - now) / (1000 * 60);
      if (minutesToResolution < 1 || minutesToResolution > 15) continue;

      // Must have tokens (YES/NO outcomes)
      if (!m.tokens || m.tokens.length < 2) continue;

      candidates.push(m);
    }

    console.log(`[PolyScan] Found ${candidates.length} 5-min crypto candidates`);

    // Get intel signals for crypto assets
    const intelSignals = await getIntelSignals();

    // Analyze each candidate
    const bankroll = await getPolyBankroll();
    const analyzed: PolyCandidate[] = [];

    for (const m of candidates) {
      const asset = POLY_ASSETS.find(a => m.question.toLowerCase().includes(a.toLowerCase()))!;

      // Fetch order book for mid price
      const book = await fetchOrderBook(m.condition_id);
      if (!book) continue;

      const pMarket = book.midPrice;
      if (pMarket < 0.10 || pMarket > 0.90) continue; // Skip extreme probabilities

      // LMSR probability from order book quantities
      const yesQty = book.yesDepth;
      const noQty = book.noDepth;
      const pLmsr = lmsrProb([yesQty, noQty], 0, config.PREDICT_POLY_LMSR_B);

      // Bayesian update with intel signal
      const intel = intelSignals.find(s =>
        s.topic.toLowerCase().includes(asset.toLowerCase())
      );

      let pBayes = pLmsr;
      let intelAligned = false;
      let intelSignalId: number | null = null;

      if (intel) {
        const likelihood = intel.direction === 'accelerating' ? 0.65 : 0.35;
        pBayes = bayesUpdate(pLmsr, likelihood, 0.5);
        intelAligned = true;
        intelSignalId = intel.id;
      }

      // Compute edge and direction
      const edge = pBayes - pMarket;
      const direction = edge > 0 ? 'YES' : 'NO';
      const absEdge = Math.abs(edge);

      // Kelly sizing with Polymarket-specific fraction (15%)
      const decimalOdds = direction === 'YES' ? 1 / pMarket : 1 / (1 - pMarket);
      const kellyFrac = fractionalKelly(pBayes, decimalOdds, config.PREDICT_POLY_KELLY_FRACTION);
      const betAmount = Math.min(
        kellyFrac > 0 ? kellyFrac * bankroll : 0,
        bankroll * 0.05 // 5% max per position
      );

      const endTime = new Date(m.end_date_iso).getTime();
      const resolutionMinutes = (endTime - now) / (1000 * 60);
      const expectedRet = absEdge * Math.max(0, kellyFrac);

      const score = rewardScore({
        edge: absEdge,
        kellyFrac: Math.max(0, kellyFrac),
        liquidity: book.totalLiquidity,
        closeDate: new Date(m.end_date_iso),
        volume: book.volume24h,
      });

      const yesToken = m.tokens.find(t => t.outcome === 'Yes' || t.outcome === 'YES');
      const noToken = m.tokens.find(t => t.outcome === 'No' || t.outcome === 'NO');

      const reasoning = `LMSR p=${pLmsr.toFixed(4)}, market=${pMarket.toFixed(4)}, ` +
        `${intel ? `intel ${intel.direction} (${asset})` : 'no intel'}, ` +
        `edge=${(edge * 100).toFixed(1)}c, kelly=${(kellyFrac * 100).toFixed(1)}%, ` +
        `resolves in ${resolutionMinutes.toFixed(0)}min`;

      analyzed.push({
        id: m.condition_id,
        platform: 'polymarket',
        question: m.question,
        category: 'crypto',
        asset,
        url: `https://polymarket.com/event/${m.market_slug}`,
        pYes: pMarket,
        pLmsr,
        pBayes,
        edge,
        direction,
        betAmount,
        kellyFrac,
        expectedRet,
        score,
        resolutionMinutes,
        intelAligned,
        intelSignalId,
        reasoning,
        yesTokenId: yesToken?.token_id || '',
        noTokenId: noToken?.token_id || '',
      });
    }

    // Sort by score descending
    analyzed.sort((a, b) => b.score - a.score);

    // Record scans to DB
    for (const a of analyzed) {
      try {
        await query(
          `INSERT INTO market_scans
           (platform, market_id, market_url, question, category, current_prob, volume_usd, liquidity_usd,
            close_date, num_traders, claude_prob, claude_confidence, claude_reasoning, edge, abs_edge,
            kelly_fraction, expected_return, reward_score, intel_aligned)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            a.platform, a.id, a.url, a.question, a.category, a.pYes, 0, 0,
            new Date(Date.now() + a.resolutionMinutes * 60000), 0,
            a.pBayes, 0.5, a.reasoning, a.edge, Math.abs(a.edge),
            a.kellyFrac, a.expectedRet, a.score, a.intelAligned,
          ]
        );
      } catch (err) {
        console.warn(`[PolyScan] Failed to record scan for ${a.id}:`, (err as Error).message);
      }
    }

    console.log(`[PolyScan] Analyzed ${analyzed.length} markets. Top score: ${analyzed[0]?.score?.toFixed(4) || 'none'}`);
    return analyzed;
  } catch (err) {
    console.error(`[PolyScan] Scan failed:`, (err as Error).message);
    return [];
  }
}

// ── Order book fetching ─────────────────────────────────────────────────

interface OrderBookSummary {
  midPrice: number;
  yesDepth: number;
  noDepth: number;
  totalLiquidity: number;
  volume24h: number;
  bestBid: number;
  bestAsk: number;
}

async function fetchOrderBook(conditionId: string): Promise<OrderBookSummary | null> {
  try {
    const res = await fetch(`${CLOB_BASE}/book?token_id=${conditionId}`, {
      headers: {
        'Authorization': `Bearer ${config.POLYMARKET_API_KEY}`,
      },
    });

    if (!res.ok) {
      console.warn(`[PolyScan] Order book fetch failed for ${conditionId}: ${res.status}`);
      return null;
    }

    const book = await res.json();

    // Parse bids/asks to get mid price
    const bids = (book.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
    const asks = (book.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));

    if (bids.length === 0 || asks.length === 0) return null;

    const bestBid = Math.max(...bids.map((b: any) => b.price));
    const bestAsk = Math.min(...asks.map((a: any) => a.price));
    const midPrice = (bestBid + bestAsk) / 2;

    const yesDepth = bids.reduce((sum: number, b: any) => sum + b.size, 0);
    const noDepth = asks.reduce((sum: number, a: any) => sum + a.size, 0);
    const totalLiquidity = yesDepth + noDepth;

    return {
      midPrice,
      yesDepth,
      noDepth,
      totalLiquidity,
      volume24h: parseFloat(book.volume24h || '0'),
      bestBid,
      bestAsk,
    };
  } catch (err) {
    console.warn(`[PolyScan] Order book error for ${conditionId}:`, (err as Error).message);
    return null;
  }
}

// ── Intel context ───────────────────────────────────────────────────────

interface IntelSignal {
  id: number;
  topic: string;
  direction: string;
  strength: number;
}

async function getIntelSignals(): Promise<IntelSignal[]> {
  try {
    const signals = await query<any>(
      `SELECT id, topic, direction, strength FROM shared_signals
       WHERE consumed_by_predict = false
       AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY strength DESC LIMIT 10`
    );

    return signals.map(s => ({
      id: s.id,
      topic: s.topic,
      direction: s.direction,
      strength: parseFloat(s.strength),
    }));
  } catch {
    return [];
  }
}

// ── Polymarket bankroll ─────────────────────────────────────────────────

async function getPolyBankroll(): Promise<number> {
  // Try daily risk state first
  const todayStr = new Date().toISOString().split('T')[0];
  const risk = await query<any>(
    `SELECT current_bankroll FROM daily_risk_state WHERE date = $1 AND platform = 'polymarket'`,
    [todayStr]
  ).catch(() => []);

  if (risk.length > 0) return parseFloat(risk[0].current_bankroll);

  // Default starting bankroll from config
  return config.PREDICT_POLY_STARTING_BANKROLL;
}
