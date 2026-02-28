/**
 * Memory Conflict Resolver
 *
 * Detects and resolves conflicts between new memories and existing ones.
 * Uses cosine similarity to find potential duplicates/contradictions,
 * then calls Claude Haiku for arbitration on ambiguous cases.
 *
 * Thresholds:
 *   > 0.90 similarity = duplicate (skip insert)
 *   0.70 - 0.90 = potential conflict (LLM arbitration)
 *   < 0.70 = unrelated (no conflict)
 *
 * Never deletes memories; always archives with status='contradicted'.
 */

import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db';
import { config } from '../config';
import { toPgVector } from './embedding';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface ConflictCheckResult {
  action: 'insert' | 'skip' | 'replace';
  existingMemoryId?: number;
  reason?: string;
}

interface CandidateMemory {
  id: number;
  content: string;
  importance: string;
  created_at: string;
  cosine_distance: number;
}

// ---------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------

const DUPLICATE_THRESHOLD = 0.90;  // similarity > 0.90 = duplicate
const CONFLICT_THRESHOLD = 0.70;   // similarity 0.70-0.90 = needs arbitration

// ---------------------------------------------------------------
// Check for conflicts before inserting a new memory
// ---------------------------------------------------------------

export async function checkForConflicts(
  agentId: string,
  category: string,
  content: string,
  embedding: number[]
): Promise<ConflictCheckResult> {
  // If no embedding, skip conflict detection (keyword-only mode)
  if (embedding.length === 0) {
    return { action: 'insert' };
  }

  const pgVec = toPgVector(embedding);
  if (!pgVec) return { action: 'insert' };

  // Find similar memories from same agent + category
  let candidates: CandidateMemory[];
  try {
    candidates = await query<CandidateMemory>(
      `SELECT id, content, importance, created_at,
              (embedding <=> $3::vector) AS cosine_distance
       FROM agent_memory
       WHERE agent_id = $1
         AND category = $2
         AND COALESCE(status, 'active') = 'active'
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $3::vector
       LIMIT 5`,
      [agentId, category, pgVec]
    );
  } catch (err) {
    console.warn('[ConflictResolver] Similarity search failed, allowing insert:', (err as Error).message);
    return { action: 'insert' };
  }

  if (candidates.length === 0) {
    return { action: 'insert' };
  }

  // Check closest match
  const closest = candidates[0];
  const similarity = 1 - closest.cosine_distance;

  // Exact/near duplicate: skip
  if (similarity > DUPLICATE_THRESHOLD) {
    console.log(`[ConflictResolver] Duplicate detected (similarity=${similarity.toFixed(3)}) with memory #${closest.id}. Skipping.`);
    return {
      action: 'skip',
      existingMemoryId: closest.id,
      reason: `Duplicate (${(similarity * 100).toFixed(1)}% similar)`,
    };
  }

  // Potential conflict: ask Claude Haiku
  if (similarity > CONFLICT_THRESHOLD) {
    console.log(`[ConflictResolver] Potential conflict (similarity=${similarity.toFixed(3)}) with memory #${closest.id}. Arbitrating...`);
    return await arbitrateConflict(agentId, content, closest);
  }

  // Low similarity: no conflict
  return { action: 'insert' };
}

// ---------------------------------------------------------------
// LLM arbitration for ambiguous conflicts (Claude Haiku)
// ---------------------------------------------------------------

async function arbitrateConflict(
  agentId: string,
  newContent: string,
  existing: CandidateMemory
): Promise<ConflictCheckResult> {
  if (!config.ANTHROPIC_API_KEY) {
    // Can't arbitrate without API key; allow insert
    return { action: 'insert' };
  }

  try {
    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-haiku-3-20240307',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Compare these two memory entries for the same agent. Do they contradict each other, or are they compatible/complementary?

EXISTING MEMORY (stored ${new Date(existing.created_at).toLocaleDateString()}):
${existing.content.substring(0, 500)}

NEW MEMORY:
${newContent.substring(0, 500)}

Respond with EXACTLY one of:
- "COMPATIBLE" if they can coexist (different topics, complementary info)
- "CONTRADICTION_NEW_WINS" if the new memory supersedes/updates the old one
- "CONTRADICTION_OLD_WINS" if the existing memory is more authoritative
- "DUPLICATE" if they contain the same information`,
        },
      ],
    });

    const verdict = (response.content[0] as { type: string; text: string }).text
      .trim()
      .toUpperCase();

    if (verdict.includes('DUPLICATE')) {
      console.log(`[ConflictResolver] LLM verdict: DUPLICATE with memory #${existing.id}`);
      return {
        action: 'skip',
        existingMemoryId: existing.id,
        reason: 'LLM determined duplicate',
      };
    }

    if (verdict.includes('CONTRADICTION_NEW_WINS')) {
      console.log(`[ConflictResolver] LLM verdict: NEW WINS over memory #${existing.id}`);
      await archiveMemory(existing.id, agentId, 'LLM arbitration: new memory supersedes');
      return {
        action: 'replace',
        existingMemoryId: existing.id,
        reason: 'New memory supersedes existing (LLM arbitration)',
      };
    }

    if (verdict.includes('CONTRADICTION_OLD_WINS')) {
      console.log(`[ConflictResolver] LLM verdict: OLD WINS, skipping new memory`);
      return {
        action: 'skip',
        existingMemoryId: existing.id,
        reason: 'Existing memory more authoritative (LLM arbitration)',
      };
    }

    // COMPATIBLE or unrecognized: allow insert
    return { action: 'insert' };
  } catch (err) {
    console.warn('[ConflictResolver] LLM arbitration failed, allowing insert:', (err as Error).message);
    return { action: 'insert' };
  }
}

// ---------------------------------------------------------------
// Archive a memory (never delete)
// ---------------------------------------------------------------

export async function archiveMemory(
  memoryId: number,
  agentId: string,
  reason: string,
  supersededById?: number
): Promise<void> {
  await query(
    `UPDATE agent_memory
     SET status = 'contradicted',
         superseded_by = $2
     WHERE id = $1`,
    [memoryId, supersededById ?? null]
  );

  // Log to memory_conflicts audit table
  try {
    await query(
      `INSERT INTO memory_conflicts (agent_id, winning_memory_id, losing_memory_id, resolution, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [agentId, supersededById ?? null, memoryId, 'archived', reason]
    );
  } catch (err) {
    // memory_conflicts table might not exist yet pre-migration; non-critical
    console.warn('[ConflictResolver] Failed to log conflict:', (err as Error).message);
  }

  console.log(`[ConflictResolver] Archived memory #${memoryId}: ${reason}`);
}
