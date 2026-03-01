/**
 * Migration v6: Travel Agent Overhaul
 *
 * Adds GF/DF rating and price-per-person columns to travel_items.
 * Creates travel_flights and travel_flight_price_history tables
 * for Chase UR points flight tracking.
 *
 * Run: node scripts/migrate-v6.js
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

    // 1. Add gf_df_rating column to travel_items
    console.log("[Migrate v6] Adding gf_df_rating column to travel_items...");
    await client.query(
      `ALTER TABLE travel_items ADD COLUMN IF NOT EXISTS gf_df_rating VARCHAR(20)`
    );

    // 2. Add price_per_person column to travel_items
    console.log("[Migrate v6] Adding price_per_person column to travel_items...");
    await client.query(
      `ALTER TABLE travel_items ADD COLUMN IF NOT EXISTS price_per_person DECIMAL(10,2)`
    );

    // 3. Create travel_flights table
    console.log("[Migrate v6] Creating travel_flights table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_flights (
        id SERIAL PRIMARY KEY,
        trip_db_id INTEGER REFERENCES travel_trips(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK (direction IN ('outbound', 'return')),
        route TEXT,
        departure_airport TEXT NOT NULL,
        arrival_airport TEXT NOT NULL,
        departure_date DATE,
        airline TEXT,
        cabin_class TEXT DEFAULT 'economy',
        price_usd DECIMAL(10,2),
        points_cost INTEGER,
        points_program TEXT,
        cpp_value DECIMAL(5,2),
        status TEXT DEFAULT 'tracking' CHECK (status IN ('tracking', 'price_alert', 'booked', 'cancelled')),
        booked_via TEXT,
        confirmation_number TEXT,
        notes TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 4. Create travel_flight_price_history table
    console.log("[Migrate v6] Creating travel_flight_price_history table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_flight_price_history (
        id SERIAL PRIMARY KEY,
        flight_id INTEGER REFERENCES travel_flights(id) ON DELETE CASCADE,
        price_usd DECIMAL(10,2),
        points_cost INTEGER,
        source TEXT,
        checked_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 5. Create indexes
    console.log("[Migrate v6] Creating indexes...");
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_travel_flights_trip ON travel_flights(trip_db_id, direction)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_flight_price_history_flight ON travel_flight_price_history(flight_id, checked_at DESC)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_travel_items_gf_df ON travel_items(gf_df_rating) WHERE gf_df_rating IS NOT NULL`
    );

    await client.query("COMMIT");
    console.log("[Migrate v6] Migration complete.");

    // Verification
    const itemCols = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'travel_items'
      ORDER BY ordinal_position
    `);
    console.log("\n[Migrate v6] travel_items columns:");
    for (const row of itemCols.rows) {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    }

    const flightTable = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'travel_flights'
      ORDER BY ordinal_position
    `);
    console.log("\n[Migrate v6] travel_flights columns:");
    for (const row of flightTable.rows) {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    }

    const historyTable = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'travel_flight_price_history'
      ORDER BY ordinal_position
    `);
    console.log("\n[Migrate v6] travel_flight_price_history columns:");
    for (const row of historyTable.rows) {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    }

    const flightCount = await client.query(
      `SELECT COUNT(*) as total FROM travel_flights`
    );
    console.log(
      `\n[Migrate v6] Total flight records: ${flightCount.rows[0].total}`
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v6] Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
