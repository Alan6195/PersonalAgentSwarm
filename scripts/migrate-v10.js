/**
 * Migration v10: Predict Agent
 *
 * Creates tables for the prediction market trading agent:
 * - market_scans: raw scan results from Manifold/Polymarket
 * - market_positions: open and closed trades with full reasoning
 * - daily_risk_state: daily risk tracking and pause state
 * - equity_snapshots: equity curve data for dashboard
 * - predict_hypotheses: trading strategy hypotheses (learning loop)
 * - predict_hypotheses_log: evidence log linking hypotheses to positions
 * - shared_signals: cross-agent intelligence (X intel -> predict)
 *
 * Registers predict cron jobs for scanning, snapshots, risk reset, resolution checks, and weekly review.
 *
 * Run: node scripts/migrate-v10.js
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

    // 1. market_scans table
    console.log("[Migrate v10] Creating market_scans table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_scans (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('manifold', 'polymarket')),
        market_id TEXT NOT NULL,
        market_url TEXT,
        question TEXT NOT NULL,
        category TEXT,
        current_prob NUMERIC(5,4),
        volume_usd NUMERIC(12,2),
        liquidity_usd NUMERIC(12,2),
        close_date TIMESTAMPTZ,
        num_traders INTEGER,
        claude_prob NUMERIC(5,4),
        claude_confidence NUMERIC(5,4),
        claude_reasoning TEXT,
        edge NUMERIC(6,4),
        abs_edge NUMERIC(6,4),
        kelly_fraction NUMERIC(6,4),
        expected_return NUMERIC(8,4),
        reward_score NUMERIC(8,4),
        intel_aligned BOOLEAN DEFAULT false,
        acted_on BOOLEAN DEFAULT false,
        scanned_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 2. market_positions table
    console.log("[Migrate v10] Creating market_positions table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_positions (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('manifold', 'polymarket')),
        market_id TEXT NOT NULL,
        market_url TEXT,
        question TEXT NOT NULL,
        category TEXT,
        asset TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('YES', 'NO')),
        p_market NUMERIC(5,4) NOT NULL,
        p_model NUMERIC(5,4) NOT NULL,
        edge NUMERIC(6,4) NOT NULL,
        kelly_fraction NUMERIC(6,4) NOT NULL,
        bet_size NUMERIC(12,4) NOT NULL,
        fill_price NUMERIC(5,4),
        reward_score NUMERIC(8,4),
        expected_return NUMERIC(8,4),
        hedge_profit NUMERIC(6,4),
        is_hedge BOOLEAN DEFAULT false,
        intel_signal_id INTEGER,
        intel_aligned BOOLEAN NOT NULL DEFAULT false,
        status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed_win', 'closed_loss', 'closed_expired', 'cancelled')),
        outcome TEXT CHECK (outcome IN ('win', 'loss', 'push')),
        pnl NUMERIC(12,4),
        pnl_pct NUMERIC(8,4),
        exit_prob NUMERIC(5,4),
        reasoning TEXT NOT NULL,
        scan_id INTEGER REFERENCES market_scans(id),
        opened_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        resolution_checked_at TIMESTAMPTZ,
        bet_id TEXT,
        metadata JSONB DEFAULT '{}'
      )
    `);

    // 3. daily_risk_state table
    console.log("[Migrate v10] Creating daily_risk_state table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_risk_state (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        platform TEXT NOT NULL DEFAULT 'manifold',
        starting_bankroll NUMERIC(12,4) NOT NULL,
        current_bankroll NUMERIC(12,4) NOT NULL,
        peak_bankroll NUMERIC(12,4) NOT NULL,
        daily_pnl NUMERIC(12,4) DEFAULT 0,
        daily_loss NUMERIC(12,4) DEFAULT 0,
        trades_opened INTEGER DEFAULT 0,
        trades_closed INTEGER DEFAULT 0,
        current_exposure NUMERIC(8,4) DEFAULT 0,
        current_drawdown NUMERIC(8,4) DEFAULT 0,
        trading_paused BOOLEAN DEFAULT false,
        pause_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(date, platform)
      )
    `);

    // 4. equity_snapshots table
    console.log("[Migrate v10] Creating equity_snapshots table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS equity_snapshots (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'manifold',
        bankroll NUMERIC(12,4) NOT NULL,
        unrealized_pnl NUMERIC(12,4) DEFAULT 0,
        total_equity NUMERIC(12,4) NOT NULL,
        positions_open INTEGER DEFAULT 0,
        win_rate NUMERIC(5,4),
        total_trades INTEGER DEFAULT 0,
        snapshot_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 5. predict_hypotheses table
    console.log("[Migrate v10] Creating predict_hypotheses table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS predict_hypotheses (
        id SERIAL PRIMARY KEY,
        hypothesis TEXT NOT NULL,
        variable TEXT NOT NULL,
        category TEXT,
        prediction TEXT,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'refuted', 'superseded')),
        confidence NUMERIC(5,2) DEFAULT 50.0,
        win_count INTEGER DEFAULT 0,
        loss_count INTEGER DEFAULT 0,
        evidence_position_ids INTEGER[] DEFAULT '{}',
        superseded_by INTEGER REFERENCES predict_hypotheses(id),
        refutation_note TEXT,
        source TEXT DEFAULT 'implicit' CHECK (source IN ('implicit', 'weekly_review', 'manual')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);

    // 6. predict_hypotheses_log table
    console.log("[Migrate v10] Creating predict_hypotheses_log table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS predict_hypotheses_log (
        id SERIAL PRIMARY KEY,
        hypothesis_id INTEGER NOT NULL REFERENCES predict_hypotheses(id),
        position_id INTEGER NOT NULL REFERENCES market_positions(id),
        outcome TEXT NOT NULL CHECK (outcome IN ('supporting', 'refuting')),
        confidence_delta NUMERIC(5,2),
        logged_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 7. shared_signals table
    console.log("[Migrate v10] Creating shared_signals table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_signals (
        id SERIAL PRIMARY KEY,
        source_agent TEXT NOT NULL,
        target_agent TEXT,
        signal_type TEXT NOT NULL,
        topic TEXT NOT NULL,
        direction TEXT NOT NULL,
        strength NUMERIC(5,4),
        summary TEXT,
        metadata JSONB DEFAULT '{}',
        consumed_by_predict BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 8. Indexes
    console.log("[Migrate v10] Creating indexes...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_market_scans_time
        ON market_scans(scanned_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_market_scans_platform
        ON market_scans(platform, scanned_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_positions_status
        ON market_positions(status) WHERE status = 'open'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_positions_platform_status
        ON market_positions(platform, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_positions_opened
        ON market_positions(opened_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_equity_time
        ON equity_snapshots(snapshot_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_risk_date
        ON daily_risk_state(date DESC, platform)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_predict_hyp_status
        ON predict_hypotheses(status) WHERE status = 'active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shared_signals_unconsumed
        ON shared_signals(consumed_by_predict, created_at DESC) WHERE consumed_by_predict = false
    `);

    // 9. Register cron jobs
    const cronJobs = [
      {
        name: "Predict Manifold Scan",
        description: "Scans Manifold markets for mispriced opportunities. Estimates probabilities via Claude, runs risk gate, executes trades if approved.",
        schedule: "0 13,17,21,1,5 * * *",
        agent_id: null,
      },
      {
        name: "Predict Equity Snapshot",
        description: "Records equity curve data point for dashboard. Captures bankroll, unrealized P&L, win rate.",
        schedule: "*/15 * * * *",
        agent_id: null,
      },
      {
        name: "Predict Daily Risk Reset",
        description: "Resets daily risk counters at 6am MT. Creates new daily_risk_state row.",
        schedule: "0 13 * * *",
        agent_id: null,
      },
      {
        name: "Predict Resolution Check",
        description: "Checks open positions for market resolution. Calculates P&L, logs hypothesis evidence.",
        schedule: "*/30 * * * *",
        agent_id: null,
      },
      {
        name: "Predict Hypothesis Review",
        description: "Weekly Claude-powered review of trading hypotheses. Confirms/refutes based on 14 days of trade data.",
        schedule: "0 14 * * 0",
        agent_id: null,
      },
    ];

    for (const job of cronJobs) {
      const existing = await client.query(
        `SELECT id FROM cron_jobs WHERE name = $1`,
        [job.name]
      );
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO cron_jobs (name, description, schedule, agent_id, enabled, last_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, true, 'pending', NOW(), NOW())`,
          [job.name, job.description, job.schedule, job.agent_id]
        );
        console.log(`[Migrate v10] Created cron job: ${job.name}`);
      } else {
        console.log(`[Migrate v10] Cron job "${job.name}" already exists, skipping`);
      }
    }

    await client.query("COMMIT");
    console.log("[Migrate v10] Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v10] Migration failed:", err.message);
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
