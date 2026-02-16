import { AgentContext, AgentResponse } from './types';
import { getPrompt, getModel } from './registry';
import { callClaude } from '../services/claude';
import * as taskManager from '../services/task-manager';
import * as agentMemory from '../services/agent-memory';
import * as outlookMail from '../services/outlook-mail';
import * as gmailMail from '../services/gmail-mail';
import { query as dbQuery } from '../db';

// Agents that use persistent semantic memory
const MEMORY_AGENTS = new Set(['legal-advisor']);

export async function run(context: AgentContext): Promise<AgentResponse> {
  const startTime = Date.now();
  let agentPrompt = getPrompt(context.agentId);
  const model = getModel(context.agentId);

  // Set agent to active
  await taskManager.setAgentStatus(context.agentId, 'active');

  // Update task to in_progress
  await taskManager.updateTaskStatus(context.taskId, 'in_progress');

  try {
    // For memory-enabled agents, recall relevant context and inject into system prompt
    if (MEMORY_AGENTS.has(context.agentId)) {
      try {
        const memories = await agentMemory.recall(context.agentId, context.userMessage, 8);
        if (memories.length > 0) {
          const memoryContext = agentMemory.formatMemoriesAsContext(memories);
          agentPrompt = `${agentPrompt}\n\n${memoryContext}`;
          console.log(`[Executor] Injected ${memories.length} memories for ${context.agentId}`);
        }
      } catch (memErr) {
        console.warn(`[Executor] Memory recall failed for ${context.agentId}, continuing without:`, (memErr as Error).message);
      }
    }

    // For life-admin, inject email context when the message is email-related
    if (context.agentId === 'life-admin' && outlookMail.isConfigured()) {
      const emailKeywords = /\b(email|inbox|mail|triage|messages?|unread|outlook|hotmail)\b/i;
      if (emailKeywords.test(context.userMessage)) {
        try {
          const messages = await outlookMail.getInboxMessages({ top: 30, unreadOnly: true });
          if (messages.length > 0) {
            const formatted = outlookMail.formatMessagesForAgent(messages);
            agentPrompt = `${agentPrompt}\n\n## EMAIL_CONTEXT\nBelow are Alan's ${messages.length} unread emails (auto-fetched). Use this data to respond to his request. You can reference message IDs in your [EMAIL_ACTION] blocks.\n\n${formatted}`;
            console.log(`[Executor] Injected ${messages.length} unread emails for life-admin`);
          } else {
            agentPrompt = `${agentPrompt}\n\n## EMAIL_CONTEXT\nAlan's inbox has 0 unread emails.`;
          }
        } catch (emailErr) {
          console.warn(`[Executor] Email context fetch failed, continuing without:`, (emailErr as Error).message);
        }
      }
    }

    // For wedding-planner, always inject current budget and vendor state
    if (context.agentId === 'wedding-planner') {
      try {
        const budgetItems = await dbQuery(
          `SELECT id, category, item, estimated_cents, actual_cents, status, notes
           FROM wedding_budget ORDER BY category, item`
        );
        const vendors = await dbQuery(
          `SELECT id, name, category, status, cost_estimate FROM wedding_vendors ORDER BY name`
        );

        if (budgetItems.length > 0 || vendors.length > 0) {
          const budgetFormatted = (budgetItems as any[]).map((b: any) =>
            `- [${b.id}] ${b.item} (${b.category}): est $${(b.estimated_cents / 100).toFixed(2)}, actual $${(b.actual_cents / 100).toFixed(2)}, status: ${b.status || 'budget'}${b.notes ? ` | ${b.notes}` : ''}`
          ).join('\n');

          const vendorFormatted = (vendors as any[]).map((v: any) =>
            `- [${v.id}] ${v.name} (${v.category}, ${v.status})${v.cost_estimate ? ` $${(v.cost_estimate / 100).toFixed(2)}` : ''}`
          ).join('\n');

          const totalEst = (budgetItems as any[]).reduce((s: number, b: any) => s + (b.estimated_cents || 0), 0);
          const totalActual = (budgetItems as any[]).reduce((s: number, b: any) => s + (b.actual_cents || 0), 0);
          const totalPaid = (budgetItems as any[]).filter((b: any) => b.status === 'paid').reduce((s: number, b: any) => s + (b.estimated_cents || 0), 0);

          agentPrompt += `\n\n## CURRENT WEDDING DATA\n\n### Budget ($45,000 target)\nAllocated: $${(totalEst / 100).toFixed(2)} | Actual spent: $${(totalActual / 100).toFixed(2)} | Paid: $${(totalPaid / 100).toFixed(2)}\n${totalEst > 4500000 ? `WARNING: Over budget by $${((totalEst - 4500000) / 100).toFixed(2)}\n` : ''}\n${budgetFormatted}\n\n### Vendors (${vendors.length})\n${vendorFormatted}`;

          console.log(`[Executor] Injected ${budgetItems.length} budget items and ${vendors.length} vendors for wedding-planner`);
        }
      } catch (weddingErr) {
        console.warn('[Executor] Wedding data context fetch failed:', (weddingErr as Error).message);
      }
    }

    // For wedding-planner, inject Gmail context when the message is email-related
    if (context.agentId === 'wedding-planner' && gmailMail.isConfigured()) {
      const gmailKeywords = /\b(email|inbox|mail|triage|messages?|unread|gmail|wedding email|vendor email|check email)\b/i;
      if (gmailKeywords.test(context.userMessage)) {
        try {
          const messages = await gmailMail.getInboxMessages({ maxResults: 30, unreadOnly: true });
          if (messages.length > 0) {
            const formatted = gmailMail.formatMessagesForAgent(messages);
            agentPrompt = `${agentPrompt}\n\n## GMAIL_CONTEXT\nBelow are ${messages.length} unread emails from alancarissawedding@gmail.com (auto-fetched). Use this data to respond to Alan's request. You can reference message IDs in your [GMAIL_ACTION] blocks.\n\n${formatted}`;
            console.log(`[Executor] Injected ${messages.length} unread Gmail messages for wedding-planner`);
          } else {
            agentPrompt = `${agentPrompt}\n\n## GMAIL_CONTEXT\nThe wedding inbox (alancarissawedding@gmail.com) has 0 unread emails.`;
          }
        } catch (gmailErr) {
          console.warn(`[Executor] Gmail context fetch failed, continuing without:`, (gmailErr as Error).message);
        }
      }
    }

    const result = await callClaude({
      model,
      system: agentPrompt,
      userMessage: context.userMessage,
      agentId: context.agentId,
      taskId: context.taskId,
      eventType: context.parentTaskId ? 'delegation' : 'task',
      history: context.history,
    });

    const durationMs = Date.now() - startTime;

    // For memory-enabled agents, store this conversation as a memory
    if (MEMORY_AGENTS.has(context.agentId)) {
      try {
        await agentMemory.storeConversationSummary(
          context.agentId,
          context.userMessage,
          result.content
        );
      } catch (memErr) {
        console.warn(`[Executor] Memory store failed for ${context.agentId}:`, (memErr as Error).message);
      }
    }

    // Set agent back to idle
    await taskManager.setAgentStatus(context.agentId, 'idle');

    return {
      content: result.content,
      tokensUsed: result.tokensUsed,
      model: result.model,
      costCents: result.costCents,
      durationMs,
    };
  } catch (err) {
    await taskManager.setAgentStatus(context.agentId, 'error');
    throw err;
  }
}
