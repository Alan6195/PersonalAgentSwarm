"use client";

import { useFetch } from "@/lib/hooks";
import { formatCost, formatTokens, timeAgo, cn, statusColor } from "@/lib/utils";
import type { DashboardStats, Agent, Task, ActivityEvent } from "@/types";
import {
  Bot,
  ListTodo,
  Clock,
  DollarSign,
  Zap,
  TrendingUp,
  AlertTriangle,
  Heart,
  ArrowRight,
  Activity,
} from "lucide-react";
import Link from "next/link";

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
  delay,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: any;
  accent?: string;
  delay?: number;
}) {
  return (
    <div
      className="card-glow p-5 animate-slide-up"
      style={{ animationDelay: `${delay || 0}ms` }}
    >
      <div className="flex items-start justify-between mb-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${accent || "#00ff9d"}15` }}
        >
          <Icon className="w-4 h-4" style={{ color: accent || "#00ff9d" }} />
        </div>
        {sub && (
          <span className="text-[11px] font-mono text-carbon-500">{sub}</span>
        )}
      </div>
      <p className="stat-value" style={{ color: accent || "#fff" }}>
        {value}
      </p>
      <p className="stat-label mt-1">{label}</p>
    </div>
  );
}

function AgentCard({ agent }: { agent: Agent & { active_tasks?: number } }) {
  return (
    <div className="card p-4 flex items-center gap-4 hover:border-carbon-700 transition-colors">
      <div className="relative">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-mono font-semibold"
          style={{
            backgroundColor: `${agent.color}15`,
            color: agent.color,
            border: `1px solid ${agent.color}30`,
          }}
        >
          {agent.name
            .split(" ")
            .map((w) => w[0])
            .join("")}
        </div>
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-carbon-900",
            agent.status === "active"
              ? "bg-neon-green"
              : agent.status === "error"
              ? "bg-neon-red"
              : "bg-carbon-600"
          )}
        />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{agent.name}</p>
        <p className="text-xs text-carbon-500 font-mono">
          {agent.model} · {agent.total_tasks} tasks · {formatCost(agent.total_cost_cents)}
        </p>
      </div>
      {(agent.active_tasks ?? 0) > 0 && (
        <span className="badge bg-neon-blue/10 text-neon-blue border-neon-blue/30">
          {agent.active_tasks} active
        </span>
      )}
    </div>
  );
}

function RecentTaskRow({ task }: { task: Task }) {
  return (
    <div className="flex items-center gap-3 py-3 table-row px-1">
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: task.agent_color || "#666" }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-carbon-200 truncate">{task.title}</p>
        <p className="text-xs text-carbon-500 font-mono">
          {task.agent_name || "unassigned"} · {timeAgo(task.created_at)}
        </p>
      </div>
      <span
        className={cn(
          "badge",
          task.status === "completed"
            ? "bg-neon-green/10 text-neon-green border-neon-green/30"
            : task.status === "failed"
            ? "bg-neon-red/10 text-neon-red border-neon-red/30"
            : task.status === "in_progress"
            ? "bg-neon-blue/10 text-neon-blue border-neon-blue/30"
            : "bg-carbon-800 text-carbon-400 border-carbon-700"
        )}
      >
        {task.status.replace("_", " ")}
      </span>
    </div>
  );
}

export default function DashboardPage() {
  const { data: stats } = useFetch<DashboardStats>("/api/stats", 15000);
  const { data: agents } = useFetch<(Agent & { active_tasks: number })[]>(
    "/api/agents",
    15000
  );
  const { data: tasks } = useFetch<Task[]>("/api/tasks?limit=8", 10000);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Mission Control
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="dot-pulse bg-neon-green" />
          <span className="text-xs font-mono text-carbon-500">
            All systems operational
          </span>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        <StatCard
          label="Active Agents"
          value={stats?.agents_active ?? 0}
          sub="/ 9 total"
          icon={Bot}
          accent="#00ff9d"
          delay={0}
        />
        <StatCard
          label="Tasks Today"
          value={stats?.tasks_today ?? 0}
          sub={`${stats?.tasks_pending ?? 0} pending`}
          icon={ListTodo}
          accent="#00d4ff"
          delay={50}
        />
        <StatCard
          label="Cost Today"
          value={formatCost(stats?.cost_today_cents ?? 0)}
          sub={`${formatCost(stats?.cost_this_week_cents ?? 0)} this week`}
          icon={DollarSign}
          accent="#ffb800"
          delay={100}
        />
        <StatCard
          label="Tokens Today"
          value={formatTokens(stats?.tokens_today ?? 0)}
          icon={Zap}
          accent="#a855f7"
          delay={150}
        />
        <StatCard
          label="Wedding Countdown"
          value={`${stats?.wedding_days_left ?? "—"}`}
          sub="days to go"
          icon={Heart}
          accent="#ec4899"
          delay={200}
        />
      </div>

      {/* Agents + Recent Tasks */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Agent Grid */}
        <div className="xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Agent Fleet</h2>
            <span className="text-xs font-mono text-carbon-500">
              {agents?.filter((a) => a.status === "active").length ?? 0} active
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents?.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
            {!agents && (
              <>
                {[...Array(9)].map((_, i) => (
                  <div
                    key={i}
                    className="card p-4 h-[72px] animate-pulse bg-carbon-900/40"
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* Recent Tasks */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Recent Tasks</h2>
            <Link
              href="/tasks"
              className="text-xs font-mono text-carbon-500 hover:text-neon-green transition-colors flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="card p-4">
            {tasks?.length ? (
              <div className="divide-y divide-carbon-800/30">
                {tasks.map((task) => (
                  <RecentTaskRow key={task.id} task={task} />
                ))}
              </div>
            ) : tasks ? (
              <div className="text-center py-8 text-carbon-500 text-sm">
                No tasks yet. The system is ready.
              </div>
            ) : (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div
                    key={i}
                    className="h-12 bg-carbon-800/30 rounded animate-pulse"
                  />
                ))}
              </div>
            )}
          </div>

          {/* Cron Status Mini */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Heartbeats</h2>
            <Link
              href="/crons"
              className="text-xs font-mono text-carbon-500 hover:text-neon-green transition-colors flex items-center gap-1"
            >
              Monitor <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-carbon-400" />
                <span className="text-sm text-carbon-300">
                  {stats?.crons_today ?? 0} runs today
                </span>
              </div>
              {(stats?.crons_failed ?? 0) > 0 ? (
                <span className="badge bg-neon-red/10 text-neon-red border-neon-red/30">
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  {stats?.crons_failed} failed
                </span>
              ) : (
                <span className="badge bg-neon-green/10 text-neon-green border-neon-green/30">
                  All clear
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
