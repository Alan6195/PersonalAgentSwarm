/**
 * Predict Agent: Risk Gate
 *
 * Pure TypeScript. NO Claude calls. All deterministic.
 * No trade executes without passing every check.
 *
 * Hard limits that cannot be overridden by any Telegram command or agent reasoning:
 * - Never more than 5% of bankroll on one position
 * - Never more than 20% of bankroll in one category
 * - Never more than 40% of bankroll deployed at once
 * - Pause all trading if down 8% in a single day
 * - Pause all trading if drawdown from peak exceeds 15%
 * - Minimum $1 bet (avoid dust positions)
 * - Minimum 4c edge (below this the model has no reliable signal)
 */

import { query, queryOne } from '../../db';

export interface RiskLimits {
  maxPositionPct: number;
  maxCategoryPct: number;
  maxTotalExposurePct: number;
  dailyLossPausePct: number;
  drawdownPausePct: number;
  minEdge: number;
  minBet: number;
}

export const RISK_LIMITS: RiskLimits = {
  maxPositionPct: 0.05,
  maxCategoryPct: 0.20,
  maxTotalExposurePct: 0.40,
  dailyLossPausePct: 0.08,
  drawdownPausePct: 0.15,
  minEdge: 0.04,
  minBet: 1.00,
};

export interface RiskCheck {
  approved: boolean;
  betSize: number;
  rejectionReason?: string;
  checks: Record<string, boolean>;
}

export interface TradeCandidate {
  platform: string;
  category: string;
  positionSizePct: number;
  betSize: number;
  edge: number;
  expectedReturn: number;
  pModel: number;
}

/**
 * Check if a new trade is allowed by all risk constraints
 */
export async function validateTrade(candidate: TradeCandidate, bankroll: number): Promise<RiskCheck> {
  const { platform, category, betSize, edge, expectedReturn: er, pModel } = candidate;

  // Get current risk state
  const today = await getOrCreateDailyRisk(platform, bankroll);

  // Get current exposure
  const totalExposure = await getTotalOpenExposure(platform);
  const categoryExposure = await getCategoryExposure(platform, category);

  // VaR95 check: probability-space. At 95% confidence, worst-case probability
  // must be no more than 10pp below model estimate.
  const var95 = pModel - 1.645 * Math.sqrt(pModel * (1 - pModel));

  // Max drawdown from peak
  const mdd = today.peak_bankroll > 0
    ? (today.peak_bankroll - today.current_bankroll) / today.peak_bankroll
    : 0;

  const checks: Record<string, boolean> = {
    edge_sufficient: edge >= RISK_LIMITS.minEdge,
    min_bet: betSize >= RISK_LIMITS.minBet,
    max_position: betSize <= bankroll * RISK_LIMITS.maxPositionPct,
    expected_return_positive: er > 0,
    var_within_limit: var95 > -0.10,
    daily_loss_ok: Math.abs(today.daily_loss) < bankroll * RISK_LIMITS.dailyLossPausePct,
    drawdown_ok: mdd < RISK_LIMITS.drawdownPausePct,
    category_exposure_ok: (categoryExposure + betSize) <= bankroll * RISK_LIMITS.maxCategoryPct,
    total_exposure_ok: (totalExposure + betSize) <= bankroll * RISK_LIMITS.maxTotalExposurePct,
    trading_not_paused: !today.trading_paused,
  };

  // Rejection logging
  if (!checks.edge_sufficient) {
    console.error(`[RiskGate] REJECTED: edge ${edge.toFixed(4)} < ${RISK_LIMITS.minEdge}`);
  }
  if (!checks.var_within_limit) {
    console.error(`[RiskGate] REJECTED: VaR95 ${var95.toFixed(4)} < -0.10 (pModel=${pModel.toFixed(4)})`);
  }

  const approved = Object.values(checks).every(Boolean);

  return {
    approved,
    betSize,
    rejectionReason: approved ? undefined : Object.entries(checks).find(([, v]) => !v)?.[0],
    checks,
  };
}

/**
 * Check if the system should pause trading (daily loss or drawdown)
 */
export async function checkSystemPause(platform: string, bankroll: number): Promise<{ paused: boolean; reason: string | null }> {
  const today = await getOrCreateDailyRisk(platform, bankroll);

  if (Math.abs(today.daily_loss) >= bankroll * RISK_LIMITS.dailyLossPausePct) {
    if (!today.trading_paused) {
      await query(
        `UPDATE daily_risk_state SET trading_paused = true, pause_reason = 'daily_loss_limit', updated_at = NOW() WHERE id = $1`,
        [today.id]
      );
    }
    return { paused: true, reason: `Daily loss ${(Math.abs(today.daily_loss) / bankroll * 100).toFixed(1)}% exceeds ${RISK_LIMITS.dailyLossPausePct * 100}% limit` };
  }

  const mdd = today.peak_bankroll > 0
    ? (today.peak_bankroll - today.current_bankroll) / today.peak_bankroll
    : 0;

  if (mdd >= RISK_LIMITS.drawdownPausePct) {
    if (!today.trading_paused) {
      await query(
        `UPDATE daily_risk_state SET trading_paused = true, pause_reason = 'drawdown_limit', updated_at = NOW() WHERE id = $1`,
        [today.id]
      );
    }
    return { paused: true, reason: `Drawdown ${(mdd * 100).toFixed(1)}% exceeds ${RISK_LIMITS.drawdownPausePct * 100}% limit` };
  }

  return { paused: false, reason: null };
}

/**
 * Update daily risk state after a trade
 */
export async function updateDailyRisk(platform: string, pnl: number, bankroll: number): Promise<void> {
  const today = await getOrCreateDailyRisk(platform, bankroll);

  const newBankroll = today.current_bankroll + pnl;
  const newPeak = Math.max(today.peak_bankroll, newBankroll);
  const newDailyPnl = today.daily_pnl + pnl;
  const newDailyLoss = pnl < 0 ? today.daily_loss + pnl : today.daily_loss;
  const newDrawdown = newPeak > 0 ? (newPeak - newBankroll) / newPeak : 0;

  await query(
    `UPDATE daily_risk_state
     SET current_bankroll = $1, peak_bankroll = $2, daily_pnl = $3, daily_loss = $4,
         current_drawdown = $5, updated_at = NOW()
     WHERE id = $6`,
    [newBankroll, newPeak, newDailyPnl, newDailyLoss, newDrawdown, today.id]
  );
}

/**
 * Increment trade counters
 */
export async function recordTradeOpened(platform: string, betSize: number, bankroll: number): Promise<void> {
  const today = await getOrCreateDailyRisk(platform, bankroll);
  const newExposure = today.current_exposure + betSize;

  await query(
    `UPDATE daily_risk_state
     SET trades_opened = trades_opened + 1, current_exposure = $1, updated_at = NOW()
     WHERE id = $2`,
    [newExposure, today.id]
  );
}

export async function recordTradeClosed(platform: string, betSize: number, bankroll: number): Promise<void> {
  const today = await getOrCreateDailyRisk(platform, bankroll);
  const newExposure = Math.max(0, today.current_exposure - betSize);

  await query(
    `UPDATE daily_risk_state
     SET trades_closed = trades_closed + 1, current_exposure = $1, updated_at = NOW()
     WHERE id = $2`,
    [newExposure, today.id]
  );
}

/**
 * Reset daily counters (called by cron at 6am MT)
 */
export async function resetDailyRisk(platform: string, bankroll: number): Promise<void> {
  const todayStr = new Date().toISOString().split('T')[0];

  // Check if today already exists
  const existing = await queryOne<any>(
    `SELECT id FROM daily_risk_state WHERE date = $1 AND platform = $2`,
    [todayStr, platform]
  );

  if (existing) {
    console.log(`[RiskGate] Daily risk state for ${todayStr} already exists, resetting counters`);
    await query(
      `UPDATE daily_risk_state
       SET starting_bankroll = $1, current_bankroll = $1, peak_bankroll = $1,
           daily_pnl = 0, daily_loss = 0, trades_opened = 0, trades_closed = 0,
           current_drawdown = 0, trading_paused = false, pause_reason = NULL, updated_at = NOW()
       WHERE date = $2 AND platform = $3`,
      [bankroll, todayStr, platform]
    );
  } else {
    await query(
      `INSERT INTO daily_risk_state (date, platform, starting_bankroll, current_bankroll, peak_bankroll)
       VALUES ($1, $2, $3, $3, $3)`,
      [todayStr, platform, bankroll]
    );
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

interface DailyRisk {
  id: number;
  date: string;
  starting_bankroll: number;
  current_bankroll: number;
  peak_bankroll: number;
  daily_pnl: number;
  daily_loss: number;
  trades_opened: number;
  trades_closed: number;
  current_exposure: number;
  current_drawdown: number;
  trading_paused: boolean;
  pause_reason: string | null;
}

async function getOrCreateDailyRisk(platform: string, bankroll: number): Promise<DailyRisk> {
  const todayStr = new Date().toISOString().split('T')[0];

  let row = await queryOne<DailyRisk>(
    `SELECT * FROM daily_risk_state WHERE date = $1 AND platform = $2`,
    [todayStr, platform]
  );

  if (!row) {
    const rows = await query<DailyRisk>(
      `INSERT INTO daily_risk_state (date, platform, starting_bankroll, current_bankroll, peak_bankroll)
       VALUES ($1, $2, $3, $3, $3)
       ON CONFLICT (date, platform) DO NOTHING
       RETURNING *`,
      [todayStr, platform, bankroll]
    );
    row = rows[0] ?? await queryOne<DailyRisk>(
      `SELECT * FROM daily_risk_state WHERE date = $1 AND platform = $2`,
      [todayStr, platform]
    );
  }

  return row!;
}

async function getTotalOpenExposure(platform: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(bet_size), 0) as total FROM market_positions WHERE platform = $1 AND status = 'open'`,
    [platform]
  );
  return parseFloat(row?.total || '0');
}

async function getCategoryExposure(platform: string, category: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(bet_size), 0) as total FROM market_positions WHERE platform = $1 AND status = 'open' AND category = $2`,
    [platform, category]
  );
  return parseFloat(row?.total || '0');
}
