const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost:5432/mission_control",
});

async function setup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Agents registry
    await client.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        model TEXT NOT NULL DEFAULT 'sonnet',
        color TEXT DEFAULT '#666',
        status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'active', 'error', 'disabled')),
        last_active_at TIMESTAMPTZ,
        total_tasks INTEGER DEFAULT 0,
        total_tokens_used BIGINT DEFAULT 0,
        total_cost_cents INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Tasks board
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'delegated', 'completed', 'failed', 'cancelled')),
        priority TEXT DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
        domain TEXT,
        assigned_agent TEXT REFERENCES agents(id),
        delegated_by TEXT REFERENCES agents(id),
        parent_task_id INTEGER REFERENCES tasks(id),
        input_summary TEXT,
        output_summary TEXT,
        tokens_used INTEGER DEFAULT 0,
        cost_cents INTEGER DEFAULT 0,
        duration_ms INTEGER,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Cron jobs / heartbeats
    await client.query(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        schedule TEXT NOT NULL,
        agent_id TEXT REFERENCES agents(id),
        enabled BOOLEAN DEFAULT true,
        last_run_at TIMESTAMPTZ,
        next_run_at TIMESTAMPTZ,
        last_status TEXT DEFAULT 'pending' CHECK (last_status IN ('pending', 'running', 'success', 'failed')),
        last_duration_ms INTEGER,
        last_error TEXT,
        run_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        avg_tokens INTEGER DEFAULT 0,
        avg_cost_cents INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Cron execution history
    await client.query(`
      CREATE TABLE IF NOT EXISTS cron_runs (
        id SERIAL PRIMARY KEY,
        cron_job_id INTEGER REFERENCES cron_jobs(id),
        status TEXT CHECK (status IN ('running', 'success', 'failed')),
        tokens_used INTEGER DEFAULT 0,
        cost_cents INTEGER DEFAULT 0,
        duration_ms INTEGER,
        output_summary TEXT,
        error_message TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
    `);

    // Cost tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS cost_events (
        id SERIAL PRIMARY KEY,
        agent_id TEXT REFERENCES agents(id),
        task_id INTEGER REFERENCES tasks(id),
        cron_run_id INTEGER REFERENCES cron_runs(id),
        model TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cost_cents INTEGER DEFAULT 0,
        event_type TEXT CHECK (event_type IN ('task', 'cron', 'delegation', 'meeting', 'proactive')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Daily cost rollups
    await client.query(`
      CREATE TABLE IF NOT EXISTS cost_daily (
        date DATE PRIMARY KEY,
        total_tokens BIGINT DEFAULT 0,
        total_cost_cents INTEGER DEFAULT 0,
        opus_tokens BIGINT DEFAULT 0,
        opus_cost_cents INTEGER DEFAULT 0,
        sonnet_tokens BIGINT DEFAULT 0,
        sonnet_cost_cents INTEGER DEFAULT 0,
        haiku_tokens BIGINT DEFAULT 0,
        haiku_cost_cents INTEGER DEFAULT 0,
        task_count INTEGER DEFAULT 0,
        cron_count INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Activity log / analytics events
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        agent_id TEXT REFERENCES agents(id),
        task_id INTEGER REFERENCES tasks(id),
        channel TEXT,
        summary TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed agents
    await client.query(`
      INSERT INTO agents (id, name, description, model, color) VALUES
        ('alan-os', 'Alan OS', 'The overseer. All messages route here first.', 'opus', '#ffffff'),
        ('asteris-gm', 'Asteris GM', 'Asteris, New Lumen, Keystone, vet-tech', 'opus', '#3b82f6'),
        ('ascend-builder', 'Ascend Builder', 'Ascend Intuition, Ship Protocol, app building', 'opus', '#22c55e'),
        ('legal-advisor', 'Legal Advisor', 'Custody, co-parenting, contracts, legal', 'opus', '#ef4444'),
        ('social-media', 'Social Media', 'X/Twitter content, strategy, growth', 'sonnet', '#06b6d4'),
        ('wedding-planner', 'Wedding Planner', 'July 12 2026 wedding coordination', 'sonnet', '#ec4899'),
        ('life-admin', 'Life Admin', 'Finances, custody schedule, household', 'sonnet', '#f97316'),
        ('research-analyst', 'Research Analyst', 'Deep research, competitive intel', 'opus', '#a855f7'),
        ('comms-drafter', 'Comms Drafter', 'Emails, Slack, proposals, written comms', 'sonnet', '#eab308')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed cron jobs from heartbeat.md
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id) VALUES
        ('Morning Briefing', 'Daily 6:30 AM: Calendar, weather, custody, priorities, alerts, wedding countdown', '30 6 * * *', 'alan-os'),
        ('Email Triage AM', 'Scan inbox, categorize URGENT/IMPORTANT/FYI, draft urgent responses', '0 8 * * *', 'alan-os'),
        ('Email Triage Noon', 'Midday inbox scan', '0 12 * * *', 'alan-os'),
        ('Email Triage PM', 'Afternoon inbox scan', '0 17 * * *', 'alan-os'),
        ('End of Day Review', 'Mon-Fri 8 PM: What got done, carrying over, loose ends', '0 20 * * 1-5', 'alan-os'),
        ('Weekly Planning', 'Sunday 7 PM: Review last week, set priorities, flag deadlines', '0 19 * * 0', 'alan-os'),
        ('Monthly Financial', '1st of month 9 AM: Child support, expenses, revenue, upcoming costs', '0 9 1 * *', 'life-admin')
      ON CONFLICT DO NOTHING;
    `);

    await client.query("COMMIT");
    console.log("Database setup complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Setup failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
