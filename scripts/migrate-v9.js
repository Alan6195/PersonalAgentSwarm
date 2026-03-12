/**
 * Migration v9: X Agent Intelligence Upgrade
 *
 * Adds visual_strategy and intel_trigger columns to post_analytics.
 * Creates content_hypotheses table for autonomous learning loop.
 * Creates reply_outcomes table for engagement tracking.
 * Registers weekly Hypothesis Review cron job.
 *
 * Run: node scripts/migrate-v9.js
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

    // 1. Add columns to post_analytics
    console.log("[Migrate v9] Adding visual_strategy column to post_analytics...");
    await client.query(`
      ALTER TABLE post_analytics ADD COLUMN IF NOT EXISTS visual_strategy TEXT
    `);
    await client.query(`
      ALTER TABLE post_analytics ADD COLUMN IF NOT EXISTS intel_trigger TEXT
    `);

    // 2. content_hypotheses table
    console.log("[Migrate v9] Creating content_hypotheses table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_hypotheses (
        id SERIAL PRIMARY KEY,
        hypothesis TEXT NOT NULL,
        variable TEXT NOT NULL,
        prediction TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'refuted', 'superseded')),
        confidence NUMERIC(5,2) DEFAULT 50.0,
        supporting_post_ids TEXT[] DEFAULT '{}',
        contradicting_post_ids TEXT[] DEFAULT '{}',
        source TEXT DEFAULT 'implicit' CHECK (source IN ('implicit', 'weekly_review', 'manual')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);

    // 3. reply_outcomes table
    console.log("[Migrate v9] Creating reply_outcomes table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS reply_outcomes (
        id SERIAL PRIMARY KEY,
        reply_tweet_id TEXT UNIQUE NOT NULL,
        target_tweet_id TEXT NOT NULL,
        target_author TEXT,
        target_category TEXT,
        reply_content TEXT,
        follow_back BOOLEAN DEFAULT false,
        re_engaged BOOLEAN DEFAULT false,
        post_analytics_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        checked_at TIMESTAMPTZ
      )
    `);

    // 4. Indexes
    console.log("[Migrate v9] Creating indexes...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_hypotheses_status
        ON content_hypotheses(status) WHERE status = 'active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reply_outcomes_unchecked
        ON reply_outcomes(checked_at) WHERE checked_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_post_analytics_visual
        ON post_analytics(visual_strategy) WHERE visual_strategy IS NOT NULL
    `);

    // 5. Register Hypothesis Review cron job (Sunday 8am Mountain)
    const existing = await client.query(
      `SELECT id FROM cron_jobs WHERE name = $1`,
      ["Hypothesis Review"]
    );
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO cron_jobs (name, description, schedule, agent_id, enabled, last_status, created_at, updated_at)
         VALUES ($1, $2, $3, 'social-media', true, 'pending', NOW(), NOW())`,
        [
          "Hypothesis Review",
          "Weekly review of content hypotheses. Confirms/refutes based on 14 days of post metrics. Updates learning loop.",
          "0 8 * * 0",
        ]
      );
      console.log("[Migrate v9] Created cron job: Hypothesis Review (Sunday 8am)");
    } else {
      console.log("[Migrate v9] Hypothesis Review cron job already exists, skipping");
    }

    await client.query("COMMIT");
    console.log("[Migrate v9] Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v9] Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
