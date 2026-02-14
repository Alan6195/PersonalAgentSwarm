import { AgentContext, AgentResponse } from './types';
import { getPrompt, getModel } from './registry';
import { callClaude } from '../services/claude';
import * as taskManager from '../services/task-manager';

export async function run(context: AgentContext): Promise<AgentResponse> {
  const startTime = Date.now();
  const agentPrompt = getPrompt(context.agentId);
  const model = getModel(context.agentId);

  // Set agent to active
  await taskManager.setAgentStatus(context.agentId, 'active');

  // Update task to in_progress
  await taskManager.updateTaskStatus(context.taskId, 'in_progress');

  try {
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
