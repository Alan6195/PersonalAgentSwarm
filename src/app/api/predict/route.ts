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

// Helper to get platform stats (bankroll, winRate, trades, pnl, etc.)
async function getPlatformStats(platform: string) {
  // Latest equity snapshot for bankroll
  const equityRows = await query(
    `SELECT bankroll as balance FROM equity_snapshots
     WHERE platform = $1
     ORDER BY snapshot_at DESC LIMIT 1`,
    [platform]
  );
  const bankroll = equityRows.length > 0 ? parseFloat((equityRows[0] as any).balance) || 0 : (platform === 'manifold' ? 1000 : 50);

  // Bankroll 24h ago for change calculation
  const equityRows24h = await query(
    `SELECT bankroll as balance FROM equity_snapshots
     WHERE platform = $1 AND snapshot_at <= NOW() - INTERVAL '24 hours'
     ORDER BY snapshot_at DESC LIMIT 1`,
    [platform]
  );
  const bankroll24h = equityRows24h.length > 0 ? parseFloat((equityRows24h[0] as any).balance) || bankroll : bankroll;
  const bankrollChange = bankroll - bankroll24h;

  // Trade stats (exclude scanner bug positions)
  const statsRows = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('closed_win', 'closed_loss')) as total_trades,
       COUNT(*) FILTER (WHERE status = 'closed_win') as wins,
       COUNT(*) FILTER (WHERE status = 'closed_loss') as losses,
       COALESCE(SUM(pnl) FILTER (WHERE status IN ('closed_win', 'closed_loss')), 0) as total_pnl,
       COUNT(*) FILTER (WHERE status = 'open') as open_positions,
       COALESCE(SUM(pnl) FILTER (WHERE status IN ('closed_win', 'closed_loss') AND opened_at >= CURRENT_DATE), 0) as daily_pnl
     FROM market_positions
     WHERE platform = $1
       AND (notes IS NULL OR notes NOT LIKE 'scanner bug%')`,
    [platform]
  );
  const s = (statsRows[0] || {}) as Record<string, any>;
  const totalTrades = parseInt(s.total_trades || "0");
  const wins = parseInt(s.wins || "0");
  const losses = parseInt(s.losses || "0");
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const totalPnl = parseFloat(s.total_pnl || "0");
  const openPositions = parseInt(s.open_positions || "0");
  const dailyPnl = parseFloat(s.daily_pnl || "0");

  return { bankroll, bankrollChange, winRate, trades: totalTrades, wins, losses, openPositions, dailyPnl, totalPnl };
}

async function getDashboard() {
  // Get per-platform stats
  const manifold = await getPlatformStats('manifold');
  const polymarket = await getPlatformStats('polymarket');

  // Polymarket dry run flag: check agent_config table override, fall back to env
  let polyDryRun = process.env.PREDICT_POLY_DRY_RUN !== 'false'; // default true
  try {
    const configRow = await query(
      `SELECT value FROM agent_config WHERE key = 'PREDICT_POLY_DRY_RUN'`
    );
    if (configRow.length > 0) {
      polyDryRun = (configRow[0] as any).value !== 'false';
    }
  } catch { /* agent_config table may not exist yet */ }

  // Risk state (latest daily risk for polymarket)
  const riskRows = await query(
    `SELECT * FROM daily_risk_state
     WHERE platform = 'polymarket'
     ORDER BY date DESC LIMIT 1`
  );
  const riskRaw = riskRows[0] as Record<string, any> | undefined;
  const currentBankroll = riskRaw ? parseFloat(riskRaw.current_bankroll) || polymarket.bankroll : polymarket.bankroll;
  const peakBankroll = riskRaw ? parseFloat(riskRaw.peak_bankroll) || currentBankroll : currentBankroll;
  const exposure = riskRaw ? (parseFloat(riskRaw.current_exposure) || 0) / Math.max(currentBankroll, 1) : 0;
  const dailyLoss = riskRaw ? Math.abs(parseFloat(riskRaw.daily_loss) || 0) / Math.max(currentBankroll, 1) : 0;
  const drawdown = riskRaw ? parseFloat(riskRaw.current_drawdown) || 0 : 0;
  const paused = riskRaw ? riskRaw.trading_paused === true : false;

  const riskState = {
    exposure,
    dailyLoss,
    drawdown,
    paused,
  };

  // Equity history for sparkline (column is 'bankroll' not 'balance')
  const equityRows = await query(
    `SELECT snapshot_at as timestamp, bankroll as balance
     FROM equity_snapshots
     WHERE platform = 'polymarket'
     ORDER BY snapshot_at ASC
     LIMIT 100`
  );
  const equityHistory = equityRows.map((row: any) => ({
    timestamp: row.timestamp,
    balance: parseFloat(row.balance) || 0,
  }));

  // Open positions (both platforms)
  const positionRows = await query(
    `SELECT id, platform, question as market_question, direction,
            p_market, p_model, edge, bet_size, intel_aligned, status, pnl, opened_at
     FROM market_positions
     WHERE status = 'open'
     ORDER BY opened_at DESC
     LIMIT 20`
  );
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

  // Recent scans (both platforms)
  const scanRows = await query(
    `SELECT id, platform, question as market_question, category,
            current_prob, claude_prob, edge, kelly_fraction, claude_reasoning as reasoning,
            scanned_at as created_at
     FROM market_scans
     ORDER BY scanned_at DESC
     LIMIT 20`
  );
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

  // Hypotheses
  const hypothesisRows = await query(
    `SELECT id, hypothesis, category, status, confidence, win_count, loss_count, created_at
     FROM predict_hypotheses
     WHERE status IN ('active', 'confirmed', 'refuted')
     ORDER BY status DESC, confidence DESC
     LIMIT 10`
  );
  const hypotheses = hypothesisRows.map((row: any) => ({
    id: row.id,
    hypothesis: row.hypothesis,
    category: row.category || "other",
    status: row.status,
    confidence: parseFloat(row.confidence) || 0,
    win_count: parseInt(row.win_count) || 0,
    loss_count: parseInt(row.loss_count) || 0,
    created_at: row.created_at,
  }));

  // Phase gate with Sharpe calculation
  const sharpe = await computeSharpe('polymarket');

  const tradesTarget = 15;
  const winRateTarget = 0.55;
  const sharpeTarget = 1.2;
  const phase2Unlocked = polymarket.trades >= tradesTarget && polymarket.winRate >= winRateTarget && sharpe >= sharpeTarget;

  const phaseGate = {
    trades: polymarket.trades,
    tradesTarget,
    winRate: polymarket.winRate,
    winRateTarget,
    sharpe,
    sharpeTarget,
    phase2Unlocked,
  };

  // Performance stats
  const activeDaysRows = await query(
    `SELECT COUNT(DISTINCT DATE(snapshot_at)) as days
     FROM equity_snapshots WHERE platform = 'polymarket'`
  );
  const activeDays = parseInt((activeDaysRows[0] as any)?.days || "0");

  const confirmedCount = hypotheses.filter(h => h.status === 'confirmed').length;

  // Max drawdown from equity snapshots
  const maxDdRows = await query(
    `SELECT bankroll as balance FROM equity_snapshots
     WHERE platform = 'polymarket' ORDER BY snapshot_at ASC`
  );
  let maxDrawdown = 0;
  let peak = 0;
  for (const row of maxDdRows) {
    const bal = parseFloat((row as any).balance) || 0;
    if (bal > peak) peak = bal;
    const dd = peak > 0 ? (peak - bal) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Win streak
  const streakRows = await query(
    `SELECT status FROM market_positions
     WHERE platform = 'polymarket'
       AND status IN ('closed_win', 'closed_loss')
       AND (notes IS NULL OR notes NOT LIKE 'scanner bug%')
     ORDER BY closed_at DESC`
  );
  let winStreak = 0;
  for (const row of streakRows) {
    if ((row as any).status === 'closed_win') winStreak++;
    else break;
  }

  // API cost tracking
  const todayCostRows = await query(
    `SELECT agent_id, COALESCE(SUM(cost_cents), 0) as total_cents,
            COALESCE(SUM(total_tokens), 0) as tokens, COUNT(*) as calls
     FROM cost_events
     WHERE created_at >= CURRENT_DATE
     GROUP BY agent_id
     ORDER BY total_cents DESC`
  );
  const monthCostRows = await query(
    `SELECT COALESCE(SUM(total_cost_cents), 0) as total_cents,
            COALESCE(SUM(total_tokens), 0) as tokens,
            COALESCE(SUM(task_count), 0) as calls
     FROM cost_daily
     WHERE date >= DATE_TRUNC('month', CURRENT_DATE)`
  );
  const modelCostRows = await query(
    `SELECT model, COALESCE(SUM(cost_cents), 0) as total_cents, COUNT(*) as calls
     FROM cost_events
     WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
     GROUP BY model
     ORDER BY total_cents DESC`
  );

  const costs = {
    today: {
      total: todayCostRows.reduce((sum: number, r: any) => sum + parseInt(r.total_cents || '0'), 0) / 100,
      byAgent: todayCostRows.map((r: any) => ({
        agent: r.agent_id,
        total: parseInt(r.total_cents || '0') / 100,
        tokens: parseInt(r.tokens || '0'),
        calls: parseInt(r.calls || '0'),
      })),
    },
    month: {
      total: parseInt((monthCostRows[0] as any)?.total_cents || '0') / 100,
      tokens: parseInt((monthCostRows[0] as any)?.tokens || '0'),
      calls: parseInt((monthCostRows[0] as any)?.calls || '0'),
    },
    byModel: modelCostRows.map((r: any) => ({
      model: r.model,
      total: parseInt(r.total_cents || '0') / 100,
      calls: parseInt(r.calls || '0'),
    })),
  };

  // Price feed data (from price_signals table, populated by agent-service)
  const priceRows = await query(
    `SELECT asset, current_price, return_1m, return_5m, return_15m,
            volatility_5m, momentum, momentum_strength, updated_at
     FROM price_signals ORDER BY asset`
  );
  const priceFeed: Record<string, any> = {};
  let priceFeedConnected = false;
  for (const row of priceRows) {
    const r = row as any;
    const updatedAt = new Date(r.updated_at);
    const ageSeconds = (Date.now() - updatedAt.getTime()) / 1000;
    if (ageSeconds < 120) priceFeedConnected = true; // consider connected if updated within 2 min
    priceFeed[r.asset] = {
      price: parseFloat(r.current_price) || 0,
      return5m: parseFloat(r.return_5m) || 0,
      momentum: r.momentum || 'neutral',
      momentumStrength: parseFloat(r.momentum_strength) || 0,
      updatedAt: r.updated_at,
    };
  }

  // Intel signals summary (from shared_signals table)
  const intelRows = await query(
    `SELECT
       COALESCE(SUBSTRING(topic FROM '[A-Z]{2,5}'), topic) as asset_key,
       direction, strength,
       EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 as age_minutes,
       created_at
     FROM shared_signals
     WHERE created_at > NOW() - INTERVAL '4 hours'
     ORDER BY created_at DESC
     LIMIT 20`
  );
  const intelSignals: Record<string, any> = {};
  for (const row of intelRows) {
    const r = row as any;
    const assetKey = (r.asset_key || '').toUpperCase();
    if (!assetKey || intelSignals[assetKey]) continue; // take freshest per asset
    intelSignals[assetKey] = {
      direction: r.direction,
      strength: parseFloat(r.strength) || 0,
      ageMinutes: Math.round(parseFloat(r.age_minutes) || 0),
    };
  }

  const lastIntelScan = intelRows.length > 0 ? (intelRows[0] as any).created_at : null;

  return NextResponse.json({
    manifold: {
      bankroll: manifold.bankroll,
      bankrollChange: manifold.bankrollChange,
      winRate: manifold.winRate,
      trades: manifold.trades,
      wins: manifold.wins,
      losses: manifold.losses,
      openPositions: manifold.openPositions,
      dailyPnl: manifold.dailyPnl,
      totalPnl: manifold.totalPnl,
    },
    polymarket: {
      bankroll: polymarket.bankroll,
      bankrollChange: polymarket.bankrollChange,
      winRate: polymarket.winRate,
      trades: polymarket.trades,
      wins: polymarket.wins,
      losses: polymarket.losses,
      openPositions: polymarket.openPositions,
      dailyPnl: polymarket.dailyPnl,
      totalPnl: polymarket.totalPnl,
      dryRun: polyDryRun,
    },
    phaseGate,
    riskState,
    positions,
    recentScans,
    hypotheses,
    equityHistory,
    costs,
    performance: {
      activeDays,
      confirmed: confirmedCount,
      sharpe,
      maxDrawdown,
      winStreak,
    },
    priceFeed: {
      connected: priceFeedConnected,
      assets: priceFeed,
    },
    intelSignals,
    lastIntelScan,
  });
}

async function computeSharpe(platform: string): Promise<number> {
  const rows = await query(
    `SELECT
       COALESCE(AVG(daily_return) / NULLIF(STDDEV(daily_return), 0), 0) as sharpe
     FROM (
       SELECT
         DATE(snapshot_at) as day,
         (MAX(bankroll) - MIN(bankroll)) / NULLIF(MIN(bankroll), 0) as daily_return
       FROM equity_snapshots
       WHERE platform = $1
       GROUP BY DATE(snapshot_at)
       HAVING COUNT(*) > 1
     ) daily_returns`,
    [platform]
  );
  return parseFloat((rows[0] as any)?.sharpe || "0") || 0;
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
