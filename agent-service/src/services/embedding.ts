/**
 * Embedding Service (OpenAI text-embedding-3-small)
 *
 * Generates 1536-dimensional embeddings for memory content.
 * Used by the hybrid recall system for semantic similarity search.
 * Falls back gracefully if OPENAI_API_KEY is not configured.
 */

import OpenAI from 'openai';
import { config } from '../config';
import { query } from '../db';

let client: OpenAI | null = null;

const MAX_INPUT_CHARS = 32_000; // ~8K tokens for text-embedding-3-small
const BATCH_SIZE = 100; // OpenAI supports up to 2048 per call; we use 100 for safety

function getClient(): OpenAI | null {
  if (!config.OPENAI_API_KEY) return null;
  if (!client) {
    client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return client;
}

/**
 * Check if the embedding service is configured (API key present).
 */
export function isConfigured(): boolean {
  return !!config.OPENAI_API_KEY;
}

/**
 * Generate an embedding for a single text string.
 * Returns an empty array if the service is not configured or fails.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const openai = getClient();
  if (!openai) return [];

  try {
    const truncated = text.length > MAX_INPUT_CHARS
      ? text.substring(0, MAX_INPUT_CHARS)
      : text;

    const response = await openai.embeddings.create({
      model: config.EMBEDDING_MODEL,
      input: truncated,
      dimensions: config.EMBEDDING_DIMS,
    });

    return response.data[0].embedding;
  } catch (err) {
    console.error('[Embedding] Failed to generate embedding:', (err as Error).message);
    return [];
  }
}

/**
 * Generate embeddings for multiple texts in batches.
 * Returns an array of embedding arrays (same order as input).
 * Failed items get empty arrays.
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const openai = getClient();
  if (!openai) return texts.map(() => []);

  const results: number[][] = new Array(texts.length).fill([]);

  // Process in chunks of BATCH_SIZE
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(t =>
      t.length > MAX_INPUT_CHARS ? t.substring(0, MAX_INPUT_CHARS) : t
    );

    try {
      const response = await openai.embeddings.create({
        model: config.EMBEDDING_MODEL,
        input: batch,
        dimensions: config.EMBEDDING_DIMS,
      });

      for (const item of response.data) {
        results[i + item.index] = item.embedding;
      }
    } catch (err) {
      console.error(`[Embedding] Batch ${i}-${i + batch.length} failed:`, (err as Error).message);
      // Leave failed items as empty arrays
    }
  }

  return results;
}

/**
 * Backfill embeddings for all agent_memory rows that have no embedding.
 * Processes in batches to avoid overwhelming the API.
 * Safe to re-run; only processes rows with NULL embedding.
 */
export async function backfillEmbeddings(batchSize: number = 50): Promise<{ processed: number; failed: number }> {
  if (!isConfigured()) {
    console.warn('[Embedding] Cannot backfill: OPENAI_API_KEY not configured');
    return { processed: 0, failed: 0 };
  }

  let totalProcessed = 0;
  let totalFailed = 0;

  while (true) {
    // Fetch a batch of memories without embeddings
    const rows = await query<{ id: number; content: string }>(
      `SELECT id, content FROM agent_memory WHERE embedding IS NULL ORDER BY id LIMIT $1`,
      [batchSize]
    );

    if (rows.length === 0) break;

    console.log(`[Embedding] Backfilling batch of ${rows.length} memories...`);

    const texts = rows.map(r => r.content);
    const embeddings = await getEmbeddings(texts);

    for (let i = 0; i < rows.length; i++) {
      const embedding = embeddings[i];
      if (embedding.length === 0) {
        totalFailed++;
        continue;
      }

      try {
        await query(
          `UPDATE agent_memory SET embedding = $1::vector WHERE id = $2`,
          [`[${embedding.join(',')}]`, rows[i].id]
        );
        totalProcessed++;
      } catch (err) {
        console.error(`[Embedding] Failed to update memory #${rows[i].id}:`, (err as Error).message);
        totalFailed++;
      }
    }

    console.log(`[Embedding] Progress: ${totalProcessed} embedded, ${totalFailed} failed`);
  }

  console.log(`[Embedding] Backfill complete: ${totalProcessed} processed, ${totalFailed} failed`);
  return { processed: totalProcessed, failed: totalFailed };
}

/**
 * Format an embedding array as a pgvector string literal.
 * Returns null if the embedding is empty.
 */
export function toPgVector(embedding: number[]): string | null {
  if (embedding.length === 0) return null;
  return `[${embedding.join(',')}]`;
}
