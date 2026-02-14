import { query, queryOne } from '../db';

interface CreateTaskParams {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigned_agent: string;
  delegated_by?: string;
  parent_task_id?: number;
  input_summary: string;
  domain?: string;
  metadata?: Record<string, any>;
}

interface TaskResult {
  id: number;
}

export async function createTask(params: CreateTaskParams): Promise<TaskResult> {
  const row = await queryOne<TaskResult>(
    `INSERT INTO tasks
      (title, description, status, priority, assigned_agent, delegated_by, parent_task_id, input_summary, domain, metadata, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      params.title,
      params.description,
      params.status,
      params.priority,
      params.assigned_agent,
      params.delegated_by ?? null,
      params.parent_task_id ?? null,
      params.input_summary,
      params.domain ?? null,
      JSON.stringify(params.metadata ?? {}),
      params.status === 'in_progress' ? new Date() : null,
    ]
  );

  if (!row) throw new Error('Failed to create task');
  return row;
}

interface CompleteTaskParams {
  content: string;
  tokensUsed: number;
  costCents: number;
  durationMs: number;
}

export async function completeTask(taskId: number, result: CompleteTaskParams): Promise<void> {
  // Get the assigned agent to increment their task count
  const task = await queryOne<{ assigned_agent: string }>(
    'SELECT assigned_agent FROM tasks WHERE id = $1',
    [taskId]
  );

  await query(
    `UPDATE tasks SET
      status = 'completed',
      output_summary = $1,
      tokens_used = $2,
      cost_cents = $3,
      duration_ms = $4,
      completed_at = NOW(),
      updated_at = NOW()
     WHERE id = $5`,
    [result.content.substring(0, 2000), result.tokensUsed, result.costCents, result.durationMs, taskId]
  );

  // Increment agent total_tasks
  if (task?.assigned_agent) {
    await query(
      `UPDATE agents SET total_tasks = total_tasks + 1, updated_at = NOW() WHERE id = $1`,
      [task.assigned_agent]
    );
  }
}

export async function failTask(taskId: number, errorMessage: string): Promise<void> {
  await query(
    `UPDATE tasks SET
      status = 'failed',
      error_message = $1,
      completed_at = NOW(),
      updated_at = NOW()
     WHERE id = $2`,
    [errorMessage, taskId]
  );
}

export async function updateTaskStatus(taskId: number, status: string): Promise<void> {
  const startedAt = status === 'in_progress' ? ', started_at = NOW()' : '';
  await query(
    `UPDATE tasks SET status = $1, updated_at = NOW()${startedAt} WHERE id = $2`,
    [status, taskId]
  );
}

export async function setAgentStatus(
  agentId: string,
  status: 'idle' | 'active' | 'error'
): Promise<void> {
  await query(
    `UPDATE agents SET status = $1, last_active_at = NOW(), updated_at = NOW() WHERE id = $2`,
    [status, agentId]
  );
}

export interface SystemHealth {
  activeAgents: number;
  tasksToday: number;
  tasksPending: number;
  costTodayCents: number;
  lastCronStatus: string;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const [agents] = await query<{ count: string }>(
    "SELECT COUNT(*) as count FROM agents WHERE status = 'active'"
  );
  const [tasksToday] = await query<{ count: string }>(
    "SELECT COUNT(*) as count FROM tasks WHERE created_at >= CURRENT_DATE"
  );
  const [tasksPending] = await query<{ count: string }>(
    "SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'in_progress')"
  );
  const [costToday] = await query<{ total: string }>(
    "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_events WHERE created_at >= CURRENT_DATE"
  );
  const lastCron = await queryOne<{ last_status: string }>(
    "SELECT last_status FROM cron_jobs ORDER BY last_run_at DESC NULLS LAST LIMIT 1"
  );

  return {
    activeAgents: parseInt(agents?.count || '0', 10),
    tasksToday: parseInt(tasksToday?.count || '0', 10),
    tasksPending: parseInt(tasksPending?.count || '0', 10),
    costTodayCents: parseInt(costToday?.total || '0', 10),
    lastCronStatus: lastCron?.last_status || 'none',
  };
}
