"use client";

import { useFetch } from "@/lib/hooks";
import { formatCost, cn } from "@/lib/utils";
import type { Agent } from "@/types";
import { Trophy, Flame, Star, TrendingUp, Zap, ArrowUp, ArrowDown } from "lucide-react";

const LEVEL_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2500, 4000, 6000, 10000];

function getXpProgress(xp: number, level: number): number {
  const currentThreshold = LEVEL_THRESHOLDS[level - 1] || 0;
  const nextThreshold = LEVEL_THRESHOLDS[level] || LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
  if (nextThreshold === currentThreshold) return 100;
  return Math.min(100, ((xp - currentThreshold) / (nextThreshold - currentThreshold)) * 100);
}

function getRankEmoji(rank: number): string {
  if (rank === 1) return "\u{1F947}";
  if (rank === 2) return "\u{1F948}";
  if (rank === 3) return "\u{1F949}";
  return `#${rank}`;
}

function getLevelColor(level: number): string {
  if (level >= 9) return "text-amber-400";
  if (level >= 7) return "text-purple-400";
  if (level >= 5) return "text-blue-400";
  if (level >= 3) return "text-green-400";
  return "text-carbon-400";
}

/** Top performers get fire, bottom performers get mood indicators */
function getPerformanceIndicator(rank: number, total: number, xp: number, tasks: number): {
  emoji: string;
  label: string;
  color: string;
} | null {
  if (total < 2) return null;

  // Top performer(s): fire
  if (rank === 1 && xp > 0) {
    return { emoji: "\uD83D\uDD25", label: "On fire", color: "text-orange-400" };
  }
  if (rank === 2 && xp > 0) {
    return { emoji: "\uD83D\uDD25", label: "Hot", color: "text-orange-400" };
  }

  // Bottom 25%: sad/cold indicators
  const bottomThreshold = Math.max(2, Math.ceil(total * 0.75));
  if (rank >= bottomThreshold) {
    if (xp === 0 && tasks === 0) {
      return { emoji: "\uD83D\uDCA4", label: "Dormant", color: "text-carbon-600" };
    }
    if (rank === total) {
      return { emoji: "\uD83D\uDE1E", label: "Needs work", color: "text-red-400" };
    }
    return { emoji: "\uD83E\uDD76", label: "Cold", color: "text-blue-300" };
  }

  // Agents with active streaks get a small flame regardless of rank
  return null;
}

export default function LeaderboardPage() {
  const { data: agents, loading } = useFetch<Agent[]>("/api/leaderboard", 30000);

  const totalXp = agents?.reduce((sum, a) => sum + (a.xp || 0), 0) || 0;
  const topAgent = agents?.[0];
  const longestStreak = agents?.reduce((max, a) => Math.max(max, a.best_streak || 0), 0) || 0;
  const totalAgents = agents?.length || 0;

  // Find hardest worker (most tasks completed)
  const hardestWorker = agents?.reduce((best, a) =>
    (a.total_tasks || 0) > (best?.total_tasks || 0) ? a : best
  , agents?.[0] || null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center gap-3">
            <Trophy className="w-6 h-6 text-amber-400" />
            Agent Leaderboard
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            XP, levels, and streaks across the swarm
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-4 h-4 text-neon-green" />
            <span className="text-xs text-carbon-500 font-mono uppercase">Total XP</span>
          </div>
          <p className="stat-value text-neon-green">{totalXp.toLocaleString()}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Star className="w-4 h-4 text-amber-400" />
            <span className="text-xs text-carbon-500 font-mono uppercase">Top Agent</span>
          </div>
          <p className="stat-value text-amber-400 text-lg">
            {topAgent?.name || "..."} {topAgent && (topAgent.xp || 0) > 0 ? "\uD83D\uDD25" : ""}
          </p>
          <p className="text-xs text-carbon-500">{topAgent?.level_title}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Flame className="w-4 h-4 text-orange-400" />
            <span className="text-xs text-carbon-500 font-mono uppercase">Best Streak</span>
          </div>
          <p className="stat-value text-orange-400">{longestStreak}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-4 h-4 text-neon-blue" />
            <span className="text-xs text-carbon-500 font-mono uppercase">Hardest Worker</span>
          </div>
          <p className="stat-value text-neon-blue text-lg">
            {hardestWorker?.name || "..."} {hardestWorker && (hardestWorker.total_tasks || 0) > 0 ? "\uD83D\uDCAA" : ""}
          </p>
          <p className="text-xs text-carbon-500">
            {hardestWorker ? `${hardestWorker.total_tasks || 0} tasks` : ""}
          </p>
        </div>
      </div>

      {/* Leaderboard Table */}
      <div className="card p-0 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-carbon-500 font-mono">Loading leaderboard...</div>
        ) : (
          <div className="divide-y divide-carbon-800/50">
            {agents?.map((agent, index) => {
              const rank = index + 1;
              const progress = getXpProgress(agent.xp || 0, agent.level || 1);
              const perfIndicator = getPerformanceIndicator(rank, totalAgents, agent.xp || 0, agent.total_tasks || 0);

              return (
                <div
                  key={agent.id}
                  className={cn(
                    "flex items-center gap-4 px-6 py-4 transition-colors hover:bg-carbon-900/50",
                    rank <= 3 && "bg-carbon-900/30",
                    rank === totalAgents && (agent.xp || 0) === 0 && "opacity-60"
                  )}
                >
                  {/* Rank + performance indicator */}
                  <div className="w-12 text-center shrink-0">
                    <span className={cn("text-lg font-bold", rank <= 3 ? "text-amber-400" : "text-carbon-600")}>
                      {getRankEmoji(rank)}
                    </span>
                    {perfIndicator && (
                      <div className="text-xs mt-0.5" title={perfIndicator.label}>
                        {perfIndicator.emoji}
                      </div>
                    )}
                  </div>

                  {/* Agent Avatar */}
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
                    style={{ backgroundColor: agent.color + "20", color: agent.color }}
                  >
                    {agent.name.split(" ").map(w => w[0]).join("").substring(0, 2)}
                  </div>

                  {/* Agent Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium truncate">{agent.name}</span>
                      <span className={cn("text-xs font-mono", getLevelColor(agent.level || 1))}>
                        Lv.{agent.level || 1}
                      </span>
                      <span className="text-xs text-carbon-500 font-mono">
                        {agent.level_title || "Intern"}
                      </span>
                      {/* Rank trend indicator */}
                      {rank <= 2 && (agent.xp || 0) > 0 && (
                        <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                          <ArrowUp className="w-2.5 h-2.5" /> Top {rank === 1 ? "performer" : "tier"}
                        </span>
                      )}
                      {rank >= totalAgents - 1 && totalAgents > 3 && (agent.xp || 0) === 0 && (
                        <span className="text-[10px] font-mono text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                          <ArrowDown className="w-2.5 h-2.5" /> Needs attention
                        </span>
                      )}
                    </div>
                    {/* XP Progress Bar */}
                    <div className="mt-1.5 flex items-center gap-3">
                      <div className="flex-1 h-1.5 bg-carbon-800 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${progress}%`,
                            backgroundColor: agent.color,
                          }}
                        />
                      </div>
                      <span className="text-xs font-mono text-carbon-500 w-16 text-right">
                        {(agent.xp || 0).toLocaleString()} XP
                      </span>
                    </div>
                  </div>

                  {/* Streak + tasks */}
                  <div className="text-right shrink-0 w-24">
                    {(agent.streak || 0) > 0 && (
                      <div className="flex items-center justify-end gap-1">
                        <Flame className="w-3.5 h-3.5 text-orange-400" />
                        <span className="text-sm font-mono text-orange-400">
                          {agent.streak}
                        </span>
                      </div>
                    )}
                    <span className="text-xs text-carbon-600 font-mono">
                      {agent.total_tasks || 0} tasks
                    </span>
                  </div>

                  {/* Cost */}
                  <div className="text-right shrink-0 w-20">
                    <span className="text-xs font-mono text-carbon-500">
                      {formatCost(agent.total_cost_cents)}
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
