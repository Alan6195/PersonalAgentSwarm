/**
 * Migration v14: Order Flow Signals Table
 *
 * Dashboard-facing table written every 30s by OrderFlowService.
 * Stores live OFI (order flow imbalance) per asset for the predict dashboard.
 *
 * Also registers the Market Discovery cron job for order flow market rotation.
 *
 * Run: node scripts/migrate-v14.js
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

    console.log("[Migrate v14] Creating order_flow_signals table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_flow_signals (
        asset              TEXT PRIMARY KEY,
        market_id          TEXT,
        ofi_30s            NUMERIC,
        ofi_60s            NUMERIC,
        ofi_90s            NUMERIC,
        signal             TEXT,
        signal_strength    NUMERIC,
        large_trade        BOOLEAN,
        large_trade_dir    TEXT,
        trades_per_min     NUMERIC,
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Register the Market Discovery cron job (30-min cycle for order flow market rotation)
    console.log("[Migrate v14] Registering Market Discovery cron job...");
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, agent_id, enabled, job_type)
      VALUES (
        'Predict Market Discovery',
        'Discover active 5/15-min Up/Down crypto markets for order flow scanner',
        '*/30 * * * *',
        'system',
        true,
        'system'
      )
      ON CONFLICT (name) DO NOTHING
    `);

    await client.query("COMMIT");
    console.log("[Migrate v14] Done. order_flow_signals table + Market Discovery cron created.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v14] Migration failed:", err.message);
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
