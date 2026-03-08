/**
 * Migration v11: Polymarket 5-Minute Scanner
 *
 * Adds cron job for Polymarket 5-minute crypto market scanning.
 * Runs every 3 minutes during active hours (7am-11pm MT = 13:00-05:00 UTC).
 *
 * Run: node scripts/migrate-v11.js
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

    // Register Polymarket scan cron job
    console.log("[Migrate v11] Registering Polymarket scan cron job...");
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, enabled, job_type)
      VALUES (
        'Predict Polymarket Scan',
        'Scan Polymarket 5-minute crypto Up/Down markets every 3 minutes',
        '*/3 13-23,0-5 * * *',
        'predict-agent',
        true,
        'system'
      )
      ON CONFLICT (name) DO UPDATE SET
        schedule = EXCLUDED.schedule,
        description = EXCLUDED.description,
        enabled = EXCLUDED.enabled
    `);

    await client.query("COMMIT");
    console.log("[Migrate v11] Done. Polymarket cron job registered.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v11] Migration failed:", err.message);
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
