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
  // Equity state (latest daily risk)
  const riskState = await query(
    `SELECT * FROM daily_risk_state
     WHERE platform = 'manifold'
     ORDER BY date DESC LIMIT 1`
  );

  // Equity history (last 30 days of snapshots, downsampled to 1 per hour)
  const equityHistory = await query(
    `SELECT DISTINCT ON (date_trunc('hour', snapshot_at))
       total_equity, bankroll, unrealized_pnl, positions_open, win_rate, total_trades, snapshot_at
     FROM equity_snapshots
     WHERE platform = 'manifold'
     ORDER BY date_trunc('hour', snapshot_at) DESC, snapshot_at DESC
     LIMIT 720`
  );

  // Open positions
  const positions = await query(
    `SELECT id, question, direction, p_market, p_model, edge, bet_size,
            intel_aligned, opened_at, category, status
     FROM market_positions
     WHERE platform = 'manifold' AND status = 'open'
     ORDER BY opened_at DESC
     LIMIT 20`
  );

  // Recent scans
  const scans = await query(
    `SELECT id, market_id, question, category, current_prob, claude_prob,
            edge, kelly_fraction, reward_score, scanned_at
     FROM market_scans
     WHERE platform = 'manifold'
     ORDER BY scanned_at DESC
     LIMIT 20`
  );

  // Trade stats (exclude scanner bug positions from win rate / phase gate)
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

  // Hypotheses summary
  const hypotheses = await query(
    `SELECT id, hypothesis, status, confidence, win_count, loss_count
     FROM predict_hypotheses
     WHERE status IN ('active', 'confirmed')
     ORDER BY status DESC, confidence DESC
     LIMIT 10`
  );

  // Manifold balance (from latest risk state or default)
  const balance = riskState[0]
    ? parseFloat(riskState[0].current_bankroll)
    : 1000;

  const tradeStats = stats[0] || {};
  const totalTrades = parseInt(tradeStats.total_trades || "0");
  const wins = parseInt(tradeStats.wins || "0");
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;

  return NextResponse.json({
    phase,
    balance,
    riskState: riskState[0] || null,
    equityHistory: equityHistory.reverse(),
    positions,
    scans,
    stats: {
      totalTrades,
      wins,
      losses: parseInt(tradeStats.losses || "0"),
      winRate,
      totalPnl: parseFloat(tradeStats.total_pnl || "0"),
      openPositions: parseInt(tradeStats.open_positions || "0"),
      deployed: parseFloat(tradeStats.deployed || "0"),
    },
    hypotheses,
    gate: {
      trades: { current: totalTrades, required: 30, passed: totalTrades >= 30 },
      winRate: {
        current: winRate,
        required: 0.6,
        passed: winRate >= 0.6,
      },
      sharpe: { current: 0, required: 1.5, passed: false }, // Computed client-side from equity history
    },
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
