import { AgentContext, AgentResponse } from './types';
import { getPrompt, getModel } from './registry';
import { callClaude } from '../services/claude';
import * as taskManager from '../services/task-manager';
import * as agentMemory from '../services/agent-memory';
import * as outlookMail from '../services/outlook-mail';

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
