"use client";

import { useState } from "react";
import { useFetch } from "@/lib/hooks";
import {
  cn,
  timeAgo,
  formatCost,
  formatTokens,
  priorityColor,
  priorityBg,
  statusColor,
} from "@/lib/utils";
import type { Task } from "@/types";
import {
  ListTodo,
  Clock,
  Play,
  CheckCircle2,
  XCircle,
  ArrowUpRight,
  Filter,
  Plus,
  ChevronDown,
} from "lucide-react";

const STATUS_COLUMNS = [
  {
    key: "pending",
    label: "Pending",
    icon: Clock,
    accent: "text-cream-500",
    border: "border-cream-300",
  },
  {
    key: "in_progress",
    label: "In Progress",
    icon: Play,
    accent: "text-accent-blue",
    border: "border-accent-blue/30",
  },
  {
    key: "delegated",
    label: "Delegated",
    icon: ArrowUpRight,
    accent: "text-accent-purple",
    border: "border-accent-purple/30",
  },
  {
    key: "completed",
    label: "Completed",
    icon: CheckCircle2,
    accent: "text-accent-green",
    border: "border-accent-green/30",
  },
  {
    key: "failed",
    label: "Failed",
    icon: XCircle,
    accent: "text-accent-red",
    border: "border-accent-red/30",
  },
];

function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "rounded-lg p-3.5 border cursor-pointer transition-all hover:border-cream-400",
        priorityBg(task.priority)
      )}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2 mb-2">
        {task.agent_color && (
          <span
            className="w-2 h-2 rounded-full mt-1.5 shrink-0"
            style={{ backgroundColor: task.agent_color }}
          />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-cream-800 leading-snug">
            {task.title}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn("text-[10px] font-mono uppercase", priorityColor(task.priority))}>
          {task.priority}
        </span>
        {task.agent_name && (
          <span className="text-[10px] font-mono text-cream-500">
            {task.agent_name}
          </span>
        )}
        <span className="text-[10px] font-mono text-cream-500 ml-auto">
          {timeAgo(task.created_at)}
        </span>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-cream-200 space-y-2">
          {task.description && (
            <p className="text-xs text-cream-500 leading-relaxed">
              {task.description}
            </p>
          )}
          {task.output_summary && (
            <div className="bg-cream-100/50 rounded p-2">
              <p className="text-[10px] font-mono text-cream-500 mb-1">
                Output:
              </p>
              <p className="text-xs text-cream-700">{task.output_summary}</p>
            </div>
          )}
          {task.error_message && (
            <div className="bg-accent-red/5 rounded p-2">
              <p className="text-[10px] font-mono text-accent-red mb-1">
                Error:
              </p>
              <p className="text-xs text-accent-red/80">{task.error_message}</p>
            </div>
          )}
          <div className="flex items-center gap-4 text-[10px] font-mono text-cream-500">
            {task.tokens_used > 0 && (
              <span>{formatTokens(task.tokens_used)} tokens</span>
            )}
            {task.cost_cents > 0 && (
              <span>{formatCost(task.cost_cents)}</span>
            )}
            {task.duration_ms && (
              <span>{(task.duration_ms / 1000).toFixed(1)}s</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function TaskBoardPage() {
  const [filterAgent, setFilterAgent] = useState<string>("");
  const [filterPriority, setFilterPriority] = useState<string>("");
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set());

  const toggleCol = (key: string) => {
    setCollapsedCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const url = `/api/tasks?limit=100${
    filterAgent ? `&agent=${filterAgent}` : ""
  }${filterPriority ? `&priority=${filterPriority}` : ""}`;

  const { data: tasks, loading } = useFetch<Task[]>(url, 10000);

  const grouped = STATUS_COLUMNS.map((col) => ({
    ...col,
    tasks: (tasks || []).filter((t) => t.status === col.key),
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-cream-900 tracking-tight">
            Task Board
          </h1>
          <p className="text-sm text-cream-500 font-mono mt-1">
            {tasks?.length ?? 0} tasks
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="bg-white border border-cream-300 rounded-lg px-3 py-1.5 text-xs font-mono text-cream-700 focus:outline-none focus:border-cream-500"
          >
            <option value="">All agents</option>
            <option value="alan-os">Alan OS</option>
            <option value="ascend-builder">Ascend Builder</option>
            <option value="legal-advisor">Legal Advisor</option>
            <option value="social-media">Social Media</option>
            <option value="wedding-planner">Wedding Planner</option>
            <option value="life-admin">Life Admin</option>
            <option value="research-analyst">Research Analyst</option>
            <option value="comms-drafter">Comms Drafter</option>
          </select>
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            className="bg-white border border-cream-300 rounded-lg px-3 py-1.5 text-xs font-mono text-cream-700 focus:outline-none focus:border-cream-500"
          >
            <option value="">All priorities</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      {/* Kanban Columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 min-h-0 xl:min-h-[600px]">
        {grouped.map((col) => (
          <div key={col.key} className="space-y-3">
            {/* Column Header */}
            <div
              className={cn(
                "flex items-center gap-2 pb-3 border-b cursor-pointer xl:cursor-default",
                col.border
              )}
              onClick={() => toggleCol(col.key)}
            >
              <col.icon className={cn("w-4 h-4", col.accent)} />
              <span className={cn("text-sm font-medium", col.accent)}>
                {col.label}
              </span>
              <span className="text-xs font-mono text-cream-500 ml-auto">
                {col.tasks.length}
              </span>
              <ChevronDown
                className={cn(
                  "w-4 h-4 text-cream-500 xl:hidden transition-transform",
                  !collapsedCols.has(col.key) && "rotate-180"
                )}
              />
            </div>

            {/* Cards */}
            <div
              className={cn(
                "space-y-2",
                collapsedCols.has(col.key) && "hidden xl:block"
              )}
            >
              {col.tasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
              {col.tasks.length === 0 && (
                <div className="rounded-lg border border-dashed border-cream-300 p-6 text-center">
                  <p className="text-xs text-cream-500 font-mono">Empty</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
