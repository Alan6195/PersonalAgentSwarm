import { withTransaction } from '../db';
import { getModelCategory } from '../config';

interface CostEvent {
  agent_id: string;
  task_id: number;
  cron_run_id?: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_cents: number;
  event_type: string;
}

export async function logCostEvent(event: CostEvent): Promise<void> {
  const category = getModelCategory(event.model);

  await withTransaction(async (client) => {
    // 1. Insert cost event
    await client.query(
      `INSERT INTO cost_events
        (agent_id, task_id, cron_run_id, model, input_tokens, output_tokens, total_tokens, cost_cents, event_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.agent_id,
        event.task_id,
        event.cron_run_id ?? null,
        event.model,
        event.input_tokens,
        event.output_tokens,
        event.total_tokens,
        event.cost_cents,
        event.event_type,
      ]
    );

    // 2. Update agent cumulative stats
    await client.query(
      `UPDATE agents SET
        total_tokens_used = total_tokens_used + $1,
        total_cost_cents = total_cost_cents + $2,
        updated_at = NOW()
       WHERE id = $3`,
      [event.total_tokens, event.cost_cents, event.agent_id]
    );

    // 3. Upsert cost_daily with model-specific columns
    if (category === 'opus') {
      await client.query(
        `INSERT INTO cost_daily (date, total_tokens, total_cost_cents, opus_tokens, opus_cost_cents, task_count)
         VALUES (CURRENT_DATE, $1, $2, $1, $2, 1)
         ON CONFLICT (date) DO UPDATE SET
           total_tokens = cost_daily.total_tokens + $1,
           total_cost_cents = cost_daily.total_cost_cents + $2,
           opus_tokens = cost_daily.opus_tokens + $1,
           opus_cost_cents = cost_daily.opus_cost_cents + $2,
           task_count = cost_daily.task_count + 1,
           updated_at = NOW()`,
        [event.total_tokens, event.cost_cents]
      );
    } else if (category === 'sonnet') {
      await client.query(
        `INSERT INTO cost_daily (date, total_tokens, total_cost_cents, sonnet_tokens, sonnet_cost_cents, task_count)
         VALUES (CURRENT_DATE, $1, $2, $1, $2, 1)
         ON CONFLICT (date) DO UPDATE SET
           total_tokens = cost_daily.total_tokens + $1,
           total_cost_cents = cost_daily.total_cost_cents + $2,
           sonnet_tokens = cost_daily.sonnet_tokens + $1,
           sonnet_cost_cents = cost_daily.sonnet_cost_cents + $2,
           task_count = cost_daily.task_count + 1,
           updated_at = NOW()`,
        [event.total_tokens, event.cost_cents]
      );
    } else {
      await client.query(
        `INSERT INTO cost_daily (date, total_tokens, total_cost_cents, haiku_tokens, haiku_cost_cents, task_count)
         VALUES (CURRENT_DATE, $1, $2, $1, $2, 1)
         ON CONFLICT (date) DO UPDATE SET
           total_tokens = cost_daily.total_tokens + $1,
           total_cost_cents = cost_daily.total_cost_cents + $2,
           haiku_tokens = cost_daily.haiku_tokens + $1,
           haiku_cost_cents = cost_daily.haiku_cost_cents + $2,
           task_count = cost_daily.task_count + 1,
           updated_at = NOW()`,
        [event.total_tokens, event.cost_cents]
      );
    }
  });
}
