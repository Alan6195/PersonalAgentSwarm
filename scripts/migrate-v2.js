/**
 * Migration v2: Agent XP System + Dev Queue + New Cron Jobs
 *
 * Run: node scripts/migrate-v2.js
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

    console.log("[Migrate v2] Adding XP columns to agents...");

    // 1. XP system columns on agents table
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS level_title TEXT DEFAULT 'Intern'`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS best_streak INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_xp_event_at TIMESTAMPTZ`);

    console.log("[Migrate v2] Creating dev_queue table...");

    // 2. Dev queue table for Gilfoyle's autonomous work
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

    console.log("[Migrate v2] Seeding Gilfoyle agent...");

    // 3. Ensure Gilfoyle exists in agents table
    await client.query(`
      INSERT INTO agents (id, name, description, model, color)
      VALUES ('gilfoyle', 'Gilfoyle', 'Systems architect, developer, infrastructure', 'opus', '#10b981')
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log("[Migrate v2] Adding prompt_override column to cron_jobs...");

    // 4. Add prompt_override column if not exists
    await client.query(`ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS prompt_override TEXT`);

    console.log("[Migrate v2] Seeding new cron jobs...");

    // 5. Seed new cron jobs
    // Proactive sweeps (3x daily)
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, prompt_override)
      SELECT 'Proactive Sweep Morning',
             'Scan all data sources for actionable items Alan needs to know about',
             '0 7 * * *',
             'alan-os',
             'Run a proactive intelligence sweep. Review the injected data for anything that needs attention today. Only respond if something is genuinely actionable. If nothing needs attention, respond with exactly: ALL_CLEAR'
      WHERE NOT EXISTS (SELECT 1 FROM cron_jobs WHERE name = 'Proactive Sweep Morning');
    `);

    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, prompt_override)
      SELECT 'Proactive Sweep Afternoon',
             'Midday check for urgent items',
             '0 13 * * *',
             'alan-os',
             'Quick midday sweep. Check for anything urgent that emerged since this morning. Only respond if critical. If nothing needs attention, respond with exactly: ALL_CLEAR'
      WHERE NOT EXISTS (SELECT 1 FROM cron_jobs WHERE name = 'Proactive Sweep Afternoon');
    `);

    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, prompt_override)
      SELECT 'Proactive Sweep Evening',
             'End of day wrap-up check',
             '0 18 * * *',
             'alan-os',
             'Evening sweep. Summarize anything that needs attention before tomorrow. Keep it tight. If nothing needs attention, respond with exactly: ALL_CLEAR'
      WHERE NOT EXISTS (SELECT 1 FROM cron_jobs WHERE name = 'Proactive Sweep Evening');
    `);

    // Gilfoyle night shift
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, prompt_override)
      SELECT 'Gilfoyle Night Shift',
             'Pick highest-priority pending item from dev_queue and work on it in ship mode',
             '0 23 * * *',
             'gilfoyle',
             'Check the dev_queue table for the highest-priority pending item. If found, work on it autonomously. If no items are pending, respond with: QUEUE_EMPTY'
      WHERE NOT EXISTS (SELECT 1 FROM cron_jobs WHERE name = 'Gilfoyle Night Shift');
    `);

    // Weekly XP report
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, prompt_override)
      SELECT 'Weekly XP Report',
             'Generate agent leaderboard and XP summary',
             '0 20 * * 0',
             'alan-os',
             'Generate a weekly XP report for the agent swarm. The current leaderboard data will be injected. Summarize: who leveled up, biggest XP earners, longest streaks, any agents falling behind. Keep it fun and competitive.'
      WHERE NOT EXISTS (SELECT 1 FROM cron_jobs WHERE name = 'Weekly XP Report');
    `);

    console.log("[Migrate v2] Creating x_trend_snapshots table...");

    // 6. X/Twitter intelligence trend tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS x_trend_snapshots (
        id SERIAL PRIMARY KEY,
        scan_date DATE DEFAULT CURRENT_DATE,
        total_scanned INTEGER,
        hot_leads INTEGER DEFAULT 0,
        warm_prospects INTEGER DEFAULT 0,
        peer_builders INTEGER DEFAULT 0,
        content_ideas INTEGER DEFAULT 0,
        top_themes JSONB DEFAULT '[]',
        top_insights JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // X Intelligence daily scan cron job
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, prompt_override)
      SELECT 'X Intelligence Scan',
             'Run daily X/Twitter intelligence scan for engagement opportunities and trend tracking',
             '0 10 * * *',
             'social-media',
             'Run a full intelligence scan of X/Twitter. Analyze the injected X INTELLIGENCE SCAN data. Report: (1) Any HOT LEADS that need immediate engagement, (2) Top 3 engagement opportunities, (3) Content ideas inspired by trending discussions, (4) Notable competitor activity. Draft replies for the top 2-3 engagement opportunities. If nothing noteworthy, respond with: ALL_CLEAR'
      WHERE NOT EXISTS (SELECT 1 FROM cron_jobs WHERE name = 'X Intelligence Scan');
    `);

    await client.query("COMMIT");
    console.log("[Migrate v2] Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v2] Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
