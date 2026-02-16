/**
 * Cost Guardrails
 *
 * Checks daily and per-agent budget limits before API calls.
 * Prevents runaway costs from cron jobs while allowing user-initiated tasks.
 */

import { queryOne } from '../db';
import { config } from '../config';

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  dailySpent: number;
  agentSpent: number;
  dailyLimit: number;
  agentLimit: number;
}

export async function checkBudget(agentId: string): Promise<BudgetCheck> {
  const dailyLimit = (config as any).DAILY_BUDGET_LIMIT_CENTS ?? 5000;
  const agentLimit = (config as any).AGENT_DAILY_LIMIT_CENTS ?? 1000;

  // Query today's total spend
  const dailyRow = await queryOne<{ total: string }>(
    "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_events WHERE created_at >= CURRENT_DATE"
  );
  const dailySpent = parseInt(dailyRow?.total ?? '0', 10);

  // Query today's spend for this specific agent
  const agentRow = await queryOne<{ total: string }>(
    "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_events WHERE created_at >= CURRENT_DATE AND agent_id = $1",
    [agentId]
  );
  const agentSpent = parseInt(agentRow?.total ?? '0', 10);

  const result: BudgetCheck = {
    allowed: true,
    dailySpent,
    agentSpent,
    dailyLimit,
    agentLimit,
  };

  if (dailySpent >= dailyLimit) {
    result.allowed = false;
    result.reason = `Daily budget limit reached ($${(dailyLimit / 100).toFixed(2)}). Spent today: $${(dailySpent / 100).toFixed(2)}`;
  } else if (agentSpent >= agentLimit) {
    result.allowed = false;
    result.reason = `Agent ${agentId} daily limit reached ($${(agentLimit / 100).toFixed(2)}). Agent spent: $${(agentSpent / 100).toFixed(2)}`;
  }

  return result;
}

export async function getDailySpend(): Promise<number> {
  const row = await queryOne<{ total: string }>(
    "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_events WHERE created_at >= CURRENT_DATE"
  );
  return parseInt(row?.total ?? '0', 10);
}

export async function getAgentDailySpend(agentId: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_events WHERE created_at >= CURRENT_DATE AND agent_id = $1",
    [agentId]
  );
  return parseInt(row?.total ?? '0', 10);
}

/**
 * Check if we've crossed the 80% warning threshold.
 * Returns true if alert should be sent (first time crossing).
 */
let alertSentToday: string | null = null;

export async function shouldSendBudgetAlert(): Promise<{ alert: boolean; spent: number; limit: number }> {
  const dailyLimit = (config as any).DAILY_BUDGET_LIMIT_CENTS ?? 5000;
  const spent = await getDailySpend();
  const today = new Date().toISOString().slice(0, 10);

  // Only alert once per day
  if (alertSentToday === today) {
    return { alert: false, spent, limit: dailyLimit };
  }

  if (spent >= dailyLimit * 0.8) {
    alertSentToday = today;
    return { alert: true, spent, limit: dailyLimit };
  }

  return { alert: false, spent, limit: dailyLimit };
}
