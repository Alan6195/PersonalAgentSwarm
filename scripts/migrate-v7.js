/**
 * Migration v7: Dashboard Interactivity
 *
 * Creates dashboard_messages table for storing conversation
 * between the dashboard UI and the travel agent.
 *
 * Run: node scripts/migrate-v7.js
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

    // 1. Create dashboard_messages table
    console.log("[Migrate v7] Creating dashboard_messages table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS dashboard_messages (
        id SERIAL PRIMARY KEY,
        trip_db_id INTEGER REFERENCES travel_trips(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK (direction IN ('user', 'agent')),
        content TEXT NOT NULL,
        item_id INTEGER,
        action_type TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 2. Create index for efficient trip-scoped queries
    console.log("[Migrate v7] Creating indexes...");
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_dashboard_messages_trip ON dashboard_messages(trip_db_id, created_at DESC)`
    );

    await client.query("COMMIT");
    console.log("[Migrate v7] Migration complete.");

    // Verification
    const msgCols = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'dashboard_messages'
      ORDER BY ordinal_position
    `);
    console.log("\n[Migrate v7] dashboard_messages columns:");
    for (const row of msgCols.rows) {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    }

    const msgCount = await client.query(
      `SELECT COUNT(*) as total FROM dashboard_messages`
    );
    console.log(
      `\n[Migrate v7] Total dashboard message records: ${msgCount.rows[0].total}`
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v7] Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
