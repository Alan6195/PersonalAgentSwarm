"use client";

import { useState } from "react";
import { useFetch } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import {
  TrendingUp,
  Target,
  Shield,
  Brain,
  Activity,
  Zap,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronRight,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Types ────────────────────────────────────────────────────────────

interface PredictData {
  phase: number;
  balance: number;
  riskState: {
    date: string;
    daily_pnl: string;
    current_drawdown: string;
    trading_paused: boolean;
    pause_reason: string | null;
    current_exposure: string;
  } | null;
  equityHistory: {
    total_equity: string;
    bankroll: string;
    positions_open: string;
    win_rate: string;
    snapshot_at: string;
  }[];
  positions: {
    id: number;
    question: string;
    direction: string;
    p_market: string;
    p_model: string;
    edge: string;
    bet_size: string;
    intel_aligned: boolean;
    opened_at: string;
    category: string;
  }[];
  scans: {
    id: number;
    question: string;
    category: string;
    current_prob: string;
    claude_prob: string;
    edge: string;
    reward_score: string;
    scanned_at: string;
  }[];
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    openPositions: number;
    deployed: number;
  };
  hypotheses: {
    id: number;
    hypothesis: string;
    status: string;
    confidence: string;
    win_count: number;
    loss_count: number;
  }[];
  gate: {
    trades: { current: number; required: number; passed: boolean };
    winRate: { current: number; required: number; passed: boolean };
    sharpe: { current: number; required: number; passed: boolean };
  };
}

// ── Seeded PRNG for mock data ────────────────────────────────────────

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMockData(): PredictData {
  const rng = mulberry32(42);
  const now = Date.now();

  const equityHistory = Array.from({ length: 72 }, (_, i) => {
    const equity = 1000 + (rng() - 0.45) * 50 * Math.sqrt(i + 1);
    return {
      total_equity: equity.toFixed(2),
      bankroll: (equity - rng() * 20).toFixed(2),
      positions_open: String(Math.floor(rng() * 5)),
      win_rate: (0.55 + rng() * 0.15).toFixed(3),
      snapshot_at: new Date(now - (72 - i) * 3600000).toISOString(),
    };
  });

  const categories = ["crypto", "ai_tech", "politics", "economics", "sports"];
  const positions = Array.from({ length: 4 }, (_, i) => ({
    id: i + 1,
    question: [
      "Will BTC exceed $120K by end of March?",
      "Will GPT-5 be released before July 2026?",
      "Will US unemployment rise above 5%?",
      "Will SpaceX Starship reach orbit by April?",
    ][i],
    direction: rng() > 0.5 ? "YES" : "NO",
    p_market: (0.2 + rng() * 0.6).toFixed(3),
    p_model: (0.2 + rng() * 0.6).toFixed(3),
    edge: ((rng() - 0.3) * 0.2).toFixed(4),
    bet_size: (10 + rng() * 40).toFixed(0),
    intel_aligned: rng() > 0.4,
    opened_at: new Date(now - rng() * 86400000 * 3).toISOString(),
    category: categories[Math.floor(rng() * categories.length)],
  }));

  const scans = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    question: `Mock market question ${i + 1} about ${categories[i % categories.length]}?`,
    category: categories[i % categories.length],
    current_prob: (0.2 + rng() * 0.6).toFixed(3),
    claude_prob: (0.2 + rng() * 0.6).toFixed(3),
    edge: ((rng() - 0.4) * 0.15).toFixed(4),
    reward_score: (rng() * 0.5).toFixed(3),
    scanned_at: new Date(now - rng() * 14400000).toISOString(),
  }));

  return {
    phase: 1,
    balance: 1000 + rng() * 200,
    riskState: {
      date: new Date().toISOString().split("T")[0],
      daily_pnl: ((rng() - 0.4) * 30).toFixed(2),
      current_drawdown: (rng() * 0.05).toFixed(4),
      trading_paused: false,
      pause_reason: null,
      current_exposure: (rng() * 0.25).toFixed(4),
    },
    equityHistory,
    positions,
    scans,
    stats: {
      totalTrades: 12,
      wins: 8,
      losses: 4,
      winRate: 0.667,
      totalPnl: 47.32,
      openPositions: 4,
      deployed: 120,
    },
    hypotheses: [
      {
        id: 1,
        hypothesis: "Intel-aligned trades have higher win rate",
        status: "confirmed",
        confidence: "82",
        win_count: 6,
        loss_count: 1,
      },
      {
        id: 2,
        hypothesis: "Crypto markets have above average win rate",
        status: "active",
        confidence: "65",
        win_count: 4,
        loss_count: 2,
      },
      {
        id: 3,
        hypothesis: "Edge >= 10% trades outperform",
        status: "active",
        confidence: "58",
        win_count: 3,
        loss_count: 2,
      },
    ],
    gate: {
      trades: { current: 12, required: 30, passed: false },
      winRate: { current: 0.667, required: 0.6, passed: true },
      sharpe: { current: 1.2, required: 1.5, passed: false },
    },
  };
}

// ── Custom Tooltip ───────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-carbon-900 border border-carbon-700 rounded-lg px-3 py-2 shadow-xl">
      <p className="text-[10px] font-mono text-carbon-400 mb-1">
        {new Date(label).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
        })}
      </p>
      {payload.map((p: any, i: number) => (
        <p key={i} className="text-xs font-mono" style={{ color: p.color }}>
          {p.name}: M${Number(p.value).toFixed(0)}
        </p>
      ))}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

export default function PredictPage() {
  const { data: apiData } = useFetch<PredictData>("/api/predict", 10000);
  const [tab, setTab] = useState<"positions" | "scans" | "hypotheses">(
    "positions"
  );

  // Use API data if available, fall back to mock
  const data = apiData || generateMockData();
  const isMock = !apiData;

  const equityChartData = data.equityHistory.map((s) => ({
    time: s.snapshot_at,
    equity: parseFloat(s.total_equity),
  }));

  const pnlColor = data.stats.totalPnl >= 0 ? "text-neon-green" : "text-neon-red";
  const dailyPnl = data.riskState ? parseFloat(data.riskState.daily_pnl) : 0;
  const dailyPnlColor = dailyPnl >= 0 ? "text-neon-green" : "text-neon-red";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-neon-green/20 to-neon-blue/20 border border-neon-green/30 flex items-center justify-center">
            <TrendingUp className="w-4 h-4 text-neon-green" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white tracking-tight">
              Predict Agent
            </h1>
            <p className="text-sm text-carbon-500 font-mono mt-0.5">
              Phase {data.phase} {data.phase === 1 ? "(Manifold paper)" : "(Polymarket live)"}
              {data.riskState?.trading_paused && (
                <span className="text-neon-amber ml-2">PAUSED</span>
              )}
              {isMock && (
                <span className="text-carbon-600 ml-2">[mock data]</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-3">
        <StatCard
          label="Bankroll"
          value={`M$${data.balance.toFixed(0)}`}
          icon={<Zap className="w-3.5 h-3.5 text-neon-green" />}
        />
        <StatCard
          label="Win Rate"
          value={`${(data.stats.winRate * 100).toFixed(1)}%`}
          icon={<Target className="w-3.5 h-3.5 text-neon-blue" />}
          color={data.stats.winRate >= 0.6 ? "text-neon-green" : "text-neon-amber"}
        />
        <StatCard
          label="Total P&L"
          value={`${data.stats.totalPnl >= 0 ? "+" : ""}M$${data.stats.totalPnl.toFixed(2)}`}
          icon={<TrendingUp className="w-3.5 h-3.5 text-neon-green" />}
          color={pnlColor}
        />
        <StatCard
          label="Trades"
          value={`${data.stats.wins}W / ${data.stats.losses}L`}
          icon={<Activity className="w-3.5 h-3.5 text-neon-purple" />}
        />
        <StatCard
          label="Daily P&L"
          value={`${dailyPnl >= 0 ? "+" : ""}M$${dailyPnl.toFixed(2)}`}
          icon={<Activity className="w-3.5 h-3.5 text-neon-blue" />}
          color={dailyPnlColor}
        />
        <StatCard
          label="Deployed"
          value={`M$${data.stats.deployed.toFixed(0)}`}
          icon={<Shield className="w-3.5 h-3.5 text-neon-amber" />}
        />
      </div>

      {/* Equity Curve + Phase Gate */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 card p-6">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-neon-green" />
            Equity Curve
          </h2>
          <div className="h-56">
            {equityChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equityChartData}>
                  <defs>
                    <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00ff9d" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#00ff9d" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="time"
                    tick={{ fill: "#737384", fontSize: 10, fontFamily: "JetBrains Mono" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) =>
                      new Date(v).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })
                    }
                    minTickGap={40}
                  />
                  <YAxis
                    tick={{ fill: "#737384", fontSize: 10, fontFamily: "JetBrains Mono" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `M$${v}`}
                    domain={["dataMin - 20", "dataMax + 20"]}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    name="Equity"
                    stroke="#00ff9d"
                    fill="url(#equityGrad)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-carbon-600 font-mono text-xs">
                No equity data yet
              </div>
            )}
          </div>
        </div>

        {/* Phase Gate */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Shield className="w-4 h-4 text-neon-amber" />
            Phase Gate
          </h2>
          <p className="text-[10px] font-mono text-carbon-500 mb-4 uppercase tracking-wider">
            Manifold {">"} Polymarket
          </p>

          <div className="space-y-4">
            <GateItem
              label="Trades"
              current={data.gate.trades.current}
              required={data.gate.trades.required}
              passed={data.gate.trades.passed}
              format={(v) => String(v)}
            />
            <GateItem
              label="Win Rate"
              current={data.gate.winRate.current}
              required={data.gate.winRate.required}
              passed={data.gate.winRate.passed}
              format={(v) => `${(v * 100).toFixed(1)}%`}
            />
            <GateItem
              label="Sharpe"
              current={data.gate.sharpe.current}
              required={data.gate.sharpe.required}
              passed={data.gate.sharpe.passed}
              format={(v) => v.toFixed(2)}
            />
          </div>

          <div className="mt-6 pt-4 border-t border-carbon-800/50">
            {data.gate.trades.passed &&
            data.gate.winRate.passed &&
            data.gate.sharpe.passed ? (
              <p className="text-xs font-mono text-neon-green flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                ALL GATES CLEAR
              </p>
            ) : (
              <p className="text-xs font-mono text-carbon-500 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-neon-amber" />
                Continue paper trading
              </p>
            )}
          </div>

          {/* Risk State */}
          {data.riskState && (
            <div className="mt-4 pt-4 border-t border-carbon-800/50">
              <p className="text-[10px] font-mono text-carbon-500 mb-2 uppercase tracking-wider">
                Risk State
              </p>
              <div className="space-y-1.5 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-carbon-400">Drawdown</span>
                  <span className={cn(
                    parseFloat(data.riskState.current_drawdown) > 0.10
                      ? "text-neon-red"
                      : "text-carbon-300"
                  )}>
                    {(parseFloat(data.riskState.current_drawdown) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-carbon-400">Exposure</span>
                  <span className="text-carbon-300">
                    {(parseFloat(data.riskState.current_exposure) * 100).toFixed(1)}%
                  </span>
                </div>
                {data.riskState.trading_paused && (
                  <div className="flex items-center gap-2 text-neon-amber mt-2">
                    <AlertTriangle className="w-3 h-3" />
                    <span>{data.riskState.pause_reason || "Paused"}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tabs: Positions / Scans / Hypotheses */}
      <div className="card">
        <div className="flex items-center gap-1 px-4 pt-4 border-b border-carbon-800/50">
          {(["positions", "scans", "hypotheses"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-4 py-2.5 text-xs font-mono transition-colors border-b-2 capitalize",
                tab === t
                  ? "border-neon-green text-white"
                  : "border-transparent text-carbon-500 hover:text-carbon-300"
              )}
            >
              {t === "positions"
                ? `Positions (${data.stats.openPositions})`
                : t === "scans"
                ? "Recent Scans"
                : `Hypotheses (${data.hypotheses.length})`}
            </button>
          ))}
        </div>

        <div className="p-4">
          {tab === "positions" && (
            <PositionsTable positions={data.positions} />
          )}
          {tab === "scans" && <ScansTable scans={data.scans} />}
          {tab === "hypotheses" && (
            <HypothesesList hypotheses={data.hypotheses} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Components ───────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="card px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <p className="text-[10px] font-mono uppercase tracking-wider text-carbon-500">
          {label}
        </p>
      </div>
      <p className={cn("text-lg font-semibold font-mono", color || "text-white")}>
        {value}
      </p>
    </div>
  );
}

function GateItem({
  label,
  current,
  required,
  passed,
  format,
}: {
  label: string;
  current: number;
  required: number;
  passed: boolean;
  format: (v: number) => string;
}) {
  const pct = Math.min((current / required) * 100, 100);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-mono text-carbon-400">{label}</span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-xs font-mono",
              passed ? "text-neon-green" : "text-carbon-300"
            )}
          >
            {format(current)}
          </span>
          <span className="text-[10px] font-mono text-carbon-600">
            / {format(required)}
          </span>
          {passed ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-neon-green" />
          ) : (
            <XCircle className="w-3.5 h-3.5 text-carbon-600" />
          )}
        </div>
      </div>
      <div className="h-1.5 bg-carbon-800 rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            passed ? "bg-neon-green" : "bg-neon-amber"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PositionsTable({
  positions,
}: {
  positions: PredictData["positions"];
}) {
  if (positions.length === 0) {
    return (
      <p className="text-xs text-carbon-600 text-center py-8 font-mono">
        No open positions
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-carbon-500 border-b border-carbon-800/50">
            <th className="text-left py-2 px-2">Market</th>
            <th className="text-center py-2 px-2">Dir</th>
            <th className="text-right py-2 px-2">Market</th>
            <th className="text-right py-2 px-2">Model</th>
            <th className="text-right py-2 px-2">Edge</th>
            <th className="text-right py-2 px-2">Size</th>
            <th className="text-center py-2 px-2">Intel</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const edge = parseFloat(p.edge);
            return (
              <tr
                key={p.id}
                className="border-b border-carbon-800/30 hover:bg-carbon-800/20 transition-colors"
              >
                <td className="py-2.5 px-2 text-carbon-300 max-w-[260px] truncate">
                  {p.question}
                </td>
                <td
                  className={cn(
                    "py-2.5 px-2 text-center font-semibold",
                    p.direction === "YES" ? "text-neon-green" : "text-neon-red"
                  )}
                >
                  {p.direction}
                </td>
                <td className="py-2.5 px-2 text-right text-carbon-400">
                  {parseFloat(p.p_market).toFixed(2)}
                </td>
                <td className="py-2.5 px-2 text-right text-carbon-300">
                  {parseFloat(p.p_model).toFixed(2)}
                </td>
                <td
                  className={cn(
                    "py-2.5 px-2 text-right",
                    edge >= 0.08 ? "text-neon-green" : "text-neon-amber"
                  )}
                >
                  {(edge * 100).toFixed(0)}c
                </td>
                <td className="py-2.5 px-2 text-right text-carbon-300">
                  M${parseFloat(p.bet_size).toFixed(0)}
                </td>
                <td className="py-2.5 px-2 text-center">
                  {p.intel_aligned ? (
                    <span className="text-neon-green">Y</span>
                  ) : (
                    <span className="text-carbon-600">N</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ScansTable({ scans }: { scans: PredictData["scans"] }) {
  if (scans.length === 0) {
    return (
      <p className="text-xs text-carbon-600 text-center py-8 font-mono">
        No scans yet
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-carbon-500 border-b border-carbon-800/50">
            <th className="text-left py-2 px-2">Market</th>
            <th className="text-center py-2 px-2">Cat</th>
            <th className="text-right py-2 px-2">Current</th>
            <th className="text-right py-2 px-2">Claude</th>
            <th className="text-right py-2 px-2">Edge</th>
            <th className="text-right py-2 px-2">Score</th>
            <th className="text-right py-2 px-2">When</th>
          </tr>
        </thead>
        <tbody>
          {scans.map((s) => {
            const edge = parseFloat(s.edge);
            return (
              <tr
                key={s.id}
                className="border-b border-carbon-800/30 hover:bg-carbon-800/20 transition-colors"
              >
                <td className="py-2.5 px-2 text-carbon-300 max-w-[260px] truncate">
                  {s.question}
                </td>
                <td className="py-2.5 px-2 text-center text-carbon-500 capitalize">
                  {s.category}
                </td>
                <td className="py-2.5 px-2 text-right text-carbon-400">
                  {parseFloat(s.current_prob).toFixed(2)}
                </td>
                <td className="py-2.5 px-2 text-right text-carbon-300">
                  {parseFloat(s.claude_prob).toFixed(2)}
                </td>
                <td
                  className={cn(
                    "py-2.5 px-2 text-right",
                    Math.abs(edge) >= 0.04 ? "text-neon-green" : "text-carbon-500"
                  )}
                >
                  {(edge * 100).toFixed(0)}c
                </td>
                <td className="py-2.5 px-2 text-right text-carbon-400">
                  {parseFloat(s.reward_score).toFixed(2)}
                </td>
                <td className="py-2.5 px-2 text-right text-carbon-600">
                  {timeAgo(s.scanned_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HypothesesList({
  hypotheses,
}: {
  hypotheses: PredictData["hypotheses"];
}) {
  if (hypotheses.length === 0) {
    return (
      <p className="text-xs text-carbon-600 text-center py-8 font-mono">
        No hypotheses yet. Trading loop will generate them.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {hypotheses.map((h) => (
        <div
          key={h.id}
          className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-carbon-800/20 transition-colors"
        >
          <Brain
            className={cn(
              "w-4 h-4 shrink-0",
              h.status === "confirmed" ? "text-neon-green" : "text-neon-blue"
            )}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-carbon-300">{h.hypothesis}</p>
            <p className="text-[10px] font-mono text-carbon-500 mt-0.5">
              {h.win_count}W / {h.loss_count}L
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-xs font-mono px-2 py-0.5 rounded-full",
                h.status === "confirmed"
                  ? "bg-neon-green/10 text-neon-green"
                  : "bg-neon-blue/10 text-neon-blue"
              )}
            >
              {h.status}
            </span>
            <span className="text-xs font-mono text-carbon-400">
              {parseFloat(h.confidence).toFixed(0)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Utility ──────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
