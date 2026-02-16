import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

export function timeAgo(date: string | Date): string {
  const now = new Date();
  const then = new Date(date);
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function statusColor(status: string): string {
  const map: Record<string, string> = {
    idle: "text-carbon-400",
    active: "text-neon-green",
    error: "text-neon-red",
    disabled: "text-carbon-600",
    pending: "text-carbon-400",
    in_progress: "text-neon-blue",
    delegated: "text-neon-purple",
    completed: "text-neon-green",
    failed: "text-neon-red",
    cancelled: "text-carbon-600",
    running: "text-neon-blue",
    success: "text-neon-green",
  };
  return map[status] || "text-carbon-400";
}

export function priorityColor(priority: string): string {
  const map: Record<string, string> = {
    urgent: "text-neon-red",
    high: "text-neon-amber",
    normal: "text-carbon-300",
    low: "text-carbon-500",
  };
  return map[priority] || "text-carbon-400";
}

export function priorityBg(priority: string): string {
  const map: Record<string, string> = {
    urgent: "bg-neon-red/10 border-neon-red/30",
    high: "bg-neon-amber/10 border-neon-amber/30",
    normal: "bg-carbon-800/50 border-carbon-700",
    low: "bg-carbon-900/50 border-carbon-800",
  };
  return map[priority] || "bg-carbon-800/50 border-carbon-700";
}
