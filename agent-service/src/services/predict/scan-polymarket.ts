/**
 * Predict Agent: Polymarket 5/15-Minute Scanner
 *
 * Discovers active 5/15-minute BTC/ETH/SOL/XRP Up/Down markets from the
 * Polymarket Gamma API using slug-based lookups, computes LMSR probability
 * + Bayesian update with intel signals, and returns ranked candidates.
 *
 * Discovery method: these markets have predictable slugs following the
 * pattern "{asset}-updown-{duration}-{windowStartUnix}", e.g.
 * "btc-updown-5m-1772942700". We compute the current and next few
 * time windows, construct slugs, and query the Gamma events endpoint.
 *
 * Order books are fetched from the CLOB using clobTokenIds.
 * Taker fees exist on 15-min markets; min edge raised to 6c to compensate.
 *
 * No Claude call: 5-minute windows are too fast for LLM roundtrip.
 * All probability estimation is deterministic LMSR + Bayes.
 */

import { config } from '../../config';
import { query } from '../../db';
import { lmsrProb, bayesUpdate, fractionalKelly, rewardScore } from './model';
import { priceFeed, AssetSignal } from './price-feed';
import { getIntelSummary, IntelSummary } from './intel-signal';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

// Asset slugs used in market naming
const ASSET_SLUGS = [
  { slug: 'btc', name: 'BTC', full: 'Bitcoin' },
  { slug: 'eth', name: 'ETH', full: 'Ethereum' },
  { slug: 'sol', name: 'SOL', full: 'Solana' },
  { slug: 'xrp', name: 'XRP', full: 'XRP' },
];

// Duration configs: 5-minute and 15-minute windows
const DURATIONS = [
  { slug: '5m', minutes: 5 },
  { slug: '15m', minutes: 15 },
];

// Polymarket taker fee for 15-min crypto markets (up to 3% at 50% prob; use 2.5% avg)
const POLY_TAKER_FEE_PCT = 0.025;

// Min NET edge after fee subtraction (raised from 6c gross to 9c net per audit)
const POLY_MIN_NET_EDGE = 0.09;

// How many upcoming windows to check per asset per duration
const WINDOWS_TO_CHECK = 4;

/** Parse clobTokenIds which Gamma returns as a JSON-encoded string */
function parseClobTokenIds(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

/** Gamma API event shape with nested markets */
interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  markets: GammaMarket[];
}

/** Gamma API market shape (subset of fields we need) */
interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string;
  clobTokenIds: string | string[]; // Gamma returns JSON-encoded string, not array
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
  // Order book data
  yesDepth: number;
  noDepth: number;
  totalLiquidity: number;
  volume24h: number;
  // Signal tracking
  pAfterMomentum: number;
  priceMomentum: string | null;
  priceReturn5m: number | null;
  intelSentiment: number | null;
  intelSignalCount: number | null;
  // Fee-adjusted edge
  grossEdge: number;
  netEdge: number;
  takerFeePct: number;
  // Market metadata for trade execution
  conditionId: string;
  negRisk: boolean;
  tickSize: string;
  minOrderSize: number;
}

/**
 * Compute aligned window start timestamps for a given duration.
 * Windows align to Unix epoch (e.g., 5-min windows at :00, :05, :10, etc.)
 */
function getWindowTimestamps(durationMinutes: number, count: number): number[] {
  const now = Math.floor(Date.now() / 1000);
  const windowSec = durationMinutes * 60;
  // Current window start (floor to window boundary)
  const currentWindowStart = Math.floor(now / windowSec) * windowSec;

  const timestamps: number[] = [];
  // Include the current window and next few windows
  for (let i = 0; i < count; i++) {
    timestamps.push(currentWindowStart + i * windowSec);
  }
  return timestamps;
}

/**
 * Fetch active 5/15-minute Up/Down crypto markets from Polymarket Gamma API
 * using slug-based discovery.
 */
export async function scanPolymarket(): Promise<PolyCandidate[]> {
  if (!config.POLYMARKET_API_KEY) {
    console.log('[PolyScan] POLYMARKET_API_KEY not configured. Skipping.');
    return [];
  }

  console.log(`[PolyScan] Discovering Up/Down markets via slug lookup`);

  try {
    // Build list of slugs to check
    const slugsToCheck: { slug: string; asset: string; assetSlug: string; minutes: number }[] = [];
    for (const asset of ASSET_SLUGS) {
      for (const dur of DURATIONS) {
        const timestamps = getWindowTimestamps(dur.minutes, WINDOWS_TO_CHECK);
        for (const ts of timestamps) {
          slugsToCheck.push({
            slug: `${asset.slug}-updown-${dur.slug}-${ts}`,
            asset: asset.name,
            assetSlug: asset.slug,
            minutes: dur.minutes,
          });
        }
      }
    }

    console.log(`[PolyScan] Checking ${slugsToCheck.length} potential market slugs`);

    // Query each slug via the events endpoint (parallel with rate limiting)
    const BATCH_SIZE = 8;
    const discoveredMarkets: { market: GammaMarket; asset: string; minutes: number; eventSlug: string }[] = [];

    for (let i = 0; i < slugsToCheck.length; i += BATCH_SIZE) {
      const batch = slugsToCheck.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (s) => {
          // Try events endpoint first (returns event with nested markets)
          const res = await fetch(`${GAMMA_BASE}/events/slug/${s.slug}`);
          if (!res.ok) {
            // Try markets endpoint as fallback
            const res2 = await fetch(`${GAMMA_BASE}/markets?slug=${s.slug}`);
            if (!res2.ok) return null;
            const markets = await res2.json() as GammaMarket[];
            if (markets.length === 0) return null;
            return { markets, slug: s.slug, asset: s.asset, minutes: s.minutes };
          }
          const event = await res.json() as GammaEvent;
          if (!event.markets || event.markets.length === 0) return null;
          return { markets: event.markets, slug: s.slug, asset: s.asset, minutes: s.minutes };
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const { markets, slug, asset, minutes } = result.value;
          for (const m of markets) {
            const tokens = parseClobTokenIds(m.clobTokenIds);
            if (m.active && !m.closed && tokens.length >= 2) {
              discoveredMarkets.push({ market: m, asset, minutes, eventSlug: slug });
            }
          }
        }
      }
    }

    console.log(`[PolyScan] Discovered ${discoveredMarkets.length} active markets`);
    for (const d of discoveredMarkets.slice(0, 8)) {
      console.log(`[PolyScan]   -> "${d.market.question}" (${d.asset} ${d.minutes}m)`);
    }

    if (discoveredMarkets.length === 0) {
      console.log('[PolyScan] No active Up/Down markets found. Markets may be between windows.');
      return [];
    }

    // Get intel signals for crypto assets
    const intelSignals = await getIntelSignals();

    // Analyze each discovered market
    const bankroll = await getPolyBankroll();
    const analyzed: PolyCandidate[] = [];

    for (const { market: m, asset, minutes, eventSlug } of discoveredMarkets) {
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
      const tokenIds = parseClobTokenIds(m.clobTokenIds);
      const yesTokenId = tokenIds[0];
      const noTokenId = tokenIds[1];
      const book = await fetchOrderBook(yesTokenId);
      if (book) {
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

      // Signal 1: Price momentum from Coinbase/Binance feed
      let pAfterMomentum = pLmsr;
      const priceSignal = priceFeed.getSignal(asset);

      if (priceSignal && priceSignal.lastUpdated > Date.now() - 60_000) {
        const momentumLikelihood = computeMomentumLikelihood(priceSignal, minutes);
        pAfterMomentum = bayesUpdate(pLmsr, momentumLikelihood.up);
      }

      // Signal 2: Intel sentiment from X agent shared_signals (decayed + aggregated)
      const intelSummary = await getIntelSummary(asset);

      let pBayes = pAfterMomentum;
      let intelAligned = false;
      let intelSignalId: number | null = null;

      if (intelSummary && intelSummary.signalCount > 0 && intelSummary.freshestSignalAge < 240) {
        const intelLikelihood = computeIntelLikelihood(intelSummary, minutes);
        pBayes = bayesUpdate(pAfterMomentum, intelLikelihood.up);
        intelAligned = Math.abs(intelSummary.netSentiment) > 0.1;
      }

      // Legacy: check old intel signals for signal ID tracking
      const intel = intelSignals.find(s =>
        s.topic.toLowerCase().includes(asset.toLowerCase())
      );
      if (intel) intelSignalId = intel.id;

      // Compute edge and direction
      const grossEdge = pBayes - pMarket;
      const direction = grossEdge > 0 ? 'YES' : 'NO';
      const absGrossEdge = Math.abs(grossEdge);

      // Subtract taker fee from edge to get net edge
      // Fee is applied to the contract price, so fee impact = takerFee * contractPrice
      const contractPrice = direction === 'YES' ? pMarket : (1 - pMarket);
      const feeImpact = POLY_TAKER_FEE_PCT * contractPrice;
      const netEdge = Math.max(0, absGrossEdge - feeImpact);

      // Use net edge for all downstream calculations
      const edge = grossEdge; // preserve sign for direction
      const absEdge = netEdge; // net edge for threshold + sizing

      // Kelly sizing with Polymarket-specific fraction (15%), using net edge probability
      const decimalOdds = direction === 'YES' ? 1 / pMarket : 1 / (1 - pMarket);
      const kellyFrac = fractionalKelly(pBayes, decimalOdds, config.PREDICT_POLY_KELLY_FRACTION);
      const betAmount = Math.min(
        kellyFrac > 0 ? kellyFrac * bankroll : 0,
        bankroll * 0.05 // 5% max per position
      );

      const closeDate = new Date(m.endDate);
      const expectedRet = absEdge * Math.max(0, kellyFrac);

      const score = rewardScore({
        edge: absEdge,
        kellyFrac: Math.max(0, kellyFrac),
        liquidity: totalLiquidity,
        closeDate,
        volume: volume24h,
      });

      const momentumStr = priceSignal
        ? `momentum=${priceSignal.momentum} (${(priceSignal.return5m * 100).toFixed(2)}% 5m)`
        : 'no price feed';
      const reasoning = `LMSR p=${pLmsr.toFixed(4)}, market=${pMarket.toFixed(4)}, ` +
        `${momentumStr}, pMomentum=${pAfterMomentum.toFixed(4)}, ` +
        `${intel ? `intel ${intel.direction} (${asset})` : 'no intel'}, ` +
        `gross_edge=${(absGrossEdge * 100).toFixed(1)}c, fee=${(feeImpact * 100).toFixed(1)}c, ` +
        `net_edge=${(netEdge * 100).toFixed(1)}c, kelly=${(kellyFrac * 100).toFixed(1)}%, ` +
        `depth=${yesDepth.toFixed(0)}/${noDepth.toFixed(0)}, ${minutes}min market`;

      analyzed.push({
        id: m.conditionId,
        platform: 'polymarket',
        question: m.question,
        category: 'crypto',
        asset,
        url: `https://polymarket.com/event/${eventSlug}`,
        pYes: pMarket,
        pLmsr,
        pBayes,
        edge,
        direction,
        betAmount,
        kellyFrac,
        expectedRet,
        score,
        resolutionMinutes: minutes,
        intelAligned,
        intelSignalId,
        reasoning,
        yesTokenId: yesTokenId || '',
        noTokenId: noTokenId || '',
        yesDepth,
        noDepth,
        totalLiquidity,
        volume24h,
        pAfterMomentum,
        priceMomentum: priceSignal?.momentum ?? null,
        priceReturn5m: priceSignal?.return5m ?? null,
        intelSentiment: intelSummary?.netSentiment ?? null,
        intelSignalCount: intelSummary?.signalCount ?? null,
        grossEdge: absGrossEdge,
        netEdge,
        takerFeePct: POLY_TAKER_FEE_PCT,
        conditionId: m.conditionId,
        negRisk: false,    // crypto up/down markets are NOT neg risk
        tickSize: '0.01',  // 1-cent ticks for crypto markets
        minOrderSize: 5,   // $5 minimum from CLOB API
      });
    }

    // Sort by score descending
    analyzed.sort((a, b) => b.score - a.score);

    // Record scans to DB (with signal tracking, CLOB depth, and fee-adjusted edge)
    for (const a of analyzed) {
      try {
        await query(
          `INSERT INTO market_scans
           (platform, market_id, market_url, question, category, current_prob, volume_usd, liquidity_usd,
            close_date, num_traders, claude_prob, claude_confidence, claude_reasoning, edge, abs_edge,
            kelly_fraction, expected_return, reward_score, intel_aligned,
            price_momentum, price_return_5m, intel_sentiment, intel_signal_count, p_after_momentum, p_final,
            p_lmsr, yes_quantity, no_quantity, gross_edge, net_edge)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
          [
            a.platform, a.id, a.url, a.question, a.category, a.pYes,
            a.volume24h, a.totalLiquidity,
            new Date(Date.now() + a.resolutionMinutes * 60000), 0,
            a.pBayes, 0.5, a.reasoning, a.edge, a.netEdge,
            a.kellyFrac, a.expectedRet, a.score, a.intelAligned,
            a.priceMomentum ?? null, a.priceReturn5m ?? null,
            a.intelSentiment ?? null, a.intelSignalCount ?? null,
            a.pAfterMomentum ?? null, a.pBayes,
            a.pLmsr, a.yesDepth, a.noDepth, a.grossEdge, a.netEdge,
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
    const res = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);

    if (!res.ok) {
      console.warn(`[PolyScan] Order book fetch failed for ${tokenId.slice(0, 20)}...: ${res.status}`);
      return null;
    }

    const book = await res.json() as any;

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

// ── Price momentum likelihood ───────────────────────────────────────────

function computeMomentumLikelihood(
  signal: AssetSignal,
  windowMinutes: number
): { up: number } {
  // Momentum -> likelihood of Up outcome (calibrated to crypto 5/15-min markets)
  const strengthMap: Record<AssetSignal['momentum'], number> = {
    strong_up:   0.62,   // reduced from 0.65 per audit (backtesting suggests 55-60% WR)
    up:          0.58,
    neutral:     0.50,
    down:        0.42,
    strong_down: 0.38,   // symmetric with strong_up
  };

  let likelihoodUp = strengthMap[signal.momentum];

  // Dampen for longer windows (increased from 0.6 to 0.75 per audit:
  // momentum is more predictive over 15m than 5m, 0.6 over-dampened)
  if (windowMinutes === 15) {
    likelihoodUp = 0.50 + (likelihoodUp - 0.50) * 0.75;
  }

  return { up: likelihoodUp };
}

// ── Intel sentiment likelihood ──────────────────────────────────────────

function computeIntelLikelihood(
  intel: IntelSummary,
  windowMinutes: number
): { up: number } {
  // Net sentiment: +1.0 = max bullish, -1.0 = max bearish
  // Map to likelihood of Up outcome (max shift +/- 12%)
  const rawLikelihood = 0.50 + intel.netSentiment * 0.12;

  // Dampen for short windows: sentiment affects 15-min more than 5-min
  const dampening = windowMinutes === 5 ? 0.5 : 0.8;
  const likelihoodUp = 0.50 + (rawLikelihood - 0.50) * dampening;

  return { up: Math.max(0.35, Math.min(0.65, likelihoodUp)) };
}

// ── Intel context (legacy) ──────────────────────────────────────────────

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
