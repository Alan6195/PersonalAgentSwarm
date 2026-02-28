/**
 * Memory Decay Engine
 *
 * Daily maintenance that runs at 3 AM (via Memory Maintenance cron job):
 *   1. Archive stale memories (low access, old age)
 *   2. Decay importance levels over time
 *   3. Consolidate near-duplicate memories
 *
 * Never touches 'critical' importance memories.
 * Logs all actions to maintenance_log table.
 */

import { query } from '../db';
import { isConfigured as embeddingConfigured } from './embedding';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface DecayResult {
  archived: number;
  decayed: number;
  consolidated: number;
  errors: string[];
}

// ---------------------------------------------------------------
// Main daily maintenance entry point
// ---------------------------------------------------------------

export async function runDailyMaintenance(): Promise<DecayResult> {
  console.log('[Decay] Starting daily memory maintenance...');
  const result: DecayResult = {
    archived: 0,
    decayed: 0,
    consolidated: 0,
    errors: [],
  };

  // 1. Archive stale memories
  try {
    result.archived = await archiveStaleMemories();
  } catch (err) {
    const msg = `Archive step failed: ${(err as Error).message}`;
    console.error(`[Decay] ${msg}`);
    result.errors.push(msg);
  }

  // 2. Decay importance levels
  try {
    result.decayed = await decayImportance();
  } catch (err) {
    const msg = `Decay step failed: ${(err as Error).message}`;
    console.error(`[Decay] ${msg}`);
    result.errors.push(msg);
  }

  // 3. Consolidate near-duplicates (only if embeddings available)
  if (embeddingConfigured()) {
    try {
      result.consolidated = await consolidateDuplicates();
    } catch (err) {
      const msg = `Consolidation step failed: ${(err as Error).message}`;
      console.error(`[Decay] ${msg}`);
      result.errors.push(msg);
    }
  }

  // Log results to maintenance_log
  try {
    await query(
      `INSERT INTO maintenance_log (run_type, archived_count, consolidated_count, decayed_count, details)
       VALUES ('daily', $1, $2, $3, $4)`,
      [result.archived, result.consolidated, result.decayed, JSON.stringify({ errors: result.errors })]
    );
  } catch (err) {
    console.error('[Decay] Failed to log maintenance results:', (err as Error).message);
  }

  console.log(`[Decay] Maintenance complete: ${result.archived} archived, ${result.decayed} decayed, ${result.consolidated} consolidated`);
  return result;
}

// ---------------------------------------------------------------
// Step 1: Archive stale memories
// ---------------------------------------------------------------

async function archiveStaleMemories(): Promise<number> {
  // Rule 1: 0 accesses and older than 90 days (not critical)
  const stale90 = await query<{ id: number }>(
    `UPDATE agent_memory
     SET status = 'archived'
     WHERE COALESCE(status, 'active') = 'active'
       AND importance != 'critical'
       AND COALESCE(access_count, 0) = 0
       AND created_at < NOW() - INTERVAL '90 days'
     RETURNING id`
  );

  // Rule 2: < 3 accesses and older than 180 days (not critical)
  const stale180 = await query<{ id: number }>(
    `UPDATE agent_memory
     SET status = 'archived'
     WHERE COALESCE(status, 'active') = 'active'
       AND importance != 'critical'
       AND COALESCE(access_count, 0) < 3
       AND created_at < NOW() - INTERVAL '180 days'
     RETURNING id`
  );

  const total = stale90.length + stale180.length;
  if (total > 0) {
    console.log(`[Decay] Archived ${total} stale memories (${stale90.length} from 90-day rule, ${stale180.length} from 180-day rule)`);
  }

  return total;
}

// ---------------------------------------------------------------
// Step 2: Decay importance levels
// ---------------------------------------------------------------

async function decayImportance(): Promise<number> {
  // high -> medium after 60 days without access
  const highDecay = await query<{ id: number }>(
    `UPDATE agent_memory
     SET importance = 'medium'
     WHERE COALESCE(status, 'active') = 'active'
       AND importance = 'high'
       AND created_at < NOW() - INTERVAL '60 days'
       AND (last_accessed_at IS NULL OR last_accessed_at < NOW() - INTERVAL '30 days')
     RETURNING id`
  );

  // medium -> low after 120 days without access
  const mediumDecay = await query<{ id: number }>(
    `UPDATE agent_memory
     SET importance = 'low'
     WHERE COALESCE(status, 'active') = 'active'
       AND importance = 'medium'
       AND created_at < NOW() - INTERVAL '120 days'
       AND (last_accessed_at IS NULL OR last_accessed_at < NOW() - INTERVAL '60 days')
     RETURNING id`
  );

  const total = highDecay.length + mediumDecay.length;
  if (total > 0) {
    console.log(`[Decay] Decayed ${total} memories (${highDecay.length} high->medium, ${mediumDecay.length} medium->low)`);
  }

  return total;
}

// ---------------------------------------------------------------
// Step 3: Consolidate near-duplicate memories
// ---------------------------------------------------------------

async function consolidateDuplicates(): Promise<number> {
  let consolidated = 0;

  // Get all agents with active embedded memories
  const agents = await query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM agent_memory
     WHERE COALESCE(status, 'active') = 'active'
       AND embedding IS NOT NULL`
  );

  for (const { agent_id } of agents) {
    // Get categories for this agent
    const categories = await query<{ category: string }>(
      `SELECT DISTINCT category FROM agent_memory
       WHERE agent_id = $1
         AND COALESCE(status, 'active') = 'active'
         AND embedding IS NOT NULL`,
      [agent_id]
    );

    for (const { category } of categories) {
      // Find pairs with cosine similarity > 0.92
      const pairs = await query<{
        id1: number;
        id2: number;
        access1: number;
        access2: number;
        created1: string;
        created2: string;
        distance: number;
      }>(
        `SELECT
           a.id as id1, b.id as id2,
           COALESCE(a.access_count, 0) as access1,
           COALESCE(b.access_count, 0) as access2,
           a.created_at as created1, b.created_at as created2,
           (a.embedding <=> b.embedding) as distance
         FROM agent_memory a
         JOIN agent_memory b ON a.id < b.id
         WHERE a.agent_id = $1 AND b.agent_id = $1
           AND a.category = $2 AND b.category = $2
           AND COALESCE(a.status, 'active') = 'active'
           AND COALESCE(b.status, 'active') = 'active'
           AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
           AND (a.embedding <=> b.embedding) < 0.08
         LIMIT 20`,
        [agent_id, category]
      );

      for (const pair of pairs) {
        // Keep the one with more accesses (or newer if tied)
        const keepId = pair.access1 >= pair.access2 ? pair.id1 : pair.id2;
        const archiveId = keepId === pair.id1 ? pair.id2 : pair.id1;
        const mergedAccessCount = pair.access1 + pair.access2;

        // Archive the loser
        await query(
          `UPDATE agent_memory SET status = 'archived', superseded_by = $2 WHERE id = $1`,
          [archiveId, keepId]
        );

        // Merge access counts into the winner
        await query(
          `UPDATE agent_memory SET access_count = $2 WHERE id = $1`,
          [keepId, mergedAccessCount]
        );

        // Log the consolidation
        try {
          await query(
            `INSERT INTO memory_conflicts (agent_id, winning_memory_id, losing_memory_id, similarity_score, resolution, reason)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [agent_id, keepId, archiveId, 1 - pair.distance, 'consolidated', 'Daily maintenance: near-duplicate consolidation']
          );
        } catch {
          // Non-critical
        }

        consolidated++;
      }
    }
  }

  if (consolidated > 0) {
    console.log(`[Decay] Consolidated ${consolidated} near-duplicate memory pairs`);
  }

  return consolidated;
}
