/**
 * Migration v8: X Agent Analytics Engine
 *
 * Creates tables for post-publish analytics tracking:
 *   - post_analytics: one row per published tweet/thread/image/video post
 *   - scheduled_snapshots: 5 scheduled metric snapshots per post (1h, 4h, 24h, 3d, 7d)
 *   - post_snapshots: actual metrics captured at each interval
 *   - content_performance: rolling aggregated stats by dimension (bucket, hook, topic, hour, day)
 *
 * Also seeds 3 system cron jobs for automated metric collection and aggregation.
 *
 * Run: node scripts/migrate-v8.js
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

    // 1. post_analytics: one row per published post
    console.log("[Migrate v8] Creating post_analytics table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS post_analytics (
        id SERIAL PRIMARY KEY,
        tweet_id TEXT UNIQUE NOT NULL,
        thread_id TEXT,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content_bucket TEXT,
        hook_pattern TEXT,
        topic TEXT,
        has_media BOOLEAN DEFAULT false,
        media_type TEXT,
        has_link BOOLEAN DEFAULT false,
        has_cta BOOLEAN DEFAULT false,
        char_count INTEGER,
        posted_hour INTEGER,
        posted_day INTEGER,
        task_id INTEGER,
        cron_job_name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 2. scheduled_snapshots: 5 rows per post for scheduled metric fetches
    console.log("[Migrate v8] Creating scheduled_snapshots table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_snapshots (
        id SERIAL PRIMARY KEY,
        post_analytics_id INTEGER REFERENCES post_analytics(id) ON DELETE CASCADE,
        tweet_id TEXT NOT NULL,
        interval_label TEXT NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    // 3. post_snapshots: actual metrics captured at each interval
    console.log("[Migrate v8] Creating post_snapshots table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS post_snapshots (
        id SERIAL PRIMARY KEY,
        post_analytics_id INTEGER REFERENCES post_analytics(id) ON DELETE CASCADE,
        tweet_id TEXT NOT NULL,
        interval_label TEXT NOT NULL,
        likes INTEGER DEFAULT 0,
        retweets INTEGER DEFAULT 0,
        replies INTEGER DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        bookmarks INTEGER DEFAULT 0,
        quote_tweets INTEGER DEFAULT 0,
        engagement_rate NUMERIC(8,5),
        captured_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 4. content_performance: rolling aggregated stats
    console.log("[Migrate v8] Creating content_performance table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_performance (
        id SERIAL PRIMARY KEY,
        dimension TEXT NOT NULL,
        dimension_value TEXT NOT NULL,
        period TEXT NOT NULL DEFAULT '30d',
        post_count INTEGER DEFAULT 0,
        avg_likes NUMERIC DEFAULT 0,
        avg_retweets NUMERIC DEFAULT 0,
        avg_replies NUMERIC DEFAULT 0,
        avg_impressions NUMERIC DEFAULT 0,
        avg_engagement_rate NUMERIC DEFAULT 0,
        best_tweet_id TEXT,
        best_engagement_rate NUMERIC,
        worst_tweet_id TEXT,
        worst_engagement_rate NUMERIC,
        computed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(dimension, dimension_value, period)
      )
    `);

    // 5. Create indexes
    console.log("[Migrate v8] Creating indexes...");
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_post_analytics_created ON post_analytics(created_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_post_analytics_type ON post_analytics(content_type)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_post_analytics_bucket ON post_analytics(content_bucket)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_scheduled_snapshots_due ON scheduled_snapshots(status, due_at) WHERE status = 'pending'`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_scheduled_snapshots_post ON scheduled_snapshots(post_analytics_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_post_snapshots_post ON post_snapshots(post_analytics_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_content_performance_dim ON content_performance(dimension, period)`
    );

    // 6. Seed cron jobs (idempotent: ON CONFLICT DO NOTHING)
    console.log("[Migrate v8] Seeding analytics cron jobs...");

    // Analytics Snapshot: hourly at :15, fetches metrics for due snapshots
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, enabled, last_status)
      VALUES (
        'Analytics Snapshot',
        'Fetch X API metrics for posts with due snapshot intervals. System job, no LLM needed.',
        '15 * * * *',
        'social-media',
        true,
        'pending'
      )
      ON CONFLICT (name) DO NOTHING
    `);

    // Content Performance Aggregation: daily at 5 AM Mountain
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, enabled, last_status)
      VALUES (
        'Content Perf Aggregation',
        'Recompute rolling content_performance stats from raw post_snapshots data. System job, no LLM needed.',
        '0 5 * * *',
        'social-media',
        true,
        'pending'
      )
      ON CONFLICT (name) DO NOTHING
    `);

    // Performance Brief Warm: daily at 6 AM Mountain (warm-cache the brief)
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, enabled, last_status)
      VALUES (
        'Performance Brief',
        'Warm-cache the performance brief markdown for injection into social-media agent prompt. System job, no LLM needed.',
        '0 6 * * *',
        'social-media',
        true,
        'pending'
      )
      ON CONFLICT (name) DO NOTHING
    `);

    await client.query("COMMIT");
    console.log("[Migrate v8] Migration complete.");

    // Verification
    const tables = ['post_analytics', 'scheduled_snapshots', 'post_snapshots', 'content_performance'];
    for (const table of tables) {
      const cols = await client.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      console.log(`\n[Migrate v8] ${table} columns:`);
      for (const row of cols.rows) {
        console.log(`  ${row.column_name}: ${row.data_type}`);
      }
    }

    const cronCount = await client.query(
      `SELECT name, schedule, enabled FROM cron_jobs WHERE name IN ('Analytics Snapshot', 'Content Perf Aggregation', 'Performance Brief')`
    );
    console.log(`\n[Migrate v8] Analytics cron jobs:`);
    for (const row of cronCount.rows) {
      console.log(`  ${row.name}: ${row.schedule} (enabled: ${row.enabled})`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v8] Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
