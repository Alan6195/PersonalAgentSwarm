import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logCostEvent } from './cost-tracker';
import type { ConversationMessage } from './conversation-memory';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

interface ClaudeCallParams {
  model: string;
  system: string;
  userMessage: string;
  agentId: string;
  taskId: number;
  eventType: 'task' | 'cron' | 'delegation' | 'meeting' | 'proactive';
  cronRunId?: number;
  maxTokens?: number;
  /** Optional conversation history. These messages come before the current userMessage. */
  history?: ConversationMessage[];
}

export interface ClaudeCallResult {
  content: string;
  tokensUsed: { input: number; output: number; total: number };
  model: string;
  costCents: number;
}

export async function callClaude(params: ClaudeCallParams): Promise<ClaudeCallResult> {
  // Build messages array: history (if any) + current user message
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (params.history && params.history.length > 0) {
    for (const msg of params.history) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: 'user', content: params.userMessage });

  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    system: params.system,
    messages,
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const totalTokens = inputTokens + outputTokens;

  // Calculate cost in cents
  const pricing = config.MODEL_PRICING[params.model] ?? { input: 300, output: 1500 };
  const costCents = Math.ceil(
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
  );

  // Log to cost_events, update agent stats, upsert cost_daily
  await logCostEvent({
    agent_id: params.agentId,
    task_id: params.taskId,
    cron_run_id: params.cronRunId ?? null,
    model: params.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cost_cents: costCents,
    event_type: params.eventType,
  });

  const content =
    response.content[0].type === 'text' ? response.content[0].text : '';

  return {
    content,
    tokensUsed: { input: inputTokens, output: outputTokens, total: totalTokens },
    model: params.model,
    costCents,
  };
}
