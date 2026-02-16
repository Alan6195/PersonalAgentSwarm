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
    idle: "text-cream-400",
    active: "text-accent-green",
    error: "text-accent-red",
    disabled: "text-cream-500",
    pending: "text-cream-500",
    in_progress: "text-accent-blue",
    delegated: "text-accent-purple",
    completed: "text-accent-green",
    failed: "text-accent-red",
    cancelled: "text-cream-500",
    running: "text-accent-blue",
    success: "text-accent-green",
  };
  return map[status] || "text-cream-500";
}

export function priorityColor(priority: string): string {
  const map: Record<string, string> = {
    urgent: "text-accent-red",
    high: "text-accent-amber",
    normal: "text-cream-700",
    low: "text-cream-500",
  };
  return map[priority] || "text-cream-500";
}

export function priorityBg(priority: string): string {
  const map: Record<string, string> = {
    urgent: "bg-accent-red/10 border-accent-red/20",
    high: "bg-accent-amber/10 border-accent-amber/20",
    normal: "bg-cream-100 border-cream-300",
    low: "bg-cream-50 border-cream-200",
  };
  return map[priority] || "bg-cream-100 border-cream-300";
}
