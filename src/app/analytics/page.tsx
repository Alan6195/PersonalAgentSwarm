"use client";

import { useState } from "react";
import { useFetch } from "@/lib/hooks";
import { formatTokens, timeAgo, cn } from "@/lib/utils";
import {
  BarChart3,
  Activity,
  GitBranch,
  Radio,
  ArrowRight,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";

interface AnalyticsData {
  activity: {
    id: number;
    event_type: string;
    agent_id: string | null;
    task_id: number | null;
    channel: string | null;
    summary: string;
    created_at: string;
    agent_name?: string;
    agent_color?: string;
  }[];
  tasksByDay: {
    date: string;
    total: number;
    completed: number;
    failed: number;
  }[];
  tasksByAgent: {
    id: string;
    name: string;
    color: string;
    total: number;
    completed: number;
    avg_duration_ms: number;
    avg_tokens: number;
  }[];
  delegations: {
    from_agent: string;
    to_agent: string;
    count: number;
  }[];
  channelBreakdown: {
    channel: string;
    count: number;
  }[];
}

const CHANNEL_COLORS: Record<string, string> = {
  telegram: "#0088cc",
  sms: "#22c55e",
  voice: "#f97316",
  slack: "#e01e5a",
  internal: "#737384",
};

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-carbon-900 border border-carbon-700 rounded-lg px-3 py-2 shadow-xl">
      <p className="text-xs font-mono text-carbon-400 mb-1">{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} className="text-xs font-mono" style={{ color: p.color }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
}

const AGENT_NAMES: Record<string, string> = {
  "alan-os": "Alan OS",
  "ascend-builder": "Ascend Builder",
  "legal-advisor": "Legal Advisor",
  "social-media": "Social Media",
  "wedding-planner": "Wedding Planner",
  "life-admin": "Life Admin",
  "research-analyst": "Research Analyst",
  "comms-drafter": "Comms Drafter",
};

export default function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const { data } = useFetch<AnalyticsData>(
    `/api/analytics?days=${days}`,
    30000
  );

  const taskChartData =
    data?.tasksByDay.map((d) => ({
      date: new Date(d.date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      completed: Number(d.completed),
      failed: Number(d.failed),
      total: Number(d.total),
    })) || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Analytics
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            System performance and activity
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
                  ? "bg-carbon-800 text-white border border-carbon-600"
                  : "text-carbon-500 hover:text-carbon-300"
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Task Throughput */}
      <div className="card p-6">
        <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-neon-blue" />
          Task Throughput
        </h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={taskChartData} barGap={2}>
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
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar
                dataKey="completed"
                name="Completed"
                fill="#00ff9d"
                radius={[3, 3, 0, 0]}
                opacity={0.7}
              />
              <Bar
                dataKey="failed"
                name="Failed"
                fill="#ff3d5a"
                radius={[3, 3, 0, 0]}
                opacity={0.7}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Agent Performance */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Activity className="w-4 h-4 text-neon-green" />
            Agent Performance
          </h2>
          <div className="space-y-3">
            {data?.tasksByAgent
              .filter((a) => Number(a.total) > 0)
              .map((agent) => {
                const successRate =
                  Number(agent.total) > 0
                    ? Math.round(
                        (Number(agent.completed) / Number(agent.total)) * 100
                      )
                    : 0;
                const avgDuration = agent.avg_duration_ms
                  ? (Number(agent.avg_duration_ms) / 1000).toFixed(1)
                  : "—";

                return (
                  <div
                    key={agent.id}
                    className="flex items-center gap-4 py-2.5 px-3 rounded-lg hover:bg-carbon-800/30 transition-colors"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: agent.color }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-carbon-200">{agent.name}</p>
                    </div>
                    <div className="flex items-center gap-3 sm:gap-5 text-xs font-mono flex-wrap">
                      <span className="text-carbon-400">
                        {agent.total} tasks
                      </span>
                      <span
                        className={cn(
                          successRate >= 90
                            ? "text-neon-green"
                            : successRate >= 70
                            ? "text-neon-amber"
                            : "text-neon-red"
                        )}
                      >
                        {successRate}%
                      </span>
                      <span className="text-carbon-500">{avgDuration}s avg</span>
                      <span className="text-carbon-500">
                        {formatTokens(Number(agent.avg_tokens) || 0)} avg tokens
                      </span>
                    </div>
                  </div>
                );
              })}
            {(!data?.tasksByAgent ||
              data.tasksByAgent.filter((a) => Number(a.total) > 0).length === 0) && (
              <p className="text-xs text-carbon-600 text-center py-8 font-mono">
                No agent activity yet
              </p>
            )}
          </div>
        </div>

        {/* Delegation Flow */}
        <div className="card p-6">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-neon-purple" />
            Delegation Flow
          </h2>
          {data?.delegations && data.delegations.length > 0 ? (
            <div className="space-y-2">
              {data.delegations.map((d, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-carbon-800/30 transition-colors"
                >
                  <span className="text-xs font-mono text-carbon-300 w-20 sm:w-28 truncate">
                    {AGENT_NAMES[d.from_agent] || d.from_agent}
                  </span>
                  <ArrowRight className="w-3 h-3 text-neon-purple shrink-0" />
                  <span className="text-xs font-mono text-carbon-300 w-20 sm:w-28 truncate">
                    {AGENT_NAMES[d.to_agent] || d.to_agent}
                  </span>
                  <div className="flex-1" />
                  <span className="text-xs font-mono text-neon-purple">
                    {d.count}x
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-carbon-600 text-center py-8 font-mono">
              No delegations yet
            </p>
          )}

          {/* Channel Breakdown */}
          {data?.channelBreakdown && data.channelBreakdown.length > 0 && (
            <>
              <div className="border-t border-carbon-800/50 my-5" />
              <h3 className="text-xs font-semibold text-carbon-400 mb-3 flex items-center gap-2">
                <Radio className="w-3 h-3" />
                By Channel
              </h3>
              <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
                {data.channelBreakdown.map((ch) => (
                  <div key={ch.channel} className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{
                        backgroundColor:
                          CHANNEL_COLORS[ch.channel] || "#737384",
                      }}
                    />
                    <span className="text-xs font-mono text-carbon-400 capitalize">
                      {ch.channel}
                    </span>
                    <span className="text-xs font-mono text-carbon-600">
                      {ch.count}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Activity Feed */}
      <div className="card p-6">
        <h2 className="text-sm font-semibold text-white mb-4">
          Activity Feed
        </h2>
        <div className="space-y-1 max-h-96 overflow-auto">
          {data?.activity.map((event) => (
            <div
              key={event.id}
              className="flex items-start gap-3 py-2.5 px-3 rounded-lg hover:bg-carbon-800/20 transition-colors"
            >
              {event.agent_color ? (
                <span
                  className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                  style={{ backgroundColor: event.agent_color }}
                />
              ) : (
                <span className="w-2 h-2 rounded-full mt-1.5 shrink-0 bg-carbon-600" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-carbon-300">{event.summary}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-[10px] font-mono text-carbon-600">
                    {event.agent_name || "system"}
                  </span>
                  {event.channel && (
                    <span className="text-[10px] font-mono text-carbon-600 capitalize">
                      via {event.channel}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-[10px] font-mono text-carbon-600 shrink-0">
                {timeAgo(event.created_at)}
              </span>
            </div>
          ))}
          {data?.activity.length === 0 && (
            <p className="text-xs text-carbon-600 text-center py-8 font-mono">
              No activity yet. The system is waiting.
            </p>
          )}
          {!data && (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="h-12 bg-carbon-800/20 rounded animate-pulse"
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
