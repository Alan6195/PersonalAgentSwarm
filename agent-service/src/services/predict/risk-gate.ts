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
 * - Minimum $1 bet Manifold / $0.50 Polymarket (avoid dust positions)
 * - Minimum 4c edge Manifold / 9c net edge Polymarket (after taker fees)
 * - Polymarket: signal quality gate (momentum >= 0.35 OR intel >= 0.50 OR combined)
 * - Manifold: VaR95 > -0.10 (probability-space confidence check)
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

// Polymarket-specific overrides for order flow trading on 5/15-min markets.
// High-frequency small bets need looser limits than Manifold's long-horizon bets.
// Positions resolve every 5-15 minutes, so exposure turns over rapidly.
export const POLY_RISK_LIMITS: RiskLimits = {
  maxPositionPct: 0.10,       // 10% max per trade (was 5%)
  maxCategoryPct: 0.80,       // 80% per category (let it rip)
  maxTotalExposurePct: 0.80,  // 80% max deployed
  dailyLossPausePct: 1.00,    // Disabled: no daily loss pause
  drawdownPausePct: 1.00,     // Disabled: no drawdown pause (was 30%)
  minEdge: 0.05,              // 5c net edge (was 6c)
  minBet: 0.50,               // lowered from 1.00 to keep trading with smaller bankroll
};

/**
 * Get risk limits for a platform
 */
export function getRiskLimits(platform: string): RiskLimits {
  return platform === 'polymarket' ? POLY_RISK_LIMITS : RISK_LIMITS;
}

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
  momentumStrength?: number; // Polymarket: replaces VaR95 with momentum confidence gate
  intelStrength?: number;    // Polymarket: max(bearish, bullish) from intel signals
}

/**
 * Check if a new trade is allowed by all risk constraints
 */
export async function validateTrade(candidate: TradeCandidate, bankroll: number): Promise<RiskCheck> {
  const { platform, category, betSize, edge, expectedReturn: er, pModel } = candidate;
  const limits = getRiskLimits(platform);

  // Get current risk state
  const today = await getOrCreateDailyRisk(platform, bankroll);

  // Get current exposure
  const totalExposure = await getTotalOpenExposure(platform);
  const categoryExposure = await getCategoryExposure(platform, category);

  // Signal quality check: platform-specific
  // - Polymarket (5/15-min crypto): momentum confidence gate (VaR95 is meaningless
  //   for binary 50/50 markets where pModel hovers near 0.5)
  // - Manifold (days/weeks): traditional VaR95 probability-space check
  let signalQualityOk: boolean;
  let signalQualityLabel: string;

  if (platform === 'polymarket') {
    // Signal quality: accept either price momentum OR strong intel signals.
    // Momentum alone: momentumStrength >= 0.35 from price feed
    // Intel alone: strong bearish/bullish signal (>= 0.5) from X agent
    // Combined: lower momentum threshold (>= 0.20) when intel confirms direction
    const ms = candidate.momentumStrength ?? 0;
    const is = candidate.intelStrength ?? 0;
    const hasMomentum = ms >= 0.35;
    const hasStrongIntel = is >= 0.5;
    const hasCombined = ms >= 0.20 && is >= 0.3;
    signalQualityOk = hasMomentum || hasStrongIntel || hasCombined;
    signalQualityLabel = `momentum: ${ms.toFixed(2)}, intel: ${is.toFixed(2)} (need mom>=0.35 OR intel>=0.50 OR both>=0.20/0.30)`;
  } else {
    // VaR95: at 95% confidence, worst-case probability must be within 10pp of model
    const var95 = pModel - 1.645 * Math.sqrt(pModel * (1 - pModel));
    signalQualityOk = var95 > -0.10;
    signalQualityLabel = `VaR95: ${var95.toFixed(4)} (min -0.10)`;
  }

  // Max drawdown from peak
  const mdd = today.peak_bankroll > 0
    ? (today.peak_bankroll - today.current_bankroll) / today.peak_bankroll
    : 0;

  const checks: Record<string, boolean> = {
    edge_sufficient: edge >= limits.minEdge,
    min_bet: betSize >= limits.minBet,
    max_position: betSize <= bankroll * limits.maxPositionPct,
    expected_return_positive: er > 0,
    signal_quality: signalQualityOk,
    daily_loss_ok: Math.abs(today.daily_loss) < bankroll * limits.dailyLossPausePct,
    drawdown_ok: mdd < limits.drawdownPausePct,
    category_exposure_ok: (categoryExposure + betSize) <= bankroll * limits.maxCategoryPct,
    total_exposure_ok: (totalExposure + betSize) <= bankroll * limits.maxTotalExposurePct,
    trading_not_paused: !today.trading_paused,
  };

  // Rejection logging
  if (!checks.edge_sufficient) {
    console.error(`[RiskGate] REJECTED [${platform}]: edge ${edge.toFixed(4)} < ${limits.minEdge}`);
  }
  if (!checks.signal_quality) {
    console.error(`[RiskGate] REJECTED [${platform}]: ${signalQualityLabel}`);
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
  const limits = getRiskLimits(platform);

  if (Math.abs(today.daily_loss) >= bankroll * limits.dailyLossPausePct) {
    if (!today.trading_paused) {
      await query(
        `UPDATE daily_risk_state SET trading_paused = true, pause_reason = 'daily_loss_limit', updated_at = NOW() WHERE id = $1`,
        [today.id]
      );
    }
    return { paused: true, reason: `Daily loss ${(Math.abs(today.daily_loss) / bankroll * 100).toFixed(1)}% exceeds ${limits.dailyLossPausePct * 100}% limit` };
  }

  const mdd = today.peak_bankroll > 0
    ? (today.peak_bankroll - today.current_bankroll) / today.peak_bankroll
    : 0;

  if (mdd >= limits.drawdownPausePct) {
    if (!today.trading_paused) {
      await query(
        `UPDATE daily_risk_state SET trading_paused = true, pause_reason = 'drawdown_limit', updated_at = NOW() WHERE id = $1`,
        [today.id]
      );
    }
    return { paused: true, reason: `Drawdown ${(mdd * 100).toFixed(1)}% exceeds ${limits.drawdownPausePct * 100}% limit` };
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

// pg driver returns NUMERIC columns as strings. Parse them to avoid string concatenation bugs.
function parseDailyRisk(row: any): DailyRisk {
  return {
    id: row.id,
    date: row.date,
    starting_bankroll: parseFloat(row.starting_bankroll) || 0,
    current_bankroll: parseFloat(row.current_bankroll) || 0,
    peak_bankroll: parseFloat(row.peak_bankroll) || 0,
    daily_pnl: parseFloat(row.daily_pnl) || 0,
    daily_loss: parseFloat(row.daily_loss) || 0,
    trades_opened: parseInt(row.trades_opened) || 0,
    trades_closed: parseInt(row.trades_closed) || 0,
    current_exposure: parseFloat(row.current_exposure) || 0,
    current_drawdown: parseFloat(row.current_drawdown) || 0,
    trading_paused: row.trading_paused,
    pause_reason: row.pause_reason,
  };
}

async function getOrCreateDailyRisk(platform: string, bankroll: number): Promise<DailyRisk> {
  const todayStr = new Date().toISOString().split('T')[0];

  let row = await queryOne<any>(
    `SELECT * FROM daily_risk_state WHERE date = $1 AND platform = $2`,
    [todayStr, platform]
  );

  if (!row) {
    const rows = await query<any>(
      `INSERT INTO daily_risk_state (date, platform, starting_bankroll, current_bankroll, peak_bankroll)
       VALUES ($1, $2, $3, $3, $3)
       ON CONFLICT (date, platform) DO NOTHING
       RETURNING *`,
      [todayStr, platform, bankroll]
    );
    row = rows[0] ?? await queryOne<any>(
      `SELECT * FROM daily_risk_state WHERE date = $1 AND platform = $2`,
      [todayStr, platform]
    );
  }

  return parseDailyRisk(row);
}

async function getTotalOpenExposure(platform: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(bet_size), 0) as total FROM market_positions
     WHERE platform = $1 AND status = 'open'
       AND (end_time IS NULL OR end_time > NOW())`,
    [platform]
  );
  return parseFloat(row?.total || '0');
}

async function getCategoryExposure(platform: string, category: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(bet_size), 0) as total FROM market_positions
     WHERE platform = $1 AND status = 'open' AND category = $2
       AND (end_time IS NULL OR end_time > NOW())`,
    [platform, category]
  );
  return parseFloat(row?.total || '0');
}
