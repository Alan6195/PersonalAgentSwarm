/**
 * Predict Agent: Cron Handlers
 *
 * Handler functions called by cron-scheduler.ts for each predict cron job.
 * Each follows the same pattern as Memory Maintenance / Analytics Snapshot handlers.
 */

import { scanManifold, analyzeMarkets, validateModelAccess } from './scan';
import { executeTrade, reconcilePositions, getCurrentBankroll, getManifoldBalance } from './execute';
import { scanPolymarket } from './scan-polymarket';
import { executePolymarketTrade, getUSDCBalance, reconcilePolymarketPositions } from './execute-polymarket';
import { checkEdgeCandidateNotification } from './telegram';
import { resetDailyRisk } from './risk-gate';
import { runWeeklyReview } from './learn';
import { priceFeed } from './price-feed';
import { getIntelSummary } from './intel-signal';
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
 * Equity snapshot: record current balance and stats
 * Schedule: every 15 minutes
 */
export async function handleEquitySnapshot(taskId: number): Promise<string> {
  const platform = 'manifold';
  const bankroll = await getCurrentBankroll(platform);

  // Get open positions
  const openPos = await queryOne<{ count: string; total: string }>(
    `SELECT COUNT(*) as count, COALESCE(SUM(bet_size), 0) as total
     FROM market_positions WHERE platform = $1 AND status = 'open'`,
    [platform]
  );

  // Get win rate (exclude scanner bug positions)
  const stats = await queryOne<any>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('closed_win', 'closed_loss')) as total,
       COUNT(*) FILTER (WHERE status = 'closed_win') as wins
     FROM market_positions
     WHERE platform = $1
       AND (notes IS NULL OR notes NOT LIKE 'scanner bug%')`,
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

  return `Equity: M$${totalEquity.toFixed(0)} | ${parseInt(openPos?.count || '0')} open | ${totalTrades} total (${(winRate * 100).toFixed(1)}% WR)`;
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
 * Resolution check: poll open positions for market resolution
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

    const result = await executePolymarketTrade(market, bankroll);
    if (result.success) {
      if (result.dryRun) {
        dryRunCount++;
      } else {
        tradesOpened++;
      }
      if (tradesOpened >= 2) break; // Max 2 trades per 3-min scan cycle
    } else if (result.riskRejection) {
      tradesBlocked++;
      if (result.riskRejection === 'trading_not_paused') break;
    }
  }

  const mode = isPolyDryRun() ? 'DRY RUN' : 'LIVE';
  let result = `[${mode}] Polymarket: ${candidates.length} markets, ${tradesOpened} trades, ${dryRunCount} dry-run, ${tradesBlocked} blocked. Bankroll: $${bankroll.toFixed(2)}`;

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
  // Try daily risk state first
  const todayStr = new Date().toISOString().split('T')[0];
  const risk = await queryOne<any>(
    `SELECT current_bankroll FROM daily_risk_state WHERE date = $1 AND platform = 'polymarket'`,
    [todayStr]
  );

  if (risk) return parseFloat(risk.current_bankroll);

  // Try USDC balance
  const balance = await getUSDCBalance();
  if (balance !== null) return balance;

  // Default
  return config.PREDICT_POLY_STARTING_BANKROLL;
}
