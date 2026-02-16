/**
 * Migration v4: Fix XP columns + Update travel dates
 *
 * Run: node scripts/migrate-v4.js
 * Safe to re-run (all operations are idempotent).
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost:5432/mission_control",
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log("[Migrate v4] Ensuring XP columns exist on agents table...");

    // 1. Ensure XP columns exist (idempotent, re-runs safely)
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS level_title TEXT DEFAULT 'Intern'`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS best_streak INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_xp_event_at TIMESTAMPTZ`);

    console.log("[Migrate v4] Ensuring total_tasks and total_cost_cents columns exist...");

    // 2. Ensure total_tasks and total_cost_cents exist
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS total_tasks INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS total_cost_cents INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS total_tokens_used INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`);

    console.log("[Migrate v4] Updating trip notes for July 17 arrival...");

    // 3. Update trip notes for the corrected date
    await client.query(`
      UPDATE travel_trips SET
        notes = '["First day or two should be chill after the wedding","Carissa is dairy-free and gluten-free","Trip starts in Porto Jul 17, ends near Faro Jul 26","Prefer king or queen beds, not doubles","Wedding is July 12, honeymoon starts July 17"]'::jsonb,
        updated_at = NOW()
      WHERE trip_id = 'portugal-honeymoon-2026'
    `);

    console.log("[Migrate v4] Backfilling agent task counts from tasks table...");

    // 4. Backfill total_tasks from the tasks table for agents that have completed work
    await client.query(`
      UPDATE agents a SET
        total_tasks = COALESCE(sub.task_count, 0)
      FROM (
        SELECT assigned_agent, COUNT(*) as task_count
        FROM tasks
        WHERE status = 'completed'
        GROUP BY assigned_agent
      ) sub
      WHERE a.id = sub.assigned_agent
        AND COALESCE(a.total_tasks, 0) = 0
    `);

    console.log("[Migrate v4] Backfilling agent cost totals from cost_events...");

    // 5. Backfill total_cost_cents from cost_events for agents that have spend
    await client.query(`
      UPDATE agents a SET
        total_cost_cents = COALESCE(sub.total_cost, 0)
      FROM (
        SELECT agent_id, SUM(cost_cents) as total_cost
        FROM cost_events
        GROUP BY agent_id
      ) sub
      WHERE a.id = sub.agent_id
        AND COALESCE(a.total_cost_cents, 0) = 0
    `);

    console.log("[Migrate v4] Backfilling XP based on total_tasks...");

    // 6. Backfill XP: give agents XP based on their existing task history
    //    Base: 10 XP per completed task
    await client.query(`
      UPDATE agents SET
        xp = GREATEST(COALESCE(xp, 0), COALESCE(total_tasks, 0) * 10),
        level = CASE
          WHEN COALESCE(total_tasks, 0) * 10 >= 10000 THEN 10
          WHEN COALESCE(total_tasks, 0) * 10 >= 6000 THEN 9
          WHEN COALESCE(total_tasks, 0) * 10 >= 4000 THEN 8
          WHEN COALESCE(total_tasks, 0) * 10 >= 2500 THEN 7
          WHEN COALESCE(total_tasks, 0) * 10 >= 1500 THEN 6
          WHEN COALESCE(total_tasks, 0) * 10 >= 1000 THEN 5
          WHEN COALESCE(total_tasks, 0) * 10 >= 600 THEN 4
          WHEN COALESCE(total_tasks, 0) * 10 >= 300 THEN 3
          WHEN COALESCE(total_tasks, 0) * 10 >= 100 THEN 2
          ELSE 1
        END,
        level_title = CASE
          WHEN COALESCE(total_tasks, 0) * 10 >= 10000 THEN 'Singularity'
          WHEN COALESCE(total_tasks, 0) * 10 >= 6000 THEN 'Transcendent'
          WHEN COALESCE(total_tasks, 0) * 10 >= 4000 THEN 'Mythic'
          WHEN COALESCE(total_tasks, 0) * 10 >= 2500 THEN 'Legendary'
          WHEN COALESCE(total_tasks, 0) * 10 >= 1500 THEN 'Elite'
          WHEN COALESCE(total_tasks, 0) * 10 >= 1000 THEN 'Master'
          WHEN COALESCE(total_tasks, 0) * 10 >= 600 THEN 'Expert'
          WHEN COALESCE(total_tasks, 0) * 10 >= 300 THEN 'Specialist'
          WHEN COALESCE(total_tasks, 0) * 10 >= 100 THEN 'Apprentice'
          ELSE 'Intern'
        END,
        updated_at = NOW()
      WHERE COALESCE(xp, 0) = 0 AND COALESCE(total_tasks, 0) > 0
    `);

    // 7. Ensure dev_queue table exists (from v2, in case it was missed)
    await client.query(`
      CREATE TABLE IF NOT EXISTS dev_queue (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
        priority INTEGER DEFAULT 5,
        created_by TEXT DEFAULT 'alan',
        assigned_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        result_summary TEXT,
        cost_usd NUMERIC(8,4) DEFAULT 0,
        turns_used INTEGER DEFAULT 0,
        files_modified JSONB DEFAULT '[]',
        task_id INTEGER REFERENCES tasks(id),
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query("COMMIT");
    console.log("[Migrate v4] Migration complete.");

    // Quick verification
    const result = await client.query(
      "SELECT id, name, xp, level, level_title, total_tasks FROM agents ORDER BY xp DESC"
    );
    console.log("\n[Migrate v4] Agent XP Status:");
    for (const row of result.rows) {
      console.log(`  ${row.name}: ${row.xp} XP (Lv.${row.level} ${row.level_title}) - ${row.total_tasks} tasks`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v4] Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
