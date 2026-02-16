"use client";

import { useState } from "react";
import { useFetch } from "@/lib/hooks";
import { cn, timeAgo, formatCost, formatTokens, statusColor } from "@/lib/utils";
import type { CronJob, CronRun } from "@/types";
import {
  Clock,
  CheckCircle2,
  XCircle,
  Play,
  Pause,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Activity,
  Timer,
} from "lucide-react";

function parseCron(schedule: string): string {
  const parts = schedule.split(" ");
  if (parts.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = parts;

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayStr =
    dow === "*"
      ? "Every day"
      : dow === "1-5"
      ? "Mon-Fri"
      : dow === "0"
      ? "Sundays"
      : `Day ${dow}`;

  const domStr = dom !== "*" ? ` (${dom}th)` : "";
  const timeStr = `${hour.padStart(2, "0")}:${min.padStart(2, "0")} MT`;

  return `${dayStr}${domStr} at ${timeStr}`;
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; icon: any }> = {
    success: {
      bg: "bg-neon-green/10 border-neon-green/30",
      text: "text-neon-green",
      icon: CheckCircle2,
    },
    failed: {
      bg: "bg-neon-red/10 border-neon-red/30",
      text: "text-neon-red",
      icon: XCircle,
    },
    running: {
      bg: "bg-neon-blue/10 border-neon-blue/30",
      text: "text-neon-blue",
      icon: Play,
    },
    pending: {
      bg: "bg-carbon-800 border-carbon-700",
      text: "text-carbon-400",
      icon: Clock,
    },
  };
  const c = config[status] || config.pending;
  return (
    <span className={cn("badge", c.bg, c.text)}>
      <c.icon className="w-3 h-3 mr-1" />
      {status}
    </span>
  );
}

function CronJobCard({
  job,
  isExpanded,
  onToggle,
}: {
  job: CronJob;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { data: runs } = useFetch<CronRun[]>(
    isExpanded ? `/api/crons/runs?job_id=${job.id}&limit=10` : "",
    isExpanded ? 30000 : undefined
  );

  const successRate =
    job.run_count > 0
      ? Math.round(((job.run_count - job.fail_count) / job.run_count) * 100)
      : 100;

  return (
    <div
      className={cn(
        "card overflow-hidden transition-all",
        !job.enabled && "opacity-50"
      )}
    >
      <div
        className="p-5 cursor-pointer hover:bg-carbon-800/20 transition-colors"
        onClick={onToggle}
      >
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
          {/* Agent color dot */}
          <div className="flex items-center gap-3 sm:gap-4">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
              style={{
                backgroundColor: `${job.agent_color || "#666"}15`,
                border: `1px solid ${job.agent_color || "#666"}30`,
              }}
            >
              <Clock
                className="w-4 h-4"
                style={{ color: job.agent_color || "#666" }}
              />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-white">{job.name}</h3>
                {!job.enabled && (
                  <span className="badge bg-carbon-800 text-carbon-500 border-carbon-700">
                    <Pause className="w-3 h-3 mr-1" />
                    paused
                  </span>
                )}
              </div>
              <p className="text-xs text-carbon-500 mt-0.5">
                {job.description}
              </p>
              <p className="text-[11px] font-mono text-carbon-600 mt-1">
                {parseCron(job.schedule)} · {job.agent_name}
              </p>
            </div>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-3 sm:gap-6 shrink-0 flex-wrap pl-13 sm:pl-0">
            <div className="text-right">
              <p className="text-xs font-mono text-carbon-400">
                {job.run_count} runs
              </p>
              <p className="text-[10px] font-mono text-carbon-600">
                {successRate}% success
              </p>
            </div>

            <StatusBadge status={job.last_status} />

            <div className="text-right">
              <p className="text-xs font-mono text-carbon-500">
                {job.last_run_at ? timeAgo(job.last_run_at) : "never"}
              </p>
            </div>

            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-carbon-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-carbon-500" />
            )}
          </div>
        </div>
      </div>

      {/* Expanded: Run History */}
      {isExpanded && (
        <div className="border-t border-carbon-800/50 px-5 pb-4">
          <div className="flex items-center gap-2 py-3">
            <Activity className="w-3 h-3 text-carbon-500" />
            <p className="text-[10px] font-mono uppercase tracking-widest text-carbon-500">
              Recent Runs
            </p>
          </div>

          {runs && runs.length > 0 ? (
            <div className="space-y-1">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="flex flex-wrap items-center gap-2 sm:gap-4 py-2 px-3 rounded-lg hover:bg-carbon-800/30 transition-colors"
                >
                  <StatusBadge status={run.status} />
                  <span className="text-xs text-carbon-400 font-mono flex-1 min-w-[140px]">
                    {new Date(run.started_at).toLocaleString()}
                  </span>
                  <div className="flex items-center gap-3 sm:gap-4 text-xs text-carbon-500 font-mono">
                    {run.duration_ms && (
                      <span className="flex items-center gap-1">
                        <Timer className="w-3 h-3" />
                        {(run.duration_ms / 1000).toFixed(1)}s
                      </span>
                    )}
                    <span>{formatTokens(run.tokens_used)} tokens</span>
                    <span>{formatCost(run.cost_cents)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : runs ? (
            <p className="text-xs text-carbon-600 py-4 text-center font-mono">
              No runs yet
            </p>
          ) : (
            <div className="space-y-2 py-2">
              {[...Array(3)].map((_, i) => (
                <div
                  key={i}
                  className="h-8 bg-carbon-800/20 rounded animate-pulse"
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CronMonitorPage() {
  const { data: jobs } = useFetch<CronJob[]>("/api/crons", 15000);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Cron Monitor
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            {jobs?.length ?? 0} heartbeat jobs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="dot-pulse bg-neon-green" />
          <span className="text-xs font-mono text-carbon-500">
            Scheduler active
          </span>
        </div>
      </div>

      {/* Summary Bar */}
      {jobs && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="card p-4 text-center">
            <p className="stat-value text-xl">{jobs.length}</p>
            <p className="stat-label">Total Jobs</p>
          </div>
          <div className="card p-4 text-center">
            <p className="stat-value text-xl text-neon-green">
              {jobs.filter((j) => j.enabled).length}
            </p>
            <p className="stat-label">Enabled</p>
          </div>
          <div className="card p-4 text-center">
            <p className="stat-value text-xl text-neon-green">
              {jobs.filter((j) => j.last_status === "success").length}
            </p>
            <p className="stat-label">Last OK</p>
          </div>
          <div className="card p-4 text-center">
            <p className="stat-value text-xl text-neon-red">
              {jobs.filter((j) => j.last_status === "failed").length}
            </p>
            <p className="stat-label">Last Failed</p>
          </div>
        </div>
      )}

      {/* Job List */}
      <div className="space-y-3">
        {jobs?.map((job) => (
          <CronJobCard
            key={job.id}
            job={job}
            isExpanded={expandedId === job.id}
            onToggle={() =>
              setExpandedId(expandedId === job.id ? null : job.id)
            }
          />
        ))}
        {!jobs && (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="card h-24 animate-pulse bg-carbon-900/40"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
