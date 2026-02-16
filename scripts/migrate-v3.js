/**
 * Migration v3: Travel Agent + Document Generation
 *
 * Run: node scripts/migrate-v3.js
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

    console.log("[Migrate v3] Creating travel_trips table...");

    // 1. Travel trips table (one row per trip)
    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_trips (
        id SERIAL PRIMARY KEY,
        trip_id TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'planning' CHECK (status IN ('planning', 'itinerary_approved', 'booking', 'booked', 'in_progress', 'completed')),
        preferences JSONB DEFAULT '{}',
        budget JSONB DEFAULT '{"hotels_total_eur":0,"activities_total_eur":0,"transport_total_eur":0,"food_estimate_eur":0,"grand_total_eur":0}',
        notes JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("[Migrate v3] Creating travel_items table...");

    // 2. Travel items table (hotels, activities, restaurants, transport)
    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_items (
        id SERIAL PRIMARY KEY,
        trip_db_id INTEGER REFERENCES travel_trips(id) ON DELETE CASCADE,
        region TEXT NOT NULL,
        item_type TEXT NOT NULL CHECK (item_type IN ('hotel', 'activity', 'restaurant', 'transport')),
        name TEXT NOT NULL,
        status TEXT DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'booked', 'vetoed')),
        cost_eur NUMERIC(10,2),
        nightly_rate_eur NUMERIC(10,2),
        nights INTEGER,
        cost_per_person_eur NUMERIC(10,2),
        booking_url TEXT,
        confirmation_number TEXT,
        day DATE,
        time TEXT,
        notes TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Index for fast lookups by trip + region + type
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_travel_items_trip_region
      ON travel_items (trip_db_id, region, item_type);
    `);

    console.log("[Migrate v3] Creating travel_vetoes table...");

    // 3. Travel vetoes table (never suggest these again)
    await client.query(`
      CREATE TABLE IF NOT EXISTS travel_vetoes (
        id SERIAL PRIMARY KEY,
        trip_db_id INTEGER REFERENCES travel_trips(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        region TEXT NOT NULL,
        name TEXT NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(trip_db_id, item_type, region, name)
      );
    `);

    console.log("[Migrate v3] Seeding travel-agent into agents table...");

    // 4. Seed travel-agent in agents table
    await client.query(`
      INSERT INTO agents (id, name, description, model, color)
      VALUES ('travel-agent', 'Travel Agent', 'Portugal honeymoon travel concierge', 'opus', '#f59e0b')
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log("[Migrate v3] Seeding default Portugal honeymoon trip...");

    // 5. Seed the default trip (idempotent)
    await client.query(`
      INSERT INTO travel_trips (trip_id, status, preferences, budget, notes)
      VALUES (
        'portugal-honeymoon-2026',
        'planning',
        '{"hotel_style":"boutique luxury","dietary":["dairy-free","gluten-free"],"budget_per_night_eur":[150,400]}',
        '{"hotels_total_eur":0,"activities_total_eur":0,"transport_total_eur":0,"food_estimate_eur":0,"grand_total_eur":0}',
        '["First day or two should be chill after the wedding","Carissa is dairy-free and gluten-free","Trip starts in Porto, ends near Faro"]'
      )
      ON CONFLICT (trip_id) DO NOTHING;
    `);

    await client.query("COMMIT");
    console.log("[Migrate v3] Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v3] Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
