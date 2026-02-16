"use client";

import { useState } from "react";
import { useFetch } from "@/lib/hooks";
import { formatCost, formatTokens, cn } from "@/lib/utils";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Zap,
  BarChart3,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from "recharts";

interface CostData {
  daily: {
    date: string;
    total_cost_cents: number;
    total_tokens: number;
    opus_cost_cents: number;
    sonnet_cost_cents: number;
    haiku_cost_cents: number;
    task_count: number;
    cron_count: number;
  }[];
  byAgent: {
    id: string;
    name: string;
    color: string;
    total_cost: number;
    total_tokens: number;
    event_count: number;
  }[];
  byModel: {
    model: string;
    total_cost: number;
    total_tokens: number;
    event_count: number;
  }[];
}

const MODEL_COLORS: Record<string, string> = {
  opus: "#8b5cf6",
  sonnet: "#4a8fe7",
  haiku: "#22c55e",
};

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-cream-400 rounded-lg px-3 py-2 shadow-xl">
      <p className="text-xs font-mono text-cream-500 mb-1">{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} className="text-xs font-mono" style={{ color: p.color }}>
          {p.name}: {typeof p.value === "number" && p.dataKey?.includes("cost")
            ? formatCost(p.value)
            : formatTokens(p.value)}
        </p>
      ))}
    </div>
  );
}

export default function CostTrackerPage() {
  const [days, setDays] = useState(30);
  const { data } = useFetch<CostData>(`/api/costs?days=${days}`, 30000);

  const totalCost = data?.daily.reduce((s, d) => s + d.total_cost_cents, 0) ?? 0;
  const totalTokens = data?.daily.reduce((s, d) => s + d.total_tokens, 0) ?? 0;
  const avgDailyCost = data?.daily.length ? totalCost / data.daily.length : 0;

  const chartData =
    data?.daily.map((d) => ({
      date: new Date(d.date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      cost: d.total_cost_cents,
      opus: d.opus_cost_cents,
      sonnet: d.sonnet_cost_cents,
      haiku: d.haiku_cost_cents,
      tokens: d.total_tokens,
      tasks: d.task_count,
    })) || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-cream-900 tracking-tight">
            Cost Tracker
          </h1>
          <p className="text-sm text-cream-500 font-mono mt-1">
            API spend and token usage
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-mono transition-colors",
                days === d
                  ? "bg-cream-300 text-cream-900 border border-cream-500"
                  : "text-cream-500 hover:text-cream-700"
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card-glow p-5">
          <DollarSign className="w-4 h-4 text-accent-amber mb-3" />
          <p className="stat-value text-accent-amber">{formatCost(totalCost)}</p>
          <p className="stat-label mt-1">{days}-Day Total</p>
        </div>
        <div className="card-glow p-5">
          <TrendingUp className="w-4 h-4 text-cream-500 mb-3" />
          <p className="stat-value">{formatCost(avgDailyCost)}</p>
          <p className="stat-label mt-1">Avg / Day</p>
        </div>
        <div className="card-glow p-5">
          <Zap className="w-4 h-4 text-accent-purple mb-3" />
          <p className="stat-value text-accent-purple">
            {formatTokens(totalTokens)}
          </p>
          <p className="stat-label mt-1">{days}-Day Tokens</p>
        </div>
        <div className="card-glow p-5">
          <BarChart3 className="w-4 h-4 text-accent-blue mb-3" />
          <p className="stat-value">
            {formatCost(totalCost / (days / 30))}
          </p>
          <p className="stat-label mt-1">Projected / Month</p>
        </div>
      </div>

      {/* Daily Cost Chart */}
      <div className="card p-6">
        <h2 className="text-sm font-semibold text-cream-900 mb-4">
          Daily Spend (Stacked by Model)
        </h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="gradOpus" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="gradSonnet" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4a8fe7" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#4a8fe7" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="gradHaiku" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tick={{ fill: "#737384", fontSize: 10, fontFamily: "JetBrains Mono" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#737384", fontSize: 10, fontFamily: "JetBrains Mono" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${(v / 100).toFixed(0)}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="opus"
                name="Opus"
                stackId="1"
                stroke="#8b5cf6"
                fill="url(#gradOpus)"
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="sonnet"
                name="Sonnet"
                stackId="1"
                stroke="#4a8fe7"
                fill="url(#gradSonnet)"
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="haiku"
                name="Haiku"
                stackId="1"
                stroke="#22c55e"
                fill="url(#gradHaiku)"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* By Agent + By Model */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Cost by Agent */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-cream-900 mb-4">
            Spend by Agent
          </h2>
          <div className="space-y-3">
            {data?.byAgent
              .filter((a) => a.total_cost > 0)
              .map((agent) => {
                const pct =
                  totalCost > 0
                    ? Math.round((agent.total_cost / totalCost) * 100)
                    : 0;
                return (
                  <div key={agent.id} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: agent.color }}
                        />
                        <span className="text-sm text-cream-700">
                          {agent.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-cream-500">
                          {formatTokens(agent.total_tokens)} tokens
                        </span>
                        <span className="text-xs font-mono text-cream-900">
                          {formatCost(agent.total_cost)}
                        </span>
                      </div>
                    </div>
                    <div className="w-full h-1.5 bg-cream-300 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: agent.color,
                          opacity: 0.7,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            {data?.byAgent.filter((a) => a.total_cost > 0).length === 0 && (
              <p className="text-xs text-cream-500 text-center py-8 font-mono">
                No cost data yet
              </p>
            )}
          </div>
        </div>

        {/* Cost by Model */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-cream-900 mb-4">
            Spend by Model
          </h2>
          <div className="flex items-center justify-center h-48">
            {data?.byModel && data.byModel.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.byModel.map((m) => ({
                      name: m.model,
                      value: m.total_cost,
                    }))}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={3}
                    dataKey="value"
                    stroke="none"
                  >
                    {data.byModel.map((m, i) => (
                      <Cell
                        key={i}
                        fill={MODEL_COLORS[m.model] || "#666"}
                        opacity={0.8}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-xs text-cream-500 font-mono">
                No model data yet
              </p>
            )}
          </div>
          {data?.byModel && (
            <div className="flex items-center justify-center gap-4 sm:gap-6 mt-2 flex-wrap">
              {data.byModel.map((m) => (
                <div key={m.model} className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{
                      backgroundColor: MODEL_COLORS[m.model] || "#666",
                    }}
                  />
                  <span className="text-xs font-mono text-cream-500 capitalize">
                    {m.model}
                  </span>
                  <span className="text-xs font-mono text-cream-500">
                    {formatCost(m.total_cost)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
