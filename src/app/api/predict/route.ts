import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const view = searchParams.get("view") || "dashboard";

    if (view === "log") {
      return await getExecutionLog();
    }
    if (view === "signals") {
      return await getSharedSignals();
    }

    return await getDashboard();
  } catch (error) {
    console.error("[API/predict] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch predict data" },
      { status: 500 }
    );
  }
}

async function getDashboard() {
  // Risk state (latest daily risk)
  const riskRows = await query(
    `SELECT * FROM daily_risk_state
     WHERE platform = 'manifold'
     ORDER BY date DESC LIMIT 1`
  );

  // Equity history (last 30 days of snapshots, downsampled to 1 per hour)
  const equityRows = await query(
    `SELECT DISTINCT ON (date_trunc('hour', snapshot_at))
       total_equity, bankroll, unrealized_pnl, positions_open, win_rate, total_trades, snapshot_at
     FROM equity_snapshots
     WHERE platform = 'manifold'
     ORDER BY date_trunc('hour', snapshot_at) DESC, snapshot_at DESC
     LIMIT 720`
  );

  // Open positions (include all statuses for display, add pnl and platform)
  const positionRows = await query(
    `SELECT id, 'manifold' as platform, question as market_question, direction,
            p_market, p_model, edge, bet_size, intel_aligned, status, pnl, opened_at
     FROM market_positions
     WHERE platform = 'manifold' AND status = 'open'
     ORDER BY opened_at DESC
     LIMIT 20`
  );

  // Recent scans (add reasoning, platform, rename fields)
  const scanRows = await query(
    `SELECT id, 'manifold' as platform, question as market_question, category,
            current_prob, claude_prob, edge, kelly_fraction, claude_reasoning as reasoning,
            scanned_at as created_at
     FROM market_scans
     WHERE platform = 'manifold'
     ORDER BY scanned_at DESC
     LIMIT 20`
  );

  // Trade stats (exclude scanner bug positions)
  const stats = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('closed_win', 'closed_loss')) as total_trades,
       COUNT(*) FILTER (WHERE status = 'closed_win') as wins,
       COUNT(*) FILTER (WHERE status = 'closed_loss') as losses,
       COALESCE(SUM(pnl) FILTER (WHERE status IN ('closed_win', 'closed_loss')), 0) as total_pnl,
       COUNT(*) FILTER (WHERE status = 'open') as open_positions,
       COALESCE(SUM(bet_size) FILTER (WHERE status = 'open'), 0) as deployed
     FROM market_positions
     WHERE platform = 'manifold'
       AND (notes IS NULL OR notes NOT LIKE 'scanner bug%')`
  );

  // Phase gate
  const phase = parseInt(process.env.PREDICT_PHASE || "1");

  // Hypotheses summary (include category)
  const hypothesisRows = await query(
    `SELECT id, hypothesis, category, status, confidence, win_count, loss_count
     FROM predict_hypotheses
     WHERE status IN ('active', 'confirmed', 'refuted')
     ORDER BY status DESC, confidence DESC
     LIMIT 10`
  );

  // Parse risk state into numbers
  const riskRaw = riskRows[0] as Record<string, any> | undefined;
  const riskState = riskRaw
    ? {
        current_bankroll: parseFloat(riskRaw.current_bankroll) || 1000,
        peak_bankroll: parseFloat(riskRaw.peak_bankroll) || 1000,
        daily_pnl: parseFloat(riskRaw.daily_pnl) || 0,
        daily_loss: parseFloat(riskRaw.daily_loss) || 0,
        current_exposure: parseFloat(riskRaw.current_exposure) || 0,
        trading_paused: riskRaw.trading_paused === true,
        pause_reason: riskRaw.pause_reason || null,
        current_drawdown: parseFloat(riskRaw.current_drawdown) || 0,
      }
    : null;

  // Parse equity history into numbers (reverse to chronological order)
  const equityHistory = equityRows.reverse().map((row: any) => ({
    bankroll: parseFloat(row.bankroll) || 0,
    unrealized_pnl: parseFloat(row.unrealized_pnl) || 0,
    total_equity: parseFloat(row.total_equity) || 0,
    win_rate: parseFloat(row.win_rate) || 0,
    total_trades: parseInt(row.total_trades) || 0,
    snapshot_at: row.snapshot_at,
  }));

  // Latest equity snapshot as "equity"
  const latestEquity =
    equityHistory.length > 0 ? equityHistory[equityHistory.length - 1] : null;

  // Parse positions into numbers
  const positions = positionRows.map((row: any) => ({
    id: row.id,
    platform: row.platform,
    market_question: row.market_question,
    direction: row.direction,
    p_market: parseFloat(row.p_market) || 0,
    p_model: parseFloat(row.p_model) || 0,
    edge: parseFloat(row.edge) || 0,
    bet_size: parseFloat(row.bet_size) || 0,
    intel_aligned: row.intel_aligned === true,
    status: row.status,
    pnl: row.pnl != null ? parseFloat(row.pnl) : null,
    opened_at: row.opened_at,
  }));

  // Parse scans into numbers
  const recentScans = scanRows.map((row: any) => ({
    id: row.id,
    market_question: row.market_question,
    platform: row.platform,
    current_prob: parseFloat(row.current_prob) || 0,
    claude_prob: parseFloat(row.claude_prob) || 0,
    edge: parseFloat(row.edge) || 0,
    kelly_fraction: parseFloat(row.kelly_fraction) || 0,
    reasoning: row.reasoning || "",
    created_at: row.created_at,
  }));

  // Parse hypotheses
  const hypotheses = hypothesisRows.map((row: any) => ({
    id: row.id,
    hypothesis: row.hypothesis,
    category: row.category || "other",
    status: row.status,
    confidence: parseFloat(row.confidence) || 0,
    win_count: parseInt(row.win_count) || 0,
    loss_count: parseInt(row.loss_count) || 0,
  }));

  // Trade stats for phase gate
  const tradeStats = (stats[0] || {}) as Record<string, any>;
  const totalTrades = parseInt(tradeStats.total_trades || "0");
  const wins = parseInt(tradeStats.wins || "0");
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;

  // Phase gate (flat structure)
  // Gate lowered from 30/60%/1.5 to 15/55%/1.2 because:
  // 1. Polymarket 5-min markets are now running in parallel as primary track
  // 2. Manifold is validation only, not the main model
  // 3. External validation exists from LMSR engine data
  const phaseGate = {
    phase: phase === 1 ? "manifold" : "polymarket",
    trades: totalTrades,
    trades_target: 15,
    win_rate: winRate,
    win_rate_target: 0.55,
    sharpe: 0, // computed from equity history client-side
    sharpe_target: 1.2,
    ready:
      totalTrades >= 15 && winRate >= 0.55, // sharpe check deferred
  };

  return NextResponse.json({
    equity: latestEquity,
    equity_history: equityHistory,
    positions,
    recent_scans: recentScans,
    risk_state: riskState,
    phase_gate: phaseGate,
    hypotheses,
  });
}

async function getExecutionLog() {
  const log = await query(
    `SELECT mp.id, mp.question, mp.direction, mp.p_market, mp.p_model, mp.edge,
            mp.bet_size, mp.pnl, mp.pnl_pct, mp.status, mp.intel_aligned,
            mp.reasoning, mp.opened_at, mp.closed_at, mp.category
     FROM market_positions mp
     WHERE mp.platform = 'manifold'
     ORDER BY COALESCE(mp.closed_at, mp.opened_at) DESC
     LIMIT 50`
  );

  return NextResponse.json({ log });
}

async function getSharedSignals() {
  const signals = await query(
    `SELECT id, source_agent, signal_type, topic, direction, strength,
            consumed_by_predict, metadata, created_at
     FROM shared_signals
     ORDER BY created_at DESC
     LIMIT 30`
  );

  return NextResponse.json({ signals });
}
