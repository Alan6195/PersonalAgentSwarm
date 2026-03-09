/**
 * Migration v13: Agent Config Table
 *
 * Persistent key-value config store that overrides env vars at runtime.
 * Used by /predict golive to flip DRY_RUN without redeploying.
 *
 * Run: node scripts/migrate-v13.js
 * Safe to re-run (idempotent).
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

    console.log("[Migrate v13] Creating agent_config table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query("COMMIT");
    console.log("[Migrate v13] Done. agent_config table created.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v13] Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
