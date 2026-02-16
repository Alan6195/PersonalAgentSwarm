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
          style={{ backgroundColor: `${accent || "#6b8f71"}12` }}
        >
          <Icon className="w-4 h-4" style={{ color: accent || "#6b8f71" }} />
        </div>
        {sub && (
          <span className="text-[11px] font-mono text-cream-500">{sub}</span>
        )}
      </div>
      <p className="stat-value" style={{ color: accent ? undefined : undefined }}>
        {value}
      </p>
      <p className="stat-label mt-1">{label}</p>
    </div>
  );
}

function AgentCard({ agent }: { agent: Agent & { active_tasks?: number } }) {
  return (
    <div className="card p-4 flex items-center gap-4 hover:border-cream-400 transition-colors">
      <div className="relative">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-mono font-semibold"
          style={{
            backgroundColor: `${agent.color}12`,
            color: agent.color,
            border: `1px solid ${agent.color}25`,
          }}
        >
          {agent.name
            .split(" ")
            .map((w) => w[0])
            .join("")}
        </div>
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white",
            agent.status === "active"
              ? "bg-accent-green"
              : agent.status === "error"
              ? "bg-accent-red"
              : "bg-cream-400"
          )}
        />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-cream-900 truncate">{agent.name}</p>
        <p className="text-xs text-cream-500 font-mono">
          {agent.model} · {agent.total_tasks} tasks · {formatCost(agent.total_cost_cents)}
        </p>
      </div>
      {(agent.active_tasks ?? 0) > 0 && (
        <span className="badge bg-accent-blue/10 text-accent-blue border-accent-blue/20">
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
        style={{ backgroundColor: task.agent_color || "#b8b0a2" }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-cream-800 truncate">{task.title}</p>
        <p className="text-xs text-cream-500 font-mono">
          {task.agent_name || "unassigned"} · {timeAgo(task.created_at)}
        </p>
      </div>
      <span
        className={cn(
          "badge",
          task.status === "completed"
            ? "bg-accent-green/10 text-accent-green border-accent-green/20"
            : task.status === "failed"
            ? "bg-accent-red/10 text-accent-red border-accent-red/20"
            : task.status === "in_progress"
            ? "bg-accent-blue/10 text-accent-blue border-accent-blue/20"
            : "bg-cream-200 text-cream-600 border-cream-300"
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
          <h1 className="text-2xl font-semibold text-cream-900 tracking-tight">
            Mission Control
          </h1>
          <p className="text-sm text-cream-500 font-mono mt-1">
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="dot-pulse bg-accent-green" />
          <span className="text-xs font-mono text-cream-500">
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
          accent="#6b8f71"
          delay={0}
        />
        <StatCard
          label="Tasks Today"
          value={stats?.tasks_today ?? 0}
          sub={`${stats?.tasks_pending ?? 0} pending`}
          icon={ListTodo}
          accent="#4a8fe7"
          delay={50}
        />
        <StatCard
          label="Cost Today"
          value={formatCost(stats?.cost_today_cents ?? 0)}
          sub={`${formatCost(stats?.cost_this_week_cents ?? 0)} this week`}
          icon={DollarSign}
          accent="#d4940a"
          delay={100}
        />
        <StatCard
          label="Tokens Today"
          value={formatTokens(stats?.tokens_today ?? 0)}
          icon={Zap}
          accent="#8b5cf6"
          delay={150}
        />
        <StatCard
          label="Wedding Countdown"
          value={`${stats?.wedding_days_left ?? "\u2014"}`}
          sub="days to go"
          icon={Heart}
          accent="#d946a8"
          delay={200}
        />
      </div>

      {/* Agents + Recent Tasks */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Agent Grid */}
        <div className="xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-cream-800">Agent Fleet</h2>
            <span className="text-xs font-mono text-cream-500">
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
                    className="card p-4 h-[72px] animate-pulse bg-cream-200/40"
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* Recent Tasks */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-cream-800">Recent Tasks</h2>
            <Link
              href="/tasks"
              className="text-xs font-mono text-cream-500 hover:text-sage-500 transition-colors flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="card p-4">
            {tasks?.length ? (
              <div className="divide-y divide-cream-200">
                {tasks.map((task) => (
                  <RecentTaskRow key={task.id} task={task} />
                ))}
              </div>
            ) : tasks ? (
              <div className="text-center py-8 text-cream-500 text-sm">
                No tasks yet. The system is ready.
              </div>
            ) : (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div
                    key={i}
                    className="h-12 bg-cream-200/30 rounded animate-pulse"
                  />
                ))}
              </div>
            )}
          </div>

          {/* Cron Status Mini */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-cream-800">Heartbeats</h2>
            <Link
              href="/crons"
              className="text-xs font-mono text-cream-500 hover:text-sage-500 transition-colors flex items-center gap-1"
            >
              Monitor <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-cream-500" />
                <span className="text-sm text-cream-700">
                  {stats?.crons_today ?? 0} runs today
                </span>
              </div>
              {(stats?.crons_failed ?? 0) > 0 ? (
                <span className="badge bg-accent-red/10 text-accent-red border-accent-red/20">
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  {stats?.crons_failed} failed
                </span>
              ) : (
                <span className="badge bg-accent-green/10 text-accent-green border-accent-green/20">
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
