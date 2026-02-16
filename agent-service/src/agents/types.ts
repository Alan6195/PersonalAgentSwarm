export interface AgentContext {
  agentId: string;
  taskId: number;
  parentTaskId?: number;
  userMessage: string;
  /** Conversation history for multi-turn context. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AgentResponse {
  content: string;
  tokensUsed: { input: number; output: number; total: number };
  model: string;
  costCents: number;
  durationMs: number;
}

export interface RoutingDecision {
  action: 'respond_directly' | 'delegate' | 'multi_delegate';
  target_agent_id?: string;
  /** For multi_delegate: run multiple agents in parallel, alan-os synthesizes. */
  target_agent_ids?: string[];
  reasoning: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  domain?: string;
  task_title: string;
}

export interface AgentDefinition {
  prompt: string;
  model: string;
}
