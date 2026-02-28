/**
 * Backfill Embeddings for Existing Memories
 *
 * Run after migrate-v5.js to generate embeddings for all existing
 * agent_memory rows. Safe to re-run; only processes NULL embeddings.
 *
 * Usage: DATABASE_URL=... OPENAI_API_KEY=... node scripts/backfill-embeddings.js
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost:5432/mission_control",
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "text-embedding-3-small";
const DIMS = 1536;
const BATCH_SIZE = 50;
const MAX_CHARS = 32000;

async function getEmbeddings(texts) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: texts.map((t) => (t.length > MAX_CHARS ? t.substring(0, MAX_CHARS) : t)),
      dimensions: DIMS,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.data.map((d) => d.embedding);
}

async function backfill() {
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set. Exiting.");
    process.exit(1);
  }

  const client = await pool.connect();
  let totalProcessed = 0;
  let totalFailed = 0;

  try {
    // Count total to process
    const countResult = await client.query(
      "SELECT COUNT(*) as total FROM agent_memory WHERE embedding IS NULL"
    );
    const total = parseInt(countResult.rows[0].total, 10);
    console.log(`[Backfill] ${total} memories need embeddings.`);

    if (total === 0) {
      console.log("[Backfill] Nothing to do.");
      return;
    }

    while (true) {
      const result = await client.query(
        "SELECT id, content FROM agent_memory WHERE embedding IS NULL ORDER BY id LIMIT $1",
        [BATCH_SIZE]
      );

      if (result.rows.length === 0) break;

      console.log(
        `[Backfill] Processing batch of ${result.rows.length}... (${totalProcessed}/${total} done)`
      );

      try {
        const texts = result.rows.map((r) => r.content);
        const embeddings = await getEmbeddings(texts);

        for (let i = 0; i < result.rows.length; i++) {
          const vectorStr = `[${embeddings[i].join(",")}]`;
          await client.query(
            "UPDATE agent_memory SET embedding = $1::vector WHERE id = $2",
            [vectorStr, result.rows[i].id]
          );
          totalProcessed++;
        }
      } catch (err) {
        console.error("[Backfill] Batch failed:", err.message);
        totalFailed += result.rows.length;
        // Skip this batch and continue
      }
    }

    console.log(
      `\n[Backfill] Complete: ${totalProcessed} embedded, ${totalFailed} failed.`
    );
  } finally {
    client.release();
    await pool.end();
  }
}

backfill();
