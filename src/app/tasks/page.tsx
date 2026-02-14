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
} from "lucide-react";

const STATUS_COLUMNS = [
  {
    key: "pending",
    label: "Pending",
    icon: Clock,
    accent: "text-carbon-400",
    border: "border-carbon-700",
  },
  {
    key: "in_progress",
    label: "In Progress",
    icon: Play,
    accent: "text-neon-blue",
    border: "border-neon-blue/30",
  },
  {
    key: "delegated",
    label: "Delegated",
    icon: ArrowUpRight,
    accent: "text-neon-purple",
    border: "border-neon-purple/30",
  },
  {
    key: "completed",
    label: "Completed",
    icon: CheckCircle2,
    accent: "text-neon-green",
    border: "border-neon-green/30",
  },
  {
    key: "failed",
    label: "Failed",
    icon: XCircle,
    accent: "text-neon-red",
    border: "border-neon-red/30",
  },
];

function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "rounded-lg p-3.5 border cursor-pointer transition-all hover:border-carbon-600",
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
          <p className="text-sm font-medium text-carbon-100 leading-snug">
            {task.title}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn("text-[10px] font-mono uppercase", priorityColor(task.priority))}>
          {task.priority}
        </span>
        {task.agent_name && (
          <span className="text-[10px] font-mono text-carbon-500">
            {task.agent_name}
          </span>
        )}
        <span className="text-[10px] font-mono text-carbon-600 ml-auto">
          {timeAgo(task.created_at)}
        </span>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-carbon-800/50 space-y-2">
          {task.description && (
            <p className="text-xs text-carbon-400 leading-relaxed">
              {task.description}
            </p>
          )}
          {task.output_summary && (
            <div className="bg-carbon-950/50 rounded p-2">
              <p className="text-[10px] font-mono text-carbon-500 mb-1">
                Output:
              </p>
              <p className="text-xs text-carbon-300">{task.output_summary}</p>
            </div>
          )}
          {task.error_message && (
            <div className="bg-neon-red/5 rounded p-2">
              <p className="text-[10px] font-mono text-neon-red mb-1">
                Error:
              </p>
              <p className="text-xs text-neon-red/80">{task.error_message}</p>
            </div>
          )}
          <div className="flex items-center gap-4 text-[10px] font-mono text-carbon-600">
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Task Board
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            {tasks?.length ?? 0} tasks
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="bg-carbon-900 border border-carbon-700 rounded-lg px-3 py-1.5 text-xs font-mono text-carbon-300 focus:outline-none focus:border-carbon-500"
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
            className="bg-carbon-900 border border-carbon-700 rounded-lg px-3 py-1.5 text-xs font-mono text-carbon-300 focus:outline-none focus:border-carbon-500"
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
      <div className="grid grid-cols-5 gap-4 min-h-[600px]">
        {grouped.map((col) => (
          <div key={col.key} className="space-y-3">
            {/* Column Header */}
            <div
              className={cn(
                "flex items-center gap-2 pb-3 border-b",
                col.border
              )}
            >
              <col.icon className={cn("w-4 h-4", col.accent)} />
              <span className={cn("text-sm font-medium", col.accent)}>
                {col.label}
              </span>
              <span className="text-xs font-mono text-carbon-600 ml-auto">
                {col.tasks.length}
              </span>
            </div>

            {/* Cards */}
            <div className="space-y-2">
              {col.tasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
              {col.tasks.length === 0 && (
                <div className="rounded-lg border border-dashed border-carbon-800 p-6 text-center">
                  <p className="text-xs text-carbon-600 font-mono">Empty</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
