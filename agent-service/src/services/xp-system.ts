/**
 * Agent XP & Leveling System
 *
 * Gamification layer for the agent swarm. Agents earn XP for completing tasks,
 * lose XP for failures, and level up through 10 tiers. Streaks multiply XP.
 */

import { query, queryOne } from '../db';

// ---------------------------------------------------------------
// Level thresholds and titles
// ---------------------------------------------------------------

const LEVEL_THRESHOLDS = [
  { level: 1, xp: 0, title: 'Intern' },
  { level: 2, xp: 100, title: 'Apprentice' },
  { level: 3, xp: 300, title: 'Specialist' },
  { level: 4, xp: 600, title: 'Expert' },
  { level: 5, xp: 1000, title: 'Master' },
  { level: 6, xp: 1500, title: 'Elite' },
  { level: 7, xp: 2500, title: 'Legendary' },
  { level: 8, xp: 4000, title: 'Mythic' },
  { level: 9, xp: 6000, title: 'Transcendent' },
  { level: 10, xp: 10000, title: 'Singularity' },
];

// Base XP by event type
const BASE_XP: Record<string, number> = {
  task: 10,
  cron: 5,
  delegation: 8,
  proactive: 15,
  meeting: 12,
};

// ---------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------

export function getLevelInfo(xp: number): {
  level: number;
  title: string;
  xpForNext: number;
  progress: number;
} {
  let currentLevel = LEVEL_THRESHOLDS[0];

  for (const threshold of LEVEL_THRESHOLDS) {
    if (xp >= threshold.xp) {
      currentLevel = threshold;
    } else {
      break;
    }
  }

  // Find next level threshold
  const nextIdx = LEVEL_THRESHOLDS.findIndex((t) => t.level === currentLevel.level + 1);
  const nextThreshold = nextIdx >= 0 ? LEVEL_THRESHOLDS[nextIdx].xp : currentLevel.xp;
  const currentThreshold = currentLevel.xp;

  const xpInLevel = xp - currentThreshold;
  const xpNeeded = nextThreshold - currentThreshold;
  const progress = xpNeeded > 0 ? Math.min(xpInLevel / xpNeeded, 1) : 1;

  return {
    level: currentLevel.level,
    title: currentLevel.title,
    xpForNext: nextThreshold,
    progress,
  };
}

export function calculateXP(params: {
  eventType: string;
  durationMs: number;
  costCents: number;
  success: boolean;
  streak?: number;
}): { xpEarned: number; breakdown: string } {
  if (!params.success) {
    return { xpEarned: -5, breakdown: 'Failed task: -5 XP' };
  }

  const base = BASE_XP[params.eventType] ?? 10;
  const parts: string[] = [`base: ${base}`];

  let bonus = 0;

  // Speed bonus: under 5 seconds
  if (params.durationMs > 0 && params.durationMs < 5000) {
    bonus += 5;
    parts.push('speed: +5');
  }

  // Efficiency bonus: under 10 cents
  if (params.costCents > 0 && params.costCents < 10) {
    bonus += 3;
    parts.push('efficient: +3');
  }

  // Streak multiplier: each consecutive success adds 10%, capped at 2x
  const streak = params.streak ?? 0;
  const multiplier = Math.min(1 + streak * 0.1, 2.0);
  if (multiplier > 1) {
    parts.push(`streak x${multiplier.toFixed(1)}`);
  }

  const total = Math.round((base + bonus) * multiplier);

  return {
    xpEarned: total,
    breakdown: parts.join(', ') + ` = ${total} XP`,
  };
}

// ---------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------

export async function awardXP(
  agentId: string,
  xpEarned: number
): Promise<{
  newXP: number;
  newLevel: number;
  newTitle: string;
  leveledUp: boolean;
  streak: number;
}> {
  // Get current state
  const agent = await queryOne<{ xp: number; level: number; streak: number }>(
    'SELECT xp, level, streak FROM agents WHERE id = $1',
    [agentId]
  );

  if (!agent) {
    return { newXP: 0, newLevel: 1, newTitle: 'Intern', leveledUp: false, streak: 0 };
  }

  const oldLevel = agent.level ?? 1;
  const newXP = Math.max(0, (agent.xp ?? 0) + xpEarned);
  const newStreak = xpEarned > 0 ? (agent.streak ?? 0) + 1 : 0;
  const levelInfo = getLevelInfo(newXP);

  await query(
    `UPDATE agents SET
      xp = $1,
      level = $2,
      level_title = $3,
      streak = $4,
      best_streak = GREATEST(COALESCE(best_streak, 0), $4),
      last_xp_event_at = NOW(),
      updated_at = NOW()
     WHERE id = $5`,
    [newXP, levelInfo.level, levelInfo.title, newStreak, agentId]
  );

  const leveledUp = levelInfo.level > oldLevel;
  if (leveledUp) {
    console.log(
      `[XP] ${agentId} LEVELED UP! ${oldLevel} -> ${levelInfo.level} (${levelInfo.title}) at ${newXP} XP`
    );
  }

  return {
    newXP,
    newLevel: levelInfo.level,
    newTitle: levelInfo.title,
    leveledUp,
    streak: newStreak,
  };
}

export async function deductXP(agentId: string, amount: number): Promise<void> {
  await query(
    `UPDATE agents SET
      xp = GREATEST(0, COALESCE(xp, 0) - $1),
      streak = 0,
      last_xp_event_at = NOW(),
      updated_at = NOW()
     WHERE id = $2`,
    [amount, agentId]
  );
}

// ---------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------

export interface LeaderboardEntry {
  id: string;
  name: string;
  color: string;
  xp: number;
  level: number;
  level_title: string;
  streak: number;
  best_streak: number;
  total_tasks: number;
  total_cost_cents: number;
}

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  return query<LeaderboardEntry>(
    `SELECT
      id, name, color,
      COALESCE(xp, 0) as xp,
      COALESCE(level, 1) as level,
      COALESCE(level_title, 'Intern') as level_title,
      COALESCE(streak, 0) as streak,
      COALESCE(best_streak, 0) as best_streak,
      COALESCE(total_tasks, 0) as total_tasks,
      COALESCE(total_cost_cents, 0) as total_cost_cents
     FROM agents
     ORDER BY xp DESC`
  );
}

export function formatLeaderboardForTelegram(entries: LeaderboardEntry[]): string {
  const medals = ['🥇', '🥈', '🥉'];
  const lines: string[] = ['*Agent Leaderboard*\n'];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const rank = medals[i] ?? `${i + 1}.`;
    const levelInfo = getLevelInfo(e.xp);
    const progressBar = renderProgressBar(levelInfo.progress);
    const streakText = e.streak >= 3 ? ` 🔥${e.streak}` : '';

    lines.push(
      `${rank} *${e.name}* (Lv.${e.level} ${e.level_title})` +
        `\n   ${e.xp} XP ${progressBar}${streakText}` +
        `\n   ${e.total_tasks} tasks completed`
    );
  }

  return lines.join('\n');
}

function renderProgressBar(progress: number): string {
  const filled = Math.round(progress * 10);
  const empty = 10 - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}
