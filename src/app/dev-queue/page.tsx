"use client";

import { useFetch } from "@/lib/hooks";
import { formatCost, cn, timeAgo } from "@/lib/utils";
import type { DevQueueItem } from "@/types";
import {
  GitBranch,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Zap,
  DollarSign,
  FileCode2,
  ChevronRight,
} from "lucide-react";

function getStatusConfig(status: string) {
  switch (status) {
    case "in_progress":
      return {
        label: "Building",
        color: "text-neon-blue",
        bg: "bg-neon-blue/10 border-neon-blue/30",
        icon: Loader2,
        iconClass: "animate-spin",
      };
    case "completed":
      return {
        label: "Shipped",
        color: "text-neon-green",
        bg: "bg-neon-green/10 border-neon-green/30",
        icon: CheckCircle2,
        iconClass: "",
      };
    case "failed":
      return {
        label: "Failed",
        color: "text-neon-red",
        bg: "bg-neon-red/10 border-neon-red/30",
        icon: XCircle,
        iconClass: "",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        color: "text-carbon-500",
        bg: "bg-carbon-800 border-carbon-700",
        icon: XCircle,
        iconClass: "",
      };
    default:
      return {
        label: "Queued",
        color: "text-amber-400",
        bg: "bg-amber-400/10 border-amber-400/30",
        icon: Clock,
        iconClass: "",
      };
  }
}

function getPriorityLabel(priority: number): { label: string; color: string } {
  if (priority >= 9) return { label: "CRITICAL", color: "text-neon-red" };
  if (priority >= 7) return { label: "HIGH", color: "text-amber-400" };
  if (priority >= 4) return { label: "NORMAL", color: "text-carbon-400" };
  return { label: "LOW", color: "text-carbon-600" };
}

export default function DevQueuePage() {
  const { data: items, loading } = useFetch<DevQueueItem[]>(
    "/api/dev-queue",
    15000
  );

  const inProgress = items?.filter((i) => i.status === "in_progress") || [];
  const pending = items?.filter((i) => i.status === "pending") || [];
  const completed = items?.filter((i) => i.status === "completed") || [];
  const failed = items?.filter((i) => i.status === "failed") || [];

  const totalCost = items?.reduce((s, i) => s + (i.cost_usd || 0), 0) || 0;
  const totalTurns = items?.reduce((s, i) => s + (i.turns_used || 0), 0) || 0;
  const totalFiles = items?.reduce(
    (s, i) => s + (i.files_modified?.length || 0),
    0
  ) || 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center gap-3">
            <GitBranch className="w-6 h-6 text-neon-green" />
            Dev Queue
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            Gilfoyle's autonomous work queue
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-amber-400" />
            <span className="text-xs text-carbon-500 font-mono uppercase">
              Queued
            </span>
          </div>
          <p className="stat-value text-amber-400">{pending.length}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Loader2 className="w-4 h-4 text-neon-blue" />
            <span className="text-xs text-carbon-500 font-mono uppercase">
              Building
            </span>
          </div>
          <p className="stat-value text-neon-blue">{inProgress.length}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="w-4 h-4 text-neon-green" />
            <span className="text-xs text-carbon-500 font-mono uppercase">
              Shipped
            </span>
          </div>
          <p className="stat-value text-neon-green">{completed.length}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-4 h-4 text-neon-purple" />
            <span className="text-xs text-carbon-500 font-mono uppercase">
              Total Cost
            </span>
          </div>
          <p className="stat-value text-neon-purple">
            ${totalCost.toFixed(2)}
          </p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <FileCode2 className="w-4 h-4 text-carbon-400" />
            <span className="text-xs text-carbon-500 font-mono uppercase">
              Files Changed
            </span>
          </div>
          <p className="stat-value">{totalFiles}</p>
        </div>
      </div>

      {/* Active Build */}
      {inProgress.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-neon-blue animate-spin" />
            Currently Building
          </h2>
          {inProgress.map((item) => (
            <div
              key={item.id}
              className="card p-5 border-neon-blue/20 bg-neon-blue/5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="text-white font-medium">{item.title}</h3>
                  <p className="text-sm text-carbon-400 mt-1 line-clamp-2">
                    {item.description}
                  </p>
                </div>
                <span className="badge bg-neon-blue/10 text-neon-blue border-neon-blue/30 shrink-0">
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Building
                </span>
              </div>
              <div className="flex items-center gap-4 mt-3 text-xs font-mono text-carbon-500">
                <span>
                  <Zap className="w-3 h-3 inline mr-1" />
                  {item.turns_used} turns
                </span>
                <span>
                  <DollarSign className="w-3 h-3 inline mr-1" />$
                  {(item.cost_usd || 0).toFixed(2)}
                </span>
                {item.files_modified?.length > 0 && (
                  <span>
                    <FileCode2 className="w-3 h-3 inline mr-1" />
                    {item.files_modified.length} files
                  </span>
                )}
                {item.assigned_at && (
                  <span>Started {timeAgo(item.assigned_at)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Queue Table */}
      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-carbon-800/50">
          <h2 className="text-sm font-semibold text-white">All Items</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-carbon-500 font-mono">
            Loading queue...
          </div>
        ) : items?.length === 0 ? (
          <div className="p-8 text-center text-carbon-500 font-mono">
            Queue is empty. Send /ship via Telegram to add work.
          </div>
        ) : (
          <div className="divide-y divide-carbon-800/50">
            {items?.map((item) => {
              const statusCfg = getStatusConfig(item.status);
              const priorityCfg = getPriorityLabel(item.priority);
              const StatusIcon = statusCfg.icon;

              return (
                <div
                  key={item.id}
                  className={cn(
                    "px-6 py-4 transition-colors hover:bg-carbon-900/50",
                    item.status === "in_progress" && "bg-neon-blue/5"
                  )}
                >
                  <div className="flex items-start gap-4">
                    {/* Status Icon */}
                    <div className="pt-0.5 shrink-0">
                      <StatusIcon
                        className={cn(
                          "w-4 h-4",
                          statusCfg.color,
                          statusCfg.iconClass
                        )}
                      />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">
                          {item.title}
                        </span>
                        <span
                          className={cn(
                            "text-[10px] font-mono uppercase",
                            priorityCfg.color
                          )}
                        >
                          {priorityCfg.label}
                        </span>
                      </div>
                      <p className="text-xs text-carbon-500 mt-0.5 line-clamp-1">
                        {item.description}
                      </p>

                      {/* Result Summary (for completed/failed) */}
                      {item.result_summary && (
                        <p className="text-xs text-carbon-400 mt-1.5 line-clamp-2 bg-carbon-900/50 rounded px-2 py-1">
                          {item.result_summary}
                        </p>
                      )}
                      {item.error_message && (
                        <p className="text-xs text-neon-red mt-1.5 line-clamp-2 bg-neon-red/5 rounded px-2 py-1">
                          {item.error_message}
                        </p>
                      )}

                      {/* Meta row */}
                      <div className="flex items-center gap-3 mt-2 text-[11px] font-mono text-carbon-600">
                        {item.turns_used > 0 && (
                          <span>{item.turns_used} turns</span>
                        )}
                        {(item.cost_usd || 0) > 0 && (
                          <span>${item.cost_usd.toFixed(2)}</span>
                        )}
                        {item.files_modified?.length > 0 && (
                          <span>{item.files_modified.length} files</span>
                        )}
                        <span>{timeAgo(item.created_at)}</span>
                      </div>

                      {/* Files Modified (expandable for completed) */}
                      {item.files_modified?.length > 0 &&
                        item.status === "completed" && (
                          <details className="mt-2">
                            <summary className="text-[11px] font-mono text-carbon-500 cursor-pointer hover:text-carbon-300 flex items-center gap-1">
                              <ChevronRight className="w-3 h-3" />
                              {item.files_modified.length} files modified
                            </summary>
                            <div className="mt-1 pl-4 space-y-0.5">
                              {item.files_modified.map((f, i) => (
                                <p
                                  key={i}
                                  className="text-[11px] font-mono text-carbon-600 truncate"
                                >
                                  {f}
                                </p>
                              ))}
                            </div>
                          </details>
                        )}
                    </div>

                    {/* Status Badge */}
                    <span
                      className={cn(
                        "badge shrink-0",
                        statusCfg.bg,
                        statusCfg.color
                      )}
                    >
                      {statusCfg.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
