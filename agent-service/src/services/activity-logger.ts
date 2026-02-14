import { query } from '../db';

interface LogParams {
  event_type: string;
  agent_id: string;
  task_id?: number;
  channel?: string;
  summary: string;
  metadata?: Record<string, any>;
}

export async function log(params: LogParams): Promise<void> {
  await query(
    `INSERT INTO activity_log (event_type, agent_id, task_id, channel, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.event_type,
      params.agent_id,
      params.task_id ?? null,
      params.channel ?? null,
      params.summary,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
}
