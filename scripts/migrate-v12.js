/**
 * Migration v12: Reduce Cron Noise + Daily Summary + Price Signals
 *
 * 1. Update Polymarket scan from */3 to */15 minutes
 * 2. Add Predict Daily Summary cron job (9am MT = 15:00 UTC)
 * 3. Add price_signals table for real-time price feed
 *
 * Run: node scripts/migrate-v12.js
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

    // 1. Update Polymarket scan frequency from */3 to */15
    console.log("[Migrate v12] Updating Polymarket scan to */15 minutes...");
    await client.query(`
      UPDATE cron_jobs
      SET schedule = '*/15 13-23,0-5 * * *',
          description = 'Scan Polymarket 5/15-minute crypto Up/Down markets every 15 minutes',
          updated_at = NOW()
      WHERE name = 'Predict Polymarket Scan'
    `);

    // 2. Register daily summary cron job (check-then-insert, no unique constraint on name)
    console.log("[Migrate v12] Registering Predict Daily Summary cron job...");
    await client.query(`
      INSERT INTO cron_jobs (name, description, schedule, enabled)
      SELECT 'Predict Daily Summary',
             'Send daily prediction market summary to Telegram at 9am MT',
             '0 9 * * *',
             true
      WHERE NOT EXISTS (
        SELECT 1 FROM cron_jobs WHERE name = 'Predict Daily Summary'
      )
    `);

    // 3. Create price_signals table for real-time price feed
    console.log("[Migrate v12] Creating price_signals table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS price_signals (
        asset            TEXT PRIMARY KEY,
        current_price    NUMERIC(18, 8),
        return_1m        NUMERIC(8, 6),
        return_5m        NUMERIC(8, 6),
        return_15m       NUMERIC(8, 6),
        volatility_5m    NUMERIC(8, 6),
        momentum         TEXT,
        momentum_strength NUMERIC(4, 3),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 4. Add signal tracking columns to market_scans
    console.log("[Migrate v12] Adding signal tracking columns to market_scans...");
    await client.query(`
      ALTER TABLE market_scans
        ADD COLUMN IF NOT EXISTS price_momentum TEXT,
        ADD COLUMN IF NOT EXISTS price_return_5m NUMERIC,
        ADD COLUMN IF NOT EXISTS intel_sentiment NUMERIC,
        ADD COLUMN IF NOT EXISTS intel_signal_count INTEGER,
        ADD COLUMN IF NOT EXISTS p_after_momentum NUMERIC,
        ADD COLUMN IF NOT EXISTS p_final NUMERIC
    `);

    await client.query("COMMIT");
    console.log("[Migrate v12] Done. Cron schedule updated, daily summary registered, price_signals + signal columns created.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v12] Migration failed:", err.message);
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
