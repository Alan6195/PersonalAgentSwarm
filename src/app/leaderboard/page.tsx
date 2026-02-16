"use client";

import { useFetch } from "@/lib/hooks";
import { formatCost, cn } from "@/lib/utils";
import type { Agent } from "@/types";
import { Trophy, Flame, Star, TrendingUp, Zap } from "lucide-react";

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

export default function LeaderboardPage() {
  const { data: agents, loading } = useFetch<Agent[]>("/api/leaderboard", 30000);

  const totalXp = agents?.reduce((sum, a) => sum + (a.xp || 0), 0) || 0;
  const topAgent = agents?.[0];
  const longestStreak = agents?.reduce((max, a) => Math.max(max, a.best_streak || 0), 0) || 0;

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
          <p className="stat-value text-amber-400 text-lg">{topAgent?.name || "..."}</p>
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
            <span className="text-xs text-carbon-500 font-mono uppercase">Agents</span>
          </div>
          <p className="stat-value text-neon-blue">{agents?.length || 0}</p>
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
              return (
                <div
                  key={agent.id}
                  className={cn(
                    "flex items-center gap-4 px-6 py-4 transition-colors hover:bg-carbon-900/50",
                    rank <= 3 && "bg-carbon-900/30"
                  )}
                >
                  {/* Rank */}
                  <div className="w-10 text-center text-lg font-bold shrink-0">
                    <span className={rank <= 3 ? "text-amber-400" : "text-carbon-600"}>
                      {getRankEmoji(rank)}
                    </span>
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

                  {/* Streak */}
                  <div className="text-right shrink-0 w-20">
                    {(agent.streak || 0) > 0 && (
                      <div className="flex items-center justify-end gap-1">
                        <Flame className="w-3.5 h-3.5 text-orange-400" />
                        <span className="text-sm font-mono text-orange-400">
                          {agent.streak}
                        </span>
                      </div>
                    )}
                    <span className="text-xs text-carbon-600 font-mono">
                      {agent.total_tasks} tasks
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
