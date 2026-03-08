/**
 * Predict Agent: Cron Handlers
 *
 * Handler functions called by cron-scheduler.ts for each predict cron job.
 * Each follows the same pattern as Memory Maintenance / Analytics Snapshot handlers.
 */

import { scanManifold, analyzeMarkets, validateModelAccess } from './scan';
import { executeTrade, reconcilePositions, getCurrentBankroll, getManifoldBalance } from './execute';
import { scanPolymarket } from './scan-polymarket';
import { executePolymarketTrade, getUSDCBalance } from './execute-polymarket';
import { resetDailyRisk } from './risk-gate';
import { runWeeklyReview } from './learn';
import { query, queryOne } from '../../db';
import { config } from '../../config';

let modelsValidated = false;

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
 * Schedule: every 30 minutes
 */
export async function handleResolutionCheck(taskId: number): Promise<string> {
  const result = await reconcilePositions('manifold');

  if (result.closed === 0) {
    return `Checked ${result.checked} positions. None resolved.`;
  }

  return `Checked ${result.checked} positions. ${result.closed} resolved: ${result.wins}W/${result.losses}L, P&L: ${result.totalPnl >= 0 ? '+' : ''}${result.totalPnl.toFixed(2)}`;
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
    if (market.edge < 0.04) continue;
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

  const mode = config.PREDICT_POLY_DRY_RUN ? 'DRY RUN' : 'LIVE';
  return `[${mode}] Polymarket: ${candidates.length} markets, ${tradesOpened} trades, ${dryRunCount} dry-run, ${tradesBlocked} blocked. Bankroll: $${bankroll.toFixed(2)}`;
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
