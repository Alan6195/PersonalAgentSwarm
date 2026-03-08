/**
 * Predict Agent: Trade Execution
 *
 * Phase 1: Manifold Markets only.
 * Handles bet placement, position tracking, and market resolution reconciliation.
 */

import { config } from '../../config';
import { query, queryOne } from '../../db';
import { validateTrade, recordTradeOpened, recordTradeClosed, updateDailyRisk, type TradeCandidate } from './risk-gate';
import { maybeLogHypothesis } from './learn';
import type { AnalyzedMarket } from './scan';

const MANIFOLD_BASE = 'https://api.manifold.markets/v0';

export interface TradeResult {
  success: boolean;
  positionId?: number;
  betId?: string;
  error?: string;
  riskRejection?: string;
}

export interface ReconcileResult {
  checked: number;
  closed: number;
  wins: number;
  losses: number;
  totalPnl: number;
}

// ── Trade Execution ──────────────────────────────────────────────────

/**
 * Execute a trade on an analyzed market (runs risk gate first)
 */
export async function executeTrade(market: AnalyzedMarket, bankroll: number): Promise<TradeResult> {
  const direction = market.edge > 0 ? 'YES' : 'NO';
  const decimalOdds = direction === 'YES' ? 1 / market.pYes : 1 / (1 - market.pYes);

  // Risk gate check
  const candidate: TradeCandidate = {
    platform: market.platform,
    category: market.category,
    positionSizePct: market.betAmount / bankroll,
    betSize: market.betAmount,
    edge: market.edge,
    expectedReturn: market.expectedRet,
    pModel: market.pModel,
  };

  const riskCheck = await validateTrade(candidate, bankroll);
  if (!riskCheck.approved) {
    console.log(`[Execute] Risk gate BLOCKED: ${market.question.substring(0, 50)} (reason: ${riskCheck.rejectionReason})`);
    return { success: false, riskRejection: riskCheck.rejectionReason };
  }

  // Place bet on Manifold
  if (market.platform === 'manifold') {
    return await placeManifoldBet(market, direction, riskCheck.betSize, bankroll);
  }

  return { success: false, error: `Platform ${market.platform} not supported in Phase 1` };
}

/**
 * Place a bet on Manifold Markets
 */
async function placeManifoldBet(
  market: AnalyzedMarket,
  direction: 'YES' | 'NO',
  amount: number,
  bankroll: number,
): Promise<TradeResult> {
  if (!config.MANIFOLD_API_KEY) {
    return { success: false, error: 'MANIFOLD_API_KEY not configured' };
  }

  console.log(`[Execute] Placing Manifold bet: ${direction} on "${market.question.substring(0, 60)}" for M$${amount.toFixed(2)}`);

  try {
    const res = await fetch(`${MANIFOLD_BASE}/bet`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${config.MANIFOLD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contractId: market.id,
        outcome: direction,
        amount: Math.round(amount), // Manifold uses integer mana
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Execute] Manifold bet failed: ${res.status} ${errText}`);
      return { success: false, error: `Manifold API ${res.status}: ${errText.substring(0, 200)}` };
    }

    const bet = await res.json() as any;

    // Record position in DB
    const rows = await query<{ id: number }>(
      `INSERT INTO market_positions
       (platform, market_id, market_url, question, category, asset, direction,
        p_market, p_model, edge, kelly_fraction, bet_size, fill_price,
        reward_score, expected_return, intel_signal_id, intel_aligned,
        reasoning, scan_id, bet_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               (SELECT id FROM market_scans WHERE market_id = $2 ORDER BY scanned_at DESC LIMIT 1),
               $19)
       RETURNING id`,
      [
        market.platform, market.id, market.url, market.question, market.category,
        market.asset || null, direction,
        market.pYes, market.pModel, market.edge, market.kellyFrac,
        amount, parseFloat(bet.probAfter) || market.pYes,
        market.score, market.expectedRet,
        market.intelSignalId, market.intelAligned,
        market.reasoning,
        bet.id || null,
      ]
    );

    const positionId = rows[0]?.id;

    // Update risk state
    await recordTradeOpened(market.platform, amount, bankroll);

    // Mark intel signals as consumed
    if (market.intelSignalId) {
      await query(
        `UPDATE shared_signals SET consumed_by_predict = true WHERE id = $1`,
        [market.intelSignalId]
      ).catch(() => {});
    }

    console.log(`[Execute] Trade opened: position #${positionId}, ${direction} @ ${market.pYes.toFixed(4)}, M$${amount.toFixed(0)}`);

    return { success: true, positionId, betId: bet.id };
  } catch (err) {
    console.error(`[Execute] Manifold bet error:`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

// ── Position Reconciliation ──────────────────────────────────────────

/**
 * Check all open positions for market resolution and calculate P&L.
 * Fully implemented for Manifold: polls GET /v0/market/{id} for each open position.
 */
export async function reconcilePositions(platform: string): Promise<ReconcileResult> {
  const openPositions = await query<any>(
    `SELECT * FROM market_positions WHERE platform = $1 AND status = 'open'`,
    [platform]
  );

  const result: ReconcileResult = { checked: openPositions.length, closed: 0, wins: 0, losses: 0, totalPnl: 0 };

  if (openPositions.length === 0) return result;

  console.log(`[Execute] Checking ${openPositions.length} open ${platform} positions for resolution`);

  for (const pos of openPositions) {
    try {
      if (platform === 'manifold') {
        const resolved = await checkManifoldResolution(pos);
        if (resolved) {
          result.closed++;
          result.totalPnl += resolved.pnl;
          if (resolved.outcome === 'win') result.wins++;
          else result.losses++;
        }
      }
    } catch (err) {
      console.warn(`[Execute] Failed to check position #${pos.id}:`, (err as Error).message);
    }

    // Update resolution_checked_at regardless
    await query(
      `UPDATE market_positions SET resolution_checked_at = NOW() WHERE id = $1`,
      [pos.id]
    ).catch(() => {});
  }

  if (result.closed > 0) {
    console.log(`[Execute] Reconciled: ${result.closed} closed (${result.wins}W/${result.losses}L), P&L: ${result.totalPnl >= 0 ? '+' : ''}${result.totalPnl.toFixed(2)}`);
  }

  return result;
}

interface ResolutionResult {
  outcome: 'win' | 'loss';
  pnl: number;
  pnlPct: number;
  exitProb: number;
}

async function checkManifoldResolution(position: any): Promise<ResolutionResult | null> {
  const res = await fetch(`${MANIFOLD_BASE}/market/${position.market_id}`);
  if (!res.ok) {
    console.warn(`[Execute] Manifold market fetch failed for ${position.market_id}: ${res.status}`);
    return null;
  }

  const market = await res.json() as any;

  // Not resolved yet
  if (!market.isResolved) return null;

  const resolution = market.resolution; // 'YES', 'NO', 'CANCEL', 'MKT'
  const resolutionProb = market.resolutionProbability ?? (resolution === 'YES' ? 1.0 : 0.0);

  // Calculate P&L
  let pnl: number;
  let outcome: 'win' | 'loss';
  const betSize = parseFloat(position.bet_size);
  const entryProb = parseFloat(position.p_market);

  if (resolution === 'CANCEL') {
    // Cancelled market: no P&L
    pnl = 0;
    outcome = 'loss'; // treat as loss for tracking
  } else if (resolution === 'MKT') {
    // Probabilistic resolution
    if (position.direction === 'YES') {
      pnl = betSize * (resolutionProb / entryProb - 1);
    } else {
      pnl = betSize * ((1 - resolutionProb) / (1 - entryProb) - 1);
    }
    outcome = pnl >= 0 ? 'win' : 'loss';
  } else {
    // Binary resolution (YES or NO)
    const resolvedYes = resolution === 'YES';
    const bettedRight = (position.direction === 'YES' && resolvedYes) || (position.direction === 'NO' && !resolvedYes);

    if (bettedRight) {
      // Win: payout = betSize / entryProb (for YES) or betSize / (1-entryProb) (for NO)
      const impliedProb = position.direction === 'YES' ? entryProb : (1 - entryProb);
      pnl = betSize * (1 / impliedProb - 1);
      outcome = 'win';
    } else {
      // Loss: lose entire bet
      pnl = -betSize;
      outcome = 'loss';
    }
  }

  const pnlPct = betSize > 0 ? (pnl / betSize) * 100 : 0;
  const status = outcome === 'win' ? 'closed_win' : 'closed_loss';

  // Update position
  await query(
    `UPDATE market_positions
     SET status = $1, outcome = $2, pnl = $3, pnl_pct = $4, exit_prob = $5,
         closed_at = NOW()
     WHERE id = $6`,
    [status, outcome, pnl, pnlPct, resolutionProb, position.id]
  );

  // Update daily risk
  try {
    const currentBankroll = await getCurrentBankroll(position.platform);
    await updateDailyRisk(position.platform, pnl, currentBankroll);
    await recordTradeClosed(position.platform, betSize, currentBankroll);
  } catch (err) {
    console.warn(`[Execute] Failed to update risk state for position #${position.id}:`, (err as Error).message);
  }

  // Fire-and-forget: log hypothesis evidence
  maybeLogHypothesis({
    positionId: position.id,
    category: position.category || 'other',
    direction: position.direction,
    edge: parseFloat(position.edge),
    pnlPct,
    marketQuestion: position.question,
    intelAligned: position.intel_aligned,
  }).catch(err => console.warn(`[Execute] Hypothesis logging failed:`, (err as Error).message));

  console.log(`[Execute] Position #${position.id} resolved: ${outcome.toUpperCase()} | P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);

  return { outcome, pnl, pnlPct, exitProb: resolutionProb };
}

// ── Balance ──────────────────────────────────────────────────────────

/**
 * Get current Manifold balance
 */
export async function getManifoldBalance(): Promise<number | null> {
  if (!config.MANIFOLD_API_KEY) return null;

  try {
    const res = await fetch(`${MANIFOLD_BASE}/me`, {
      headers: { 'Authorization': `Key ${config.MANIFOLD_API_KEY}` },
    });
    if (!res.ok) return null;
    const user = await res.json() as any;
    return user.balance ?? null;
  } catch {
    return null;
  }
}

/**
 * Get current bankroll from latest daily risk state or Manifold balance
 */
export async function getCurrentBankroll(platform: string): Promise<number> {
  // Try daily risk state first
  const todayStr = new Date().toISOString().split('T')[0];
  const risk = await queryOne<any>(
    `SELECT current_bankroll FROM daily_risk_state WHERE date = $1 AND platform = $2`,
    [todayStr, platform]
  );

  if (risk) return parseFloat(risk.current_bankroll);

  // Fall back to Manifold balance
  if (platform === 'manifold') {
    const balance = await getManifoldBalance();
    if (balance !== null) return balance;
  }

  // Default starting bankroll
  return 1000;
}

/**
 * Get trade statistics for phase gate check
 */
export async function getTradeStats(platform: string): Promise<{
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  sharpe: number;
}> {
  const stats = await queryOne<any>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('closed_win', 'closed_loss')) as total_trades,
       COUNT(*) FILTER (WHERE status = 'closed_win') as wins,
       COUNT(*) FILTER (WHERE status = 'closed_loss') as losses,
       COALESCE(SUM(pnl) FILTER (WHERE status IN ('closed_win', 'closed_loss')), 0) as total_pnl
     FROM market_positions WHERE platform = $1`,
    [platform]
  );

  const totalTrades = parseInt(stats?.total_trades || '0');
  const wins = parseInt(stats?.wins || '0');
  const losses = parseInt(stats?.losses || '0');
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const totalPnl = parseFloat(stats?.total_pnl || '0');

  // Compute Sharpe from equity snapshots (daily returns)
  const sharpe = await computeSharpe(platform);

  return { totalTrades, wins, losses, winRate, totalPnl, sharpe };
}

async function computeSharpe(platform: string): Promise<number> {
  const snapshots = await query<any>(
    `SELECT total_equity, snapshot_at
     FROM equity_snapshots
     WHERE platform = $1
     ORDER BY snapshot_at ASC`,
    [platform]
  );

  if (snapshots.length < 2) return 0;

  // Compute daily returns
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = parseFloat(snapshots[i - 1].total_equity);
    const curr = parseFloat(snapshots[i].total_equity);
    if (prev > 0) returns.push((curr - prev) / prev);
  }

  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize: assume ~365 snapshots/year (one per day-ish)
  return (mean / stdDev) * Math.sqrt(365);
}
