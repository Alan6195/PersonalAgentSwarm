/**
 * Predict Agent: Cron Handlers
 *
 * Handler functions called by cron-scheduler.ts for each predict cron job.
 * Each follows the same pattern as Memory Maintenance / Analytics Snapshot handlers.
 */

import { scanManifold, analyzeMarkets, validateModelAccess } from './scan';
import { executeTrade, reconcilePositions, getCurrentBankroll, getManifoldBalance } from './execute';
import { scanPolymarket, discoverActiveUpDownMarkets } from './scan-polymarket';
import { executePolymarketTrade, getUSDCBalance, reconcilePolymarketPositions } from './execute-polymarket';
import { checkEdgeCandidateNotification } from './telegram';
import { resetDailyRisk, validateTrade, recordTradeOpened } from './risk-gate';
import { runWeeklyReview } from './learn';
import { priceFeed } from './price-feed';
import { getIntelSummary } from './intel-signal';
import { orderFlowService, type OrderFlowSignal } from './order-flow';
import { query, queryOne } from '../../db';
import { config, isPolyDryRun } from '../../config';

let modelsValidated = false;

// ── Momentum Watcher (Loop 1) ─────────────────────────────────────────────
// Runs every 60 seconds via setInterval. Pure in-memory check of price feed
// signals (zero API cost, zero DB writes). When any asset crosses the
// momentum threshold, triggers a full Polymarket scan immediately.
// 5-minute cooldown prevents repeated scans on the same momentum event.

let momentumWatcherInterval: NodeJS.Timeout | null = null;
let lastFullScanAt = 0;
const SCAN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Start the momentum watcher loop. Calls onTrigger with scan result
 * when momentum is detected and a scan is triggered.
 */
export function startMomentumWatcher(
  onTrigger: (result: string, asset: string, direction: string) => void
): void {
  console.log('[MomentumWatch] Started — checking every 60s');

  momentumWatcherInterval = setInterval(async () => {
    // Cooldown check: don't re-trigger within 5 minutes of last scan
    if (Date.now() - lastFullScanAt < SCAN_COOLDOWN_MS) return;

    const signals = ['BTC', 'ETH', 'SOL', 'XRP'].map(a => priceFeed.getSignal(a));
    const triggerSignal = signals.find(s =>
      s && s.momentum !== 'neutral' && s.momentumStrength > 0.3
    );

    if (!triggerSignal) return;

    console.log(
      `[MomentumWatch] Detected: ${triggerSignal.asset} ${triggerSignal.momentum} ` +
      `(strength: ${triggerSignal.momentumStrength.toFixed(2)}, ` +
      `5m return: ${(triggerSignal.return5m * 100).toFixed(2)}%)`
    );

    // Trigger full scan (Loop 2)
    try {
      lastFullScanAt = Date.now();
      const result = await handlePolymarketScan(0);
      onTrigger(result, triggerSignal.asset, triggerSignal.momentum);
    } catch (err: any) {
      console.error('[MomentumWatch] Scan failed:', err.message);
    }
  }, 60_000);
}

/**
 * Stop the momentum watcher loop. Called on graceful shutdown.
 */
export function stopMomentumWatcher(): void {
  if (momentumWatcherInterval) {
    clearInterval(momentumWatcherInterval);
    momentumWatcherInterval = null;
    console.log('[MomentumWatch] Stopped');
  }
}

// ── Order Flow Scanner (Loop 3) ─────────────────────────────────────────────
// Event-driven: OrderFlowService fires signals when OFI crosses thresholds
// near window boundaries. The signal handler runs risk gate + execution.
// Market discovery runs every 30 min via cron to refresh the watch list.

let orderFlowStarted = false;
let telegramNotifyFn: ((text: string) => Promise<void>) | null = null;

/**
 * Set the Telegram notifier for order flow signals.
 * Called once during startup from cron-scheduler.ts.
 */
export function setOrderFlowTelegramNotifier(notifier: (text: string) => Promise<void>): void {
  telegramNotifyFn = notifier;
}

/**
 * Start the order flow scanner: discover markets and connect WebSocket.
 * Called once during agent startup. Subsequent market updates happen via
 * the 30-min discovery cron.
 */
export async function startOrderFlowScanner(): Promise<string> {
  if (!config.POLYMARKET_API_KEY) {
    return 'POLYMARKET_API_KEY not configured. Order flow scanner disabled.';
  }

  if (orderFlowStarted) {
    return 'Order flow scanner already running.';
  }

  // Wire signal handler: fires when OFI crosses threshold at window boundary
  orderFlowService.setSignalHandler(async (signal: OrderFlowSignal) => {
    try {
      await handleOrderFlowSignal(signal);
    } catch (err: any) {
      console.error('[OrderFlow] Signal handler error:', err.message);
    }
  });

  // Discover initial markets
  const markets = await discoverActiveUpDownMarkets();
  if (markets.length === 0) {
    console.log('[OrderFlow] No active markets found. WebSocket will start on next discovery cycle.');
    orderFlowStarted = true;
    return 'Order flow scanner started (no active markets yet, waiting for discovery).';
  }

  await orderFlowService.start(markets);
  orderFlowStarted = true;

  return `Order flow scanner started: watching ${markets.length} markets via WebSocket.`;
}

/**
 * Stop the order flow scanner. Called on graceful shutdown.
 */
export function stopOrderFlowScanner(): void {
  orderFlowService.stop();
  orderFlowStarted = false;
  console.log('[OrderFlow] Scanner stopped');
}

/**
 * Handle an order flow signal from the WebSocket scanner.
 * Runs risk gate, then executes trade (or dry-run logs).
 *
 * STRATEGY (data-driven, 101 trades analyzed):
 * The ONLY profitable configuration is cheap fill (<48c) + plenty of time (15+ min).
 * That combo: 77.8% win rate, +$22.54 profit out of 18 trades.
 * Everything else loses money. We enforce both conditions as hard gates.
 */

// Hard strategy constants (derived from trade data analysis)
const MAX_FILL_PRICE = 0.48;       // Only buy tokens below 48c (contrarian/cheap side)
const MIN_MINUTES_REMAINING = 10;  // Only enter with 10+ min remaining (15+ is ideal; 10 gives buffer)

async function handleOrderFlowSignal(signal: OrderFlowSignal): Promise<void> {
  if (!signal.entryDirection) return;

  // ── STRATEGY GATE 1: Time remaining ──
  // Data shows <15 min entries have 0-28% win rate. Only enter with enough time.
  if (signal.minutesUntilWindowEnd < MIN_MINUTES_REMAINING) {
    console.log(
      `[OrderFlow] SKIP: ${signal.asset} ${signal.entryDirection} — ` +
      `only ${signal.minutesUntilWindowEnd.toFixed(1)} min left (need ${MIN_MINUTES_REMAINING}+)`
    );
    return;
  }

  // Early check: fetch fresh mid price to reject expired/decided markets.
  const { fetchCurrentMidPrice: fetchMidEarly } = await import('./execute-polymarket');
  const earlyMid = await fetchMidEarly(signal.yesTokenId);
  if (earlyMid !== null && (earlyMid > 0.85 || earlyMid < 0.15)) {
    console.log(
      `[OrderFlow] SKIP: ${signal.asset} mid=${earlyMid.toFixed(4)} — market already decided`
    );
    return;
  }

  // ── STRATEGY GATE 2: Fill price check ──
  // Compute what we'd actually pay for the token we want to buy.
  // YES token cost = mid price; NO token cost = 1 - mid price.
  const currentMidEarly = earlyMid ?? signal.midPrice;
  const expectedFillPrice = signal.entryDirection === 'YES'
    ? currentMidEarly
    : (1 - currentMidEarly);

  if (expectedFillPrice > MAX_FILL_PRICE) {
    console.log(
      `[OrderFlow] SKIP: ${signal.asset} ${signal.entryDirection} — ` +
      `expected fill ${(expectedFillPrice * 100).toFixed(1)}c > ${(MAX_FILL_PRICE * 100).toFixed(0)}c cap ` +
      `(mid=${currentMidEarly.toFixed(3)})`
    );
    return;
  }

  const isDryRun = isPolyDryRun();
  const mode = isDryRun ? 'DRY RUN' : 'LIVE';

  console.log(
    `[OrderFlow] ${mode} Signal: ${signal.asset} ${signal.entryDirection} ` +
    `OFI60=${signal.ofi60s.toFixed(3)} str=${signal.signalStrength.toFixed(2)} ` +
    `large=${signal.largeTradeDetected} fill~${(expectedFillPrice * 100).toFixed(0)}c ` +
    `${signal.minutesUntilWindowEnd.toFixed(0)}min left`
  );

  // Get bankroll
  const bankroll = await getPolyBankroll();

  // Rolling Kelly: use empirical win rate from last 20 CHEAP trades for bet sizing
  // (only count trades that match our strategy filter for accurate sizing)
  const recentTrades = await query<{ status: string }>(
    `SELECT status FROM market_positions
     WHERE platform = 'polymarket'
       AND status IN ('closed_win', 'closed_loss')
       AND fill_price < 0.48
       AND (notes IS NULL OR notes NOT LIKE 'scanner bug%')
       AND (notes IS NULL OR notes NOT LIKE 'Auto-closed%')
     ORDER BY closed_at DESC LIMIT 20`
  );
  const wins = recentTrades.filter(r => r.status === 'closed_win').length;
  const total = recentTrades.length;
  // Use cheap-fill win rate (historically ~58-78%), fallback to 55% if not enough data
  const recentWR = total >= 5 ? wins / total : 0.55;

  // Kelly formula for binary market (win ~= 1x bet at cheap fills)
  // At 45c fill, win pays ~55c profit on 45c risk => odds ~= 1.22x
  const effectiveOdds = (1 - expectedFillPrice) / expectedFillPrice; // e.g., 0.55/0.45 = 1.22
  const rawKelly = Math.max(0, recentWR - (1 - recentWR) / effectiveOdds);

  // Aggressive fractional Kelly: we have a proven 78% edge at cheap fills
  const kellyFraction = recentWR > 0.65 ? 0.50
                       : recentWR > 0.55 ? 0.33
                       : recentWR > 0.50 ? 0.20
                       :                   0.10;

  const betPct = Math.min(rawKelly * kellyFraction, 0.15); // 15% cap (proven edge deserves bigger bets)
  const betSize = Math.max(0.50, bankroll * betPct);        // min $0.50

  // Model probability estimate from OFI
  const ofiToProbShift = signal.ofi60s * 0.25;
  const pModel = signal.entryDirection === 'YES'
    ? Math.min(0.75, Math.max(0.25, 0.50 + ofiToProbShift))
    : Math.min(0.75, Math.max(0.25, 0.50 - ofiToProbShift));

  // Risk gate check
  const riskCheck = await validateTrade({
    platform: 'polymarket',
    category: 'crypto',
    positionSizePct: betSize / bankroll,
    betSize,
    edge: signal.signalStrength * 0.15,
    expectedReturn: signal.signalStrength * 0.10,
    pModel,
    momentumStrength: signal.signalStrength,
  }, bankroll);

  if (!riskCheck.approved) {
    console.log(`[OrderFlow] Risk gate BLOCKED: ${riskCheck.rejectionReason}`);
    return;
  }

  if (isDryRun) {
    const { fetchCurrentMidPrice: fetchMid } = await import('./execute-polymarket');
    const freshMid = await fetchMid(signal.yesTokenId);
    const currentMid = freshMid ?? signal.midPrice;
    // Tight limit: we WANT cheap fills, don't overpay
    const wouldLimit = signal.entryDirection === 'YES'
      ? Math.min(currentMid + 0.01, MAX_FILL_PRICE)
      : Math.min((1 - currentMid) + 0.01, MAX_FILL_PRICE);

    console.log(
      `[OrderFlow] DRY RUN: Would ${signal.entryDirection} on "${signal.question.substring(0, 60)}" ` +
      `$${betSize.toFixed(2)} | OFI=${(signal.ofi60s * 100).toFixed(1)}% | str=${(signal.signalStrength * 100).toFixed(0)}% ` +
      `| mid=${currentMid.toFixed(4)} limit=${wouldLimit.toFixed(4)}`
    );

    if (telegramNotifyFn) {
      try {
        await telegramNotifyFn(
          `[DRY RUN] ORDER FLOW SIGNAL\n` +
          `${signal.asset} ${signal.entryDirection}\n` +
          `OFI: ${(signal.ofi60s * 100).toFixed(1)}% | Strength: ${(signal.signalStrength * 100).toFixed(0)}%\n` +
          `Mid: ${currentMid.toFixed(3)} | Limit: ${wouldLimit.toFixed(3)}\n` +
          `Size: $${betSize.toFixed(2)} | Fill est: ${(expectedFillPrice * 100).toFixed(0)}c\n` +
          `Time left: ${signal.minutesUntilWindowEnd.toFixed(0)} min`
        );
      } catch { /* non-critical */ }
    }
    return;
  }

  // Live execution via CLOB client
  try {
    const { executePolymarketTrade, fetchCurrentMidPrice } = await import('./execute-polymarket');

    const yesTokenId = signal.yesTokenId;
    const freshMid = await fetchCurrentMidPrice(yesTokenId);
    const currentMid = freshMid ?? signal.midPrice;

    if (freshMid !== null) {
      console.log(`[OrderFlow] Fresh midPrice: ${freshMid.toFixed(4)} (was ${signal.midPrice.toFixed(4)} from discovery)`);
    } else {
      console.warn(`[OrderFlow] Could not fetch fresh midPrice, using stale: ${signal.midPrice.toFixed(4)}`);
    }

    // Re-check fill price with fresh mid (may have moved since early check)
    const freshFillPrice = signal.entryDirection === 'YES'
      ? currentMid
      : (1 - currentMid);

    if (freshFillPrice > MAX_FILL_PRICE) {
      console.log(
        `[OrderFlow] SKIP (fresh price): ${signal.asset} ${signal.entryDirection} — ` +
        `fill ${(freshFillPrice * 100).toFixed(1)}c > ${(MAX_FILL_PRICE * 100).toFixed(0)}c cap`
      );
      return;
    }

    // Tight limit price: cap at MAX_FILL_PRICE to ensure we only get cheap fills
    // +1c offset to cross spread, but never above our max fill cap
    const limitPriceOverride = signal.entryDirection === 'YES'
      ? Math.min(currentMid + 0.01, MAX_FILL_PRICE)
      : Math.min((1 - currentMid) + 0.01, MAX_FILL_PRICE);

    const candidate = {
      id: signal.conditionId,
      platform: 'polymarket' as const,
      question: signal.question,
      category: 'crypto',
      asset: signal.asset,
      url: '',
      pYes: currentMid,
      pLmsr: currentMid,
      pBayes: pModel,
      edge: signal.signalStrength * 0.15,
      direction: signal.entryDirection as 'YES' | 'NO',
      betAmount: betSize,
      kellyFrac: rawKelly * kellyFraction,
      expectedRet: signal.signalStrength * 0.10,
      score: signal.signalStrength,
      resolutionMinutes: signal.windowMinutes,
      intelAligned: false,
      intelSignalId: null,
      reasoning: `Order flow signal: OFI60=${signal.ofi60s.toFixed(3)}, strength=${signal.signalStrength.toFixed(2)}, large_trade=${signal.largeTradeDetected}, fill~${(expectedFillPrice * 100).toFixed(0)}c, ${signal.minutesUntilWindowEnd.toFixed(0)}min left`,
      yesTokenId: signal.yesTokenId,
      noTokenId: signal.noTokenId,
      yesDepth: 0,
      noDepth: 0,
      totalLiquidity: 0,
      volume24h: 0,
      pAfterMomentum: pModel,
      priceMomentum: null,
      priceReturn5m: null,
      momentumStrength: signal.signalStrength,
      intelSentiment: null,
      intelSignalCount: null,
      grossEdge: signal.signalStrength * 0.15,
      netEdge: signal.signalStrength * 0.12,
      takerFeePct: 0.025,
      conditionId: signal.conditionId,
      negRisk: false,
      tickSize: '0.01',
      minOrderSize: 5,
      limitPriceOverride,
    };

    console.log(`[OrderFlow] Limit price: ${limitPriceOverride.toFixed(4)} (${signal.entryDirection}, mid=${currentMid.toFixed(4)}, cap=${MAX_FILL_PRICE})`);

    const result = await executePolymarketTrade(candidate, bankroll);
  } catch (err: any) {
    console.error(`[OrderFlow] Execution error: ${err.message}`);
  }
}

/**
 * Market discovery handler: refresh the order flow scanner's watch list.
 * Schedule: every 30 minutes via cron.
 */
export async function handleMarketDiscovery(): Promise<string> {
  if (!config.POLYMARKET_API_KEY) {
    return 'POLYMARKET_API_KEY not configured. Discovery skipped.';
  }

  const markets = await discoverActiveUpDownMarkets();

  if (!orderFlowStarted && markets.length > 0) {
    // First discovery cycle: start the scanner
    await orderFlowService.start(markets);
    orderFlowStarted = true;
    return `Market discovery: started order flow scanner with ${markets.length} markets.`;
  }

  if (markets.length > 0) {
    await orderFlowService.updateMarkets(markets);
  }

  const status = orderFlowService.getStatus();
  return `Market discovery: ${markets.length} active markets. WebSocket ${status.connected ? 'connected' : 'disconnected'}, tracking ${status.tradesTracked} trades.`;
}

/**
 * Manifold scan: fetch markets, analyze with Claude, execute trades
 * Schedule: every 4 hours during waking hours MT
 */
export async function handleManifoldScan(taskId: number): Promise<string> {
  // Validate models on first scan
  if (!modelsValidated) {
    const access = await validateModelAccess();
    modelsValidated = true;
    if (!access.scan) {
      return `SCAN MODEL UNREACHABLE: ${config.PREDICT_SCAN_MODEL}. Skipping scan.`;
    }
    if (!access.reviewer) {
      console.warn(`[PredictCron] Reviewer model unreachable: ${config.PREDICT_REVIEWER_MODEL}. Weekly reviews will fail.`);
    }
  }

  if (!config.MANIFOLD_API_KEY) {
    return 'MANIFOLD_API_KEY not configured. Scan skipped.';
  }

  // Fetch and filter markets
  const candidates = await scanManifold();
  if (candidates.length === 0) {
    return 'No candidate markets found.';
  }

  // Get current bankroll
  const bankroll = await getCurrentBankroll('manifold');

  // Analyze with Claude
  const analyzed = await analyzeMarkets(candidates, bankroll, taskId);

  // Execute top opportunities
  let tradesOpened = 0;
  let tradesBlocked = 0;

  for (const market of analyzed) {
    // Only trade if edge is positive and meaningful (YES bets only)
    if (market.edge < 0.04) continue; // Skip negative-edge / low-edge markets
    if (market.betAmount < 1) continue;

    const result = await executeTrade(market, bankroll);
    if (result.success) {
      tradesOpened++;
      if (tradesOpened >= 3) break; // Max 3 trades per scan cycle
    } else if (result.riskRejection) {
      tradesBlocked++;
      if (result.riskRejection === 'trading_not_paused') break; // Stop if paused
    }
  }

  return `Scanned ${candidates.length} markets, analyzed ${analyzed.length}, opened ${tradesOpened} trades, ${tradesBlocked} blocked by risk gate. Bankroll: M$${bankroll.toFixed(0)}`;
}

/**
 * Equity snapshot: record current balance and stats for ALL platforms
 * Schedule: every 15 minutes
 */
export async function handleEquitySnapshot(taskId: number): Promise<string> {
  const results: string[] = [];

  // Snapshot each active platform
  for (const platform of ['manifold', 'polymarket'] as const) {
    try {
      let bankroll: number;
      if (platform === 'manifold') {
        if (!config.MANIFOLD_API_KEY) continue;
        bankroll = await getCurrentBankroll(platform);
      } else {
        if (!config.POLYMARKET_API_KEY) continue;
        bankroll = await getPolyBankroll();
      }

      // Get open positions
      const openPos = await queryOne<{ count: string; total: string }>(
        `SELECT COUNT(*) as count, COALESCE(SUM(bet_size), 0) as total
         FROM market_positions WHERE platform = $1 AND status = 'open'`,
        [platform]
      );

      // Get win rate (exclude scanner bug positions and early bugged trades)
      const stats = await queryOne<any>(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('closed_win', 'closed_loss')) as total,
           COUNT(*) FILTER (WHERE status = 'closed_win') as wins
         FROM market_positions
         WHERE platform = $1
           AND (notes IS NULL OR notes NOT LIKE 'scanner bug%')
           AND (notes IS NULL OR notes NOT LIKE 'Auto-closed: market expired%')`,
        [platform]
      );

      const totalTrades = parseInt(stats?.total || '0');
      const wins = parseInt(stats?.wins || '0');
      const winRate = totalTrades > 0 ? wins / totalTrades : 0;
      const unrealizedPnl = 0; // TODO: calculate from open positions
      const totalEquity = bankroll + unrealizedPnl;

      await query(
        `INSERT INTO equity_snapshots (platform, bankroll, unrealized_pnl, total_equity, positions_open, win_rate, total_trades)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [platform, bankroll, unrealizedPnl, totalEquity, parseInt(openPos?.count || '0'), winRate, totalTrades]
      );

      const prefix = platform === 'manifold' ? 'M$' : '$';
      results.push(`${platform}: ${prefix}${totalEquity.toFixed(2)} | ${parseInt(openPos?.count || '0')} open | ${totalTrades} trades (${(winRate * 100).toFixed(1)}% WR)`);
    } catch (err: any) {
      results.push(`${platform}: snapshot failed: ${err.message}`);
    }
  }

  return `Equity: ${results.join(' | ')}`;
}

/**
 * Daily risk reset: new day, new counters
 * Schedule: 6am MT (13:00 UTC)
 */
export async function handleDailyRiskReset(): Promise<string> {
  const manifoldBankroll = await getCurrentBankroll('manifold');
  await resetDailyRisk('manifold', manifoldBankroll);

  let polyMsg = '';
  if (config.POLYMARKET_API_KEY) {
    const polyBankroll = await getPolyBankroll();
    await resetDailyRisk('polymarket', polyBankroll);
    polyMsg = ` | Polymarket: $${polyBankroll.toFixed(2)}`;
  }

  return `Daily risk reset. Manifold: M$${manifoldBankroll.toFixed(0)}${polyMsg}`;
}

/**
 * Resolution check: poll open positions for market resolution,
 * redeem winning tokens, and sync bankroll to wallet.
 * Schedule: every 30 minutes (Manifold) + every 5 minutes (Polymarket)
 */
export async function handleResolutionCheck(taskId: number): Promise<string> {
  const parts: string[] = [];

  // Manifold resolution
  const manifold = await reconcilePositions('manifold');
  if (manifold.closed > 0) {
    parts.push(`Manifold: ${manifold.closed} resolved (${manifold.wins}W/${manifold.losses}L, ${manifold.totalPnl >= 0 ? '+' : ''}$${manifold.totalPnl.toFixed(2)})`);
  }

  // Polymarket resolution (5-15 min markets need frequent checking)
  if (config.POLYMARKET_API_KEY) {
    const poly = await reconcilePolymarketPositions();
    if (poly.closed > 0) {
      parts.push(`Polymarket: ${poly.closed} resolved (${poly.wins}W/${poly.losses}L, ${poly.totalPnl >= 0 ? '+' : ''}$${poly.totalPnl.toFixed(2)})`);
    }
    if (poly.checked > 0 && poly.closed === 0) {
      parts.push(`Polymarket: ${poly.checked} open, none resolved yet`);
    }

    // Redeem winning conditional tokens (ERC-1155 -> USDC.e)
    // Must happen AFTER reconciliation so positions are marked as closed_win first.
    try {
      const { redeemAllWinnings, syncBankrollToWallet } = await import('./execute-polymarket');
      const redemption = await redeemAllWinnings();
      if (redemption.redeemed > 0) {
        parts.push(`Redeemed ${redemption.redeemed} wins (~$${redemption.totalUSDC.toFixed(2)})`);
      }
      if (redemption.errors.length > 0) {
        console.warn(`[PredictCron] Redemption errors: ${redemption.errors.join('; ')}`);
      }

      // Sync bankroll to actual wallet balance (fixes drift from missed redemptions)
      const walletBalance = await syncBankrollToWallet();
      if (walletBalance !== null && parts.length > 0) {
        parts.push(`Wallet: $${walletBalance.toFixed(2)}`);
      }
    } catch (err: any) {
      console.error('[PredictCron] Redemption/sync error:', err.message);
    }
  }

  if (parts.length === 0) {
    return `Checked ${manifold.checked} Manifold positions. None resolved.`;
  }

  return parts.join(' | ');
}

/**
 * Weekly hypothesis review: Claude-powered learning
 * Schedule: Sunday 8am MT (14:00 UTC)
 */
export async function handleHypothesisReview(taskId: number): Promise<string> {
  // This function throws on failure (loud, not swallowed)
  return await runWeeklyReview(taskId);
}

/**
 * Polymarket scan: fetch 5-min crypto markets, analyze with LMSR+Bayes, execute trades
 * Schedule: every 3 minutes during waking hours MT
 */
export async function handlePolymarketScan(taskId: number): Promise<string> {
  if (!config.POLYMARKET_API_KEY) {
    return 'POLYMARKET_API_KEY not configured. Scan skipped.';
  }

  // Scan trigger: require either price momentum OR strong intel signals.
  // Price momentum: at least one asset with momentumStrength > 0.2
  // Intel signals: at least one asset with strong bearish or bullish signal (>= 0.5)
  // This lets intel-driven trades fire even in flat markets (e.g., macro bearish
  // news shifts the Bayesian prior, creating edge on NO bets without price movement).
  const signals = ['BTC', 'ETH', 'SOL', 'XRP'].map(a => priceFeed.getSignal(a));
  const hasAnyMomentum = signals.some(s =>
    s && s.momentum !== 'neutral' && s.momentumStrength > 0.2
  );

  // Check for strong intel signals (bearish or bullish >= 0.5 strength)
  let hasStrongIntel = false;
  if (!hasAnyMomentum) {
    const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
    for (const asset of assets) {
      const intel = await getIntelSummary(asset);
      if (intel && (intel.bearishStrength >= 0.5 || intel.bullishStrength >= 0.5)) {
        hasStrongIntel = true;
        console.log(`[PolyScan] Intel trigger: ${asset} has ${intel.bearishStrength >= 0.5 ? 'bearish' : 'bullish'} signal (str=${Math.max(intel.bearishStrength, intel.bullishStrength).toFixed(2)})`);
        break;
      }
    }
  }

  if (!hasAnyMomentum && !hasStrongIntel) {
    console.log('[PolyScan] Skipped — no momentum and no strong intel signals');
    return 'Scan skipped — no momentum signal and no strong intel. All quiet.';
  }

  // Update cooldown timestamp (prevents momentum watcher from re-triggering)
  lastFullScanAt = Date.now();

  // Fetch and filter markets
  const candidates = await scanPolymarket();
  if (candidates.length === 0) {
    return 'No Polymarket candidates found.';
  }

  // Get current bankroll
  const bankroll = await getPolyBankroll();

  // Execute top opportunities
  let tradesOpened = 0;
  let tradesBlocked = 0;
  let dryRunCount = 0;

  for (const market of candidates) {
    if (market.netEdge < 0.06) continue; // 6c net edge threshold (LMSR removed, signal-only edge)
    if (market.betAmount < 0.50) continue;

    // ── STRATEGY FILTER: cheap fills only ──
    // Data shows only <48c fills are profitable (77.8% WR vs 28-37% for expensive fills).
    // contractPrice = cost of the token we're buying (YES price or 1 - YES price for NO).
    const contractPrice = market.direction === 'YES' ? market.pYes : (1 - market.pYes);
    if (contractPrice > MAX_FILL_PRICE) {
      console.log(`[PolyScan] SKIP: ${market.question.substring(0, 50)} ${market.direction} — fill ${(contractPrice * 100).toFixed(0)}c > ${(MAX_FILL_PRICE * 100).toFixed(0)}c cap`);
      continue;
    }

    // ── STRATEGY FILTER: enough time remaining ──
    if (market.resolutionMinutes < MIN_MINUTES_REMAINING) {
      console.log(`[PolyScan] SKIP: ${market.question.substring(0, 50)} — only ${market.resolutionMinutes}min left`);
      continue;
    }

    const result = await executePolymarketTrade(market, bankroll);
    if (result.success) {
      if (result.dryRun) {
        dryRunCount++;
      } else {
        tradesOpened++;
      }
      // Mark scan as acted on for dashboard labeling
      query(
        `UPDATE market_scans SET acted_on = true
         WHERE market_id = $1 AND scanned_at > NOW() - INTERVAL '10 minutes'
         AND acted_on = false`,
        [market.id]
      ).catch(() => {});
      if (tradesOpened >= 2) break; // Max 2 trades per 3-min scan cycle
    } else if (result.riskRejection) {
      tradesBlocked++;
      if (result.riskRejection === 'trading_not_paused') break;
    }
  }

  const mode = isPolyDryRun() ? 'DRY RUN' : 'LIVE';
  let result = `[${mode}] Polymarket: ${candidates.length} mkts scanned, ${tradesOpened} traded, ${tradesBlocked} blocked. Bankroll: $${bankroll.toFixed(2)}`;

  // Telemetry: log top 3 candidates with their edge and why they were blocked
  const topThree = candidates.slice(0, 3);
  for (const c of topThree) {
    const netEdgeC = (c.netEdge * 100).toFixed(0);
    const betC = c.betAmount.toFixed(2);
    const assetQ = c.question.substring(0, 40);
    console.log(`[PolyScan] Candidate: ${assetQ}... | edge=${netEdgeC}c | bet=$${betC} | dir=${c.direction}`);
  }

  // Check if /predict golive wait is active and we found a qualifying candidate (net edge >= 6c)
  const topCandidate = candidates.find(c => c.netEdge >= 0.06);
  if (topCandidate) {
    const notification = checkEdgeCandidateNotification(
      topCandidate.netEdge,
      topCandidate.question,
    );
    if (notification.shouldNotify) {
      result += `\n__EDGE_NOTIFY__${notification.message}`;
    }
  }

  return result;
}

/**
 * Daily summary: aggregate stats from the day, send to Telegram
 * Schedule: 9am MT (15:00 UTC)
 */
export async function handleDailySummary(): Promise<string> {
  // Polymarket scan count today
  const scanStats = await queryOne<any>(
    `SELECT COUNT(*) as total FROM cron_runs cr
     JOIN cron_jobs cj ON cr.cron_job_id = cj.id
     WHERE cj.name = 'Predict Polymarket Scan'
       AND cr.started_at >= CURRENT_DATE
       AND cr.status = 'success'`
  );

  // Dry-run and live trade counts today
  const tradeStats = await queryOne<any>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('open', 'closed_win', 'closed_loss', 'dry_run')) as total,
       COUNT(*) FILTER (WHERE status = 'dry_run') as dry_runs,
       COUNT(*) FILTER (WHERE status IN ('open', 'closed_win', 'closed_loss')) as live
     FROM market_positions
     WHERE platform = 'polymarket'
       AND created_at >= CURRENT_DATE`
  );

  // Manifold trade counts today
  const manifoldStats = await queryOne<any>(
    `SELECT COUNT(*) as total FROM market_positions
     WHERE platform = 'manifold' AND created_at >= CURRENT_DATE`
  );

  // Phase gate progress
  const gateStats = await queryOne<any>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('closed_win', 'closed_loss')) as trades,
       COUNT(*) FILTER (WHERE status = 'closed_win') as wins
     FROM market_positions
     WHERE platform = 'polymarket'
       AND (notes IS NULL OR notes NOT LIKE 'scanner bug%')`
  );

  // API cost today
  const costStats = await queryOne<any>(
    `SELECT COALESCE(SUM(cost_cents), 0) as total_cents FROM cost_events
     WHERE created_at >= CURRENT_DATE`
  );

  const scanCount = parseInt(scanStats?.total || '0');
  const dryRunCandidates = parseInt(tradeStats?.dry_runs || '0');
  const liveTradesExecuted = parseInt(tradeStats?.live || '0');
  const manifoldTrades = parseInt(manifoldStats?.total || '0');
  const gateTrades = parseInt(gateStats?.trades || '0');
  const gateWins = parseInt(gateStats?.wins || '0');
  const winRate = gateTrades > 0 ? (gateWins / gateTrades * 100).toFixed(1) : '0.0';
  const costUsd = (parseInt(costStats?.total_cents || '0') / 100).toFixed(3);

  const today = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', timeZone: 'America/Denver',
  });

  const summary = [
    `PREDICT DAILY SUMMARY \u2014 ${today}`,
    '\u2501'.repeat(24),
    `Polymarket scans:    ${scanCount}`,
    `Dry-run candidates:  ${dryRunCandidates}`,
    `Trades executed:     ${liveTradesExecuted}`,
    `Manifold trades:     ${manifoldTrades}`,
    '',
    `Phase gate:    ${gateTrades}/15 trades  ${winRate}% WR`,
    `API cost today: $${costUsd}`,
  ].join('\n');

  return summary;
}

async function getPolyBankroll(): Promise<number> {
  // Wallet balance + open position exposure = true bankroll.
  // Wallet alone under-reports when USDC is locked in CLOB orders.
  const balance = await getUSDCBalance();
  if (balance !== null && balance >= 0.01) {
    const openExposure = await queryOne<{ total: string }>(
      `SELECT COALESCE(SUM(bet_size), 0) as total FROM market_positions WHERE platform = 'polymarket' AND status = 'open'`,
      []
    );
    const locked = parseFloat(openExposure?.total || '0');
    return balance + locked;
  }

  // Fallback to daily risk state if wallet check fails
  const todayStr = new Date().toISOString().split('T')[0];
  const risk = await queryOne<any>(
    `SELECT current_bankroll FROM daily_risk_state WHERE date = $1 AND platform = 'polymarket'`,
    [todayStr]
  );

  if (risk) return parseFloat(risk.current_bankroll);

  // Default
  return config.PREDICT_POLY_STARTING_BANKROLL;
}
