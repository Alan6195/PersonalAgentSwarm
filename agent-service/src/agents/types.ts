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
  action: 'respond_directly' | 'delegate';
  target_agent_id?: string;
  reasoning: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  domain?: string;
  task_title: string;
}

export interface AgentDefinition {
  prompt: string;
  model: string;
}
