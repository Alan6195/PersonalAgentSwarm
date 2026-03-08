/**
 * Predict Agent: Polymarket 5/15-Minute Scanner
 *
 * Fetches active 5/15-minute BTC/ETH/SOL/XRP Up/Down markets from the
 * Polymarket Gamma API, computes LMSR probability + Bayesian update
 * with intel signals, and returns ranked candidates.
 *
 * Architecture note: these markets are on the Gamma API, not the CLOB
 * /markets endpoint. Each time window is a separate market instance
 * titled like "Bitcoin Up or Down - March 6, 1:45AM-2:00AM ET".
 * Order books are fetched from the CLOB using clobTokenIds.
 *
 * Taker fees exist on 15-min markets; min edge raised to 6c to compensate.
 *
 * No Claude call: 5-minute windows are too fast for LLM roundtrip.
 * All probability estimation is deterministic LMSR + Bayes.
 */

import { config } from '../../config';
import { query } from '../../db';
import { lmsrProb, bayesUpdate, fractionalKelly, rewardScore } from './model';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const POLY_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const POLY_ASSET_NAMES: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', xrp: 'XRP',
};

// Min edge raised from 4c to 6c for Polymarket to account for taker fees
const POLY_MIN_EDGE = 0.06;

// Match "Bitcoin Up or Down - March 6, 1:45AM-2:00AM ET" style titles
// and also "Bitcoin Up or Down - 15 min" if that format ever appears
const UP_DOWN_RE = /(bitcoin|ethereum|solana|xrp)\s.*up or down/i;

/** Gamma API market shape (subset of fields we need) */
interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string;
  clobTokenIds: string[];
  active: boolean;
  closed: boolean;
  endDate: string;
  volume: string;
  liquidity: string;
}

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
 * Fetch active 5/15-minute Up/Down crypto markets from Polymarket Gamma API
 */
export async function scanPolymarket(): Promise<PolyCandidate[]> {
  if (!config.POLYMARKET_API_KEY) {
    console.log('[PolyScan] POLYMARKET_API_KEY not configured. Skipping.');
    return [];
  }

  console.log(`[PolyScan] Fetching Up/Down markets from Gamma API`);

  try {
    // Use Gamma API text search to find Up/Down crypto markets
    const res = await fetch(
      `${GAMMA_BASE}/markets?q=up+or+down&active=true&closed=false&limit=100`,
    );

    if (!res.ok) {
      console.error(`[PolyScan] Gamma API error: ${res.status} ${await res.text()}`);
      return [];
    }

    const markets: GammaMarket[] = await res.json();
    console.log(`[PolyScan] Gamma returned ${markets.length} "up or down" markets`);

    // Filter to crypto Up/Down markets for target assets
    const candidates: GammaMarket[] = [];

    for (const m of markets) {
      if (!m.active || m.closed) continue;
      if (!UP_DOWN_RE.test(m.question)) continue;
      if (!m.clobTokenIds || m.clobTokenIds.length < 2) continue;

      candidates.push(m);
    }

    console.log(`[PolyScan] Found ${candidates.length} crypto Up/Down candidates`);
    for (const c of candidates.slice(0, 8)) {
      console.log(`[PolyScan]   -> "${c.question}" (${c.conditionId.slice(0, 18)}...)`);
    }

    if (candidates.length === 0) return [];

    // Get intel signals for crypto assets
    const intelSignals = await getIntelSignals();

    // Analyze each candidate
    const bankroll = await getPolyBankroll();
    const now = Date.now();
    const analyzed: PolyCandidate[] = [];

    for (const m of candidates) {
      // Determine asset from question
      const questionLower = m.question.toLowerCase();
      const asset = Object.entries(POLY_ASSET_NAMES).find(([name]) =>
        questionLower.includes(name)
      )?.[1];
      if (!asset) continue;

      // Extract resolution duration: look for "5 min" or "15 min" in title,
      // or infer from time window like "1:45AM-2:00AM" (15 min) or "1:45AM-1:50AM" (5 min)
      let resolutionMinutes = 15; // default
      const durationMatch = m.question.match(/(\d+)[\s-]*min/i);
      if (durationMatch) {
        resolutionMinutes = parseInt(durationMatch[1], 10);
      } else {
        // Try to parse from time window: "1:45AM-2:00AM" format
        const timeMatch = m.question.match(/(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i);
        if (timeMatch) {
          let startH = parseInt(timeMatch[1], 10);
          const startM = parseInt(timeMatch[2], 10);
          const startAmPm = timeMatch[3].toUpperCase();
          let endH = parseInt(timeMatch[4], 10);
          const endM = parseInt(timeMatch[5], 10);
          const endAmPm = timeMatch[6].toUpperCase();
          if (startAmPm === 'PM' && startH !== 12) startH += 12;
          if (startAmPm === 'AM' && startH === 12) startH = 0;
          if (endAmPm === 'PM' && endH !== 12) endH += 12;
          if (endAmPm === 'AM' && endH === 12) endH = 0;
          const diffMin = (endH * 60 + endM) - (startH * 60 + startM);
          if (diffMin > 0 && diffMin <= 30) resolutionMinutes = diffMin;
        }
      }

      // Get market price from Gamma outcomePrices or fetch from CLOB
      let pMarket: number;
      let yesDepth = 0;
      let noDepth = 0;
      let totalLiquidity = 0;
      let volume24h = 0;

      // Try Gamma outcomePrices first (faster, no extra API call)
      if (m.outcomePrices) {
        try {
          const prices = JSON.parse(m.outcomePrices);
          pMarket = parseFloat(prices[0] || '0.5');
        } catch {
          pMarket = 0.5;
        }
      } else {
        pMarket = 0.5;
      }

      // Fetch CLOB order book for depth data using YES token ID
      const yesTokenId = m.clobTokenIds[0];
      const noTokenId = m.clobTokenIds[1];
      const book = await fetchOrderBook(yesTokenId);
      if (book) {
        // Use CLOB mid price if available (more accurate than Gamma snapshot)
        pMarket = book.midPrice;
        yesDepth = book.yesDepth;
        noDepth = book.noDepth;
        totalLiquidity = book.totalLiquidity;
        volume24h = book.volume24h;
      }

      if (pMarket < 0.10 || pMarket > 0.90) continue; // Skip extreme probabilities

      // LMSR probability from order book quantities
      const pLmsr = (yesDepth > 0 || noDepth > 0)
        ? lmsrProb([yesDepth, noDepth], 0, config.PREDICT_POLY_LMSR_B)
        : pMarket; // fallback to market price if no depth data

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

      const closeDate = new Date(now + resolutionMinutes * 60000);
      const expectedRet = absEdge * Math.max(0, kellyFrac);

      const score = rewardScore({
        edge: absEdge,
        kellyFrac: Math.max(0, kellyFrac),
        liquidity: totalLiquidity,
        closeDate,
        volume: volume24h,
      });

      const reasoning = `LMSR p=${pLmsr.toFixed(4)}, market=${pMarket.toFixed(4)}, ` +
        `${intel ? `intel ${intel.direction} (${asset})` : 'no intel'}, ` +
        `edge=${(edge * 100).toFixed(1)}c, kelly=${(kellyFrac * 100).toFixed(1)}%, ` +
        `${resolutionMinutes}min market`;

      analyzed.push({
        id: m.conditionId,
        platform: 'polymarket',
        question: m.question,
        category: 'crypto',
        asset,
        url: `https://polymarket.com/event/${m.slug}`,
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
        yesTokenId: yesTokenId || '',
        noTokenId: noTokenId || '',
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

async function fetchOrderBook(tokenId: string): Promise<OrderBookSummary | null> {
  try {
    const res = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`, {
      headers: {
        'Authorization': `Bearer ${config.POLYMARKET_API_KEY}`,
      },
    });

    if (!res.ok) {
      console.warn(`[PolyScan] Order book fetch failed for ${tokenId.slice(0, 20)}...: ${res.status}`);
      return null;
    }

    const book: any = await res.json();

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
    console.warn(`[PolyScan] Order book error for ${tokenId.slice(0, 20)}...:`, (err as Error).message);
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
