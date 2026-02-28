/**
 * Migration v5: Memory System Upgrade
 *
 * Adds pgvector extension, embedding columns, conflict resolution,
 * cross-agent sharing, access tracking, and maintenance infrastructure.
 *
 * Run: node scripts/migrate-v5.js
 * Safe to re-run (all operations are idempotent).
 *
 * Prerequisites: PostgreSQL must use pgvector/pgvector:pg16 image.
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

    // 1. Enable pgvector extension
    console.log("[Migrate v5] Enabling pgvector extension...");
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // 2. Add embedding column (1536 dims for OpenAI text-embedding-3-small)
    console.log("[Migrate v5] Adding embedding column to agent_memory...");
    await client.query(
      `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS embedding vector(1536)`
    );

    // 3. Add status column for conflict resolution (active/archived/contradicted)
    console.log("[Migrate v5] Adding status column...");
    await client.query(
      `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`
    );

    // 4. Add access tracking columns for decay engine
    console.log("[Migrate v5] Adding access tracking columns...");
    await client.query(
      `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0`
    );
    await client.query(
      `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`
    );

    // 5. Add cross-agent memory bus columns
    console.log("[Migrate v5] Adding cross-agent sharing columns...");
    await client.query(
      `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'private'`
    );
    await client.query(
      `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS source_agent TEXT`
    );

    // 6. Add conflict resolution columns
    console.log("[Migrate v5] Adding conflict resolution columns...");
    await client.query(
      `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS superseded_by INTEGER REFERENCES agent_memory(id)`
    );
    await client.query(
      `ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS fact_hash TEXT`
    );

    // 7. Backfill source_agent from agent_id for existing records
    console.log("[Migrate v5] Backfilling source_agent from agent_id...");
    await client.query(
      `UPDATE agent_memory SET source_agent = agent_id WHERE source_agent IS NULL`
    );

    // 8. Create indexes
    console.log("[Migrate v5] Creating indexes...");
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_agent_memory_status ON agent_memory(status)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_agent_memory_visibility ON agent_memory(visibility)`
    );

    // 9. Create HNSW vector index (only if there are embeddings; otherwise deferred)
    // HNSW requires at least 1 row with a non-null embedding to build.
    // We create it unconditionally; Postgres handles empty tables gracefully.
    console.log("[Migrate v5] Creating HNSW vector index...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
      ON agent_memory USING hnsw (embedding vector_cosine_ops)
    `);

    // 10. Create memory_conflicts audit table
    console.log("[Migrate v5] Creating memory_conflicts table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_conflicts (
        id SERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        winning_memory_id INTEGER REFERENCES agent_memory(id),
        losing_memory_id INTEGER REFERENCES agent_memory(id),
        similarity_score NUMERIC(4,3),
        resolution TEXT NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 11. Create maintenance_log table
    console.log("[Migrate v5] Creating maintenance_log table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS maintenance_log (
        id SERIAL PRIMARY KEY,
        run_type TEXT NOT NULL DEFAULT 'daily',
        archived_count INTEGER DEFAULT 0,
        consolidated_count INTEGER DEFAULT 0,
        decayed_count INTEGER DEFAULT 0,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 12. Register Memory Maintenance cron job
    console.log("[Migrate v5] Registering Memory Maintenance cron job...");
    const existing = await client.query(
      `SELECT id FROM cron_jobs WHERE name = 'Memory Maintenance'`
    );
    if (existing.rows.length === 0) {
      await client.query(`
        INSERT INTO cron_jobs (name, description, schedule, agent_id, enabled, last_status, created_at, updated_at)
        VALUES (
          'Memory Maintenance',
          'Daily 3 AM: archive stale memories, decay importance, consolidate duplicates',
          '0 3 * * *',
          'alan-os',
          true,
          'pending',
          NOW(),
          NOW()
        )
      `);
      console.log("[Migrate v5] Memory Maintenance cron job created.");
    } else {
      console.log("[Migrate v5] Memory Maintenance cron job already exists.");
    }

    await client.query("COMMIT");
    console.log("[Migrate v5] Migration complete.");

    // Verification
    const cols = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'agent_memory'
      ORDER BY ordinal_position
    `);
    console.log("\n[Migrate v5] agent_memory columns:");
    for (const row of cols.rows) {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    }

    const memCount = await client.query(
      `SELECT COUNT(*) as total FROM agent_memory`
    );
    console.log(
      `\n[Migrate v5] Total memories: ${memCount.rows[0].total}`
    );

    const extCheck = await client.query(
      `SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'`
    );
    if (extCheck.rows.length > 0) {
      console.log(
        `[Migrate v5] pgvector extension: v${extCheck.rows[0].extversion}`
      );
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Migrate v5] Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
