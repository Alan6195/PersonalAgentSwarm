/**
 * Persistent semantic memory for agents.
 *
 * Stores conversation summaries, key facts, and context in PostgreSQL.
 * Each memory entry has an agent_id, category, content, keywords,
 * and an optional embedding vector for semantic similarity search.
 *
 * Recall uses a hybrid scoring system:
 *   0.4 * keyword overlap + 0.3 * cosine similarity + 0.2 * recency + 0.1 * importance
 *
 * Falls back gracefully to keyword-only if embeddings are unavailable.
 */

import { createHash } from 'crypto';
import { query, queryOne } from '../db';
import { getEmbedding, isConfigured as embeddingConfigured, toPgVector } from './embedding';
import { checkForConflicts } from './conflict-resolver';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface MemoryEntry {
  id: number;
  agent_id: string;
  category: string;
  content: string;
  keywords: string[];
  importance: 'low' | 'medium' | 'high' | 'critical';
  status: 'active' | 'archived' | 'contradicted';
  access_count: number;
  last_accessed_at: string | null;
  visibility: 'private' | 'shared' | 'broadcast';
  source_agent: string | null;
  created_at: string;
}

export interface StoreMemoryParams {
  agentId: string;
  category: string;
  content: string;
  keywords: string[];
  importance?: 'low' | 'medium' | 'high' | 'critical';
}

// Hybrid scoring weights
const W_KEYWORD = 0.4;
const W_COSINE = 0.3;
const W_RECENCY = 0.2;
const W_IMPORTANCE = 0.1;

// ---------------------------------------------------------------
// Cross-agent memory bus: clusters and broadcast config
// ---------------------------------------------------------------

const AGENT_CLUSTERS: Record<string, string[]> = {
  wedding: ['wedding-planner', 'life-admin', 'comms-drafter', 'alan-os'],
  work: ['alan-os', 'ascend-builder', 'research-analyst', 'legal-advisor'],
  social: ['social-media', 'research-analyst', 'comms-drafter'],
  ops: ['alan-os', 'gilfoyle', 'ascend-builder'],
};

// Categories that auto-broadcast (visible to cluster peers)
const BROADCAST_CATEGORIES: Record<string, string[]> = {
  'wedding-planner': ['wedding', 'schedule'],
  'legal-advisor': ['co_parent_issue', 'schedule'],
  'life-admin': ['financial', 'schedule'],
  'alan-os': ['schedule'],
};

/**
 * Get all agents that share a cluster with the given agent (excluding self).
 */
function getClusterPeers(agentId: string): string[] {
  const peers = new Set<string>();
  for (const members of Object.values(AGENT_CLUSTERS)) {
    if (members.includes(agentId)) {
      for (const m of members) {
        if (m !== agentId) peers.add(m);
      }
    }
  }
  return Array.from(peers);
}

// ---------------------------------------------------------------
// Ensure table exists (called once on startup)
// ---------------------------------------------------------------

let initialized = false;

export async function initialize(): Promise<void> {
  if (initialized) return;

  await query(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      keywords TEXT[] DEFAULT '{}',
      importance TEXT DEFAULT 'medium' CHECK (importance IN ('low', 'medium', 'high', 'critical')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Index for fast agent + keyword lookups
  await query(`
    CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_agent_memory_keywords ON agent_memory USING GIN(keywords);
  `);

  initialized = true;
  console.log('[AgentMemory] Table initialized.');
}

// ---------------------------------------------------------------
// Store a memory (with embedding generation)
// ---------------------------------------------------------------

export async function store(params: StoreMemoryParams): Promise<number> {
  await initialize();

  // Generate embedding (returns [] if OpenAI not configured)
  let embeddingVector: number[] = [];
  try {
    embeddingVector = await getEmbedding(params.content);
  } catch (err) {
    console.warn('[AgentMemory] Embedding generation failed, storing without:', (err as Error).message);
  }

  // Generate fact_hash for conflict detection
  const factHash = createHash('sha256')
    .update(`${params.agentId}:${params.category}:${params.content.substring(0, 500).toLowerCase().trim()}`)
    .digest('hex')
    .substring(0, 16);

  const pgVec = toPgVector(embeddingVector);

  // Check for conflicts/duplicates before inserting
  const conflict = await checkForConflicts(
    params.agentId,
    params.category,
    params.content,
    embeddingVector
  );

  if (conflict.action === 'skip') {
    console.log(`[AgentMemory] Skipped duplicate for ${params.agentId}: ${conflict.reason}`);
    return conflict.existingMemoryId ?? -1;
  }

  // 'insert' or 'replace' both proceed with INSERT (replace already archived the old one)

  // Auto-set visibility for broadcast categories
  const broadcastCats = BROADCAST_CATEGORIES[params.agentId] ?? [];
  const visibility = broadcastCats.includes(params.category) ? 'broadcast' : 'private';

  const rows = await query<{ id: number }>(
    `INSERT INTO agent_memory (agent_id, category, content, keywords, importance, embedding, source_agent, fact_hash, visibility)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9)
     RETURNING id`,
    [
      params.agentId,
      params.category,
      params.content,
      params.keywords,
      params.importance ?? 'medium',
      pgVec,
      params.agentId,
      factHash,
      visibility,
    ]
  );

  const newId = rows[0].id;

  // If this replaced an old memory, update the superseded_by pointer
  if (conflict.action === 'replace' && conflict.existingMemoryId) {
    try {
      await query(
        'UPDATE agent_memory SET superseded_by = $1 WHERE id = $2',
        [newId, conflict.existingMemoryId]
      );
    } catch {
      // Non-critical
    }
  }

  console.log(`[AgentMemory] Stored memory #${newId} for ${params.agentId} (${params.category})${pgVec ? ' [embedded]' : ''}${conflict.action === 'replace' ? ` [replaced #${conflict.existingMemoryId}]` : ''}`);
  return newId;
}

// ---------------------------------------------------------------
// Hybrid recall: keyword + semantic + recency + importance
// ---------------------------------------------------------------

interface ScoredMemory extends MemoryEntry {
  _keywordScore: number;
  _cosineScore: number;
  _recencyScore: number;
  _importanceScore: number;
  _hybridScore: number;
}

export async function recall(
  agentId: string,
  userMessage: string,
  limit: number = 8
): Promise<MemoryEntry[]> {
  await initialize();

  const messageWords = extractKeywords(userMessage);

  // If no keywords at all, return recent important active memories
  if (messageWords.length === 0) {
    const rows = await query<MemoryEntry>(
      `SELECT id, agent_id, category, content, keywords, importance,
              COALESCE(status, 'active') as status,
              COALESCE(access_count, 0) as access_count,
              last_accessed_at,
              COALESCE(visibility, 'private') as visibility,
              source_agent,
              created_at
       FROM agent_memory
       WHERE agent_id = $1 AND COALESCE(status, 'active') = 'active'
       ORDER BY
         CASE importance
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
         END,
         created_at DESC
       LIMIT $2`,
      [agentId, limit]
    );
    await updateAccessTracking(rows.map(r => r.id));
    return rows;
  }

  // Run keyword and semantic searches in parallel
  const [keywordResults, semanticResults] = await Promise.all([
    keywordSearch(agentId, messageWords),
    semanticSearch(agentId, userMessage),
  ]);

  // Merge and deduplicate by memory ID
  const mergedMap = new Map<number, ScoredMemory>();

  for (const row of keywordResults) {
    mergedMap.set(row.id, {
      ...row,
      _keywordScore: row._keywordScore,
      _cosineScore: 0,
      _recencyScore: computeRecencyScore(row.created_at),
      _importanceScore: computeImportanceScore(row.importance),
      _hybridScore: 0,
    });
  }

  for (const row of semanticResults) {
    const existing = mergedMap.get(row.id);
    if (existing) {
      existing._cosineScore = row._cosineScore;
    } else {
      mergedMap.set(row.id, {
        ...row,
        _keywordScore: 0,
        _cosineScore: row._cosineScore,
        _recencyScore: computeRecencyScore(row.created_at),
        _importanceScore: computeImportanceScore(row.importance),
        _hybridScore: 0,
      });
    }
  }

  // Compute hybrid scores and sort
  const scored = Array.from(mergedMap.values());
  for (const mem of scored) {
    mem._hybridScore =
      W_KEYWORD * mem._keywordScore +
      W_COSINE * mem._cosineScore +
      W_RECENCY * mem._recencyScore +
      W_IMPORTANCE * mem._importanceScore;
  }

  scored.sort((a, b) => b._hybridScore - a._hybridScore);
  const topResults = scored.slice(0, limit);

  // Cross-agent: fetch shared/broadcast memories from cluster peers (max 5)
  const crossAgentMemories = await fetchCrossAgentMemories(agentId, messageWords, userMessage);

  // Merge cross-agent results (deduplicate by ID); cast to base MemoryEntry for return
  const finalResults: MemoryEntry[] = [...topResults];
  const seenIds = new Set(topResults.map(r => r.id));
  for (const cam of crossAgentMemories) {
    if (!seenIds.has(cam.id)) {
      finalResults.push(cam);
      seenIds.add(cam.id);
    }
  }

  // Update access tracking for returned memories
  await updateAccessTracking(finalResults.map(r => r.id));

  return finalResults;
}

// ---------------------------------------------------------------
// Cross-agent memory fetch (shared/broadcast from cluster peers)
// ---------------------------------------------------------------

async function fetchCrossAgentMemories(
  agentId: string,
  messageWords: string[],
  userMessage: string
): Promise<MemoryEntry[]> {
  const peers = getClusterPeers(agentId);
  if (peers.length === 0) return [];

  try {
    // Fetch broadcast/shared memories from cluster peers that match keywords
    const rows = await query<MemoryEntry>(
      `SELECT id, agent_id, category, content, keywords, importance,
              COALESCE(status, 'active') as status,
              COALESCE(access_count, 0) as access_count,
              last_accessed_at,
              COALESCE(visibility, 'private') as visibility,
              source_agent,
              created_at
       FROM agent_memory
       WHERE agent_id = ANY($1::text[])
         AND COALESCE(status, 'active') = 'active'
         AND COALESCE(visibility, 'private') IN ('broadcast', 'shared')
         AND (
           keywords && $2::text[]
           OR importance = 'critical'
         )
       ORDER BY created_at DESC
       LIMIT 5`,
      [peers, messageWords]
    );

    if (rows.length > 0) {
      console.log(`[AgentMemory] Found ${rows.length} cross-agent memories for ${agentId} from peers`);
    }

    return rows;
  } catch (err) {
    console.warn('[AgentMemory] Cross-agent fetch failed:', (err as Error).message);
    return [];
  }
}

// ---------------------------------------------------------------
// Keyword search (existing logic, enhanced with scoring)
// ---------------------------------------------------------------

async function keywordSearch(
  agentId: string,
  messageWords: string[]
): Promise<(MemoryEntry & { _keywordScore: number; _cosineScore: number })[]> {
  const rows = await query<MemoryEntry & { overlap_count: number }>(
    `SELECT
       id, agent_id, category, content, keywords, importance,
       COALESCE(status, 'active') as status,
       COALESCE(access_count, 0) as access_count,
       last_accessed_at,
       COALESCE(visibility, 'private') as visibility,
       source_agent,
       created_at,
       (SELECT COUNT(*) FROM unnest(keywords) AS kw WHERE kw = ANY($2::text[]))::int AS overlap_count
     FROM agent_memory
     WHERE agent_id = $1
       AND COALESCE(status, 'active') = 'active'
       AND (
         keywords && $2::text[]
         OR (importance IN ('critical', 'high') AND created_at > NOW() - INTERVAL '30 days')
       )
     ORDER BY overlap_count DESC, created_at DESC
     LIMIT 30`,
    [agentId, messageWords]
  );

  // Normalize keyword scores (0-1)
  const maxOverlap = rows.length > 0 ? Math.max(...rows.map(r => r.overlap_count), 1) : 1;

  return rows.map(r => ({
    ...r,
    _keywordScore: r.overlap_count / maxOverlap,
    _cosineScore: 0,
  }));
}

// ---------------------------------------------------------------
// Semantic (pgvector cosine) search
// ---------------------------------------------------------------

async function semanticSearch(
  agentId: string,
  userMessage: string
): Promise<(MemoryEntry & { _keywordScore: number; _cosineScore: number })[]> {
  if (!embeddingConfigured()) return [];

  let queryEmbedding: number[];
  try {
    queryEmbedding = await getEmbedding(userMessage);
  } catch (err) {
    console.warn('[AgentMemory] Query embedding failed, falling back to keyword-only:', (err as Error).message);
    return [];
  }

  if (queryEmbedding.length === 0) return [];

  const pgVec = toPgVector(queryEmbedding);
  if (!pgVec) return [];

  try {
    const rows = await query<MemoryEntry & { cosine_distance: number }>(
      `SELECT
         id, agent_id, category, content, keywords, importance,
         COALESCE(status, 'active') as status,
         COALESCE(access_count, 0) as access_count,
         last_accessed_at,
         COALESCE(visibility, 'private') as visibility,
         source_agent,
         created_at,
         (embedding <=> $2::vector) AS cosine_distance
       FROM agent_memory
       WHERE agent_id = $1
         AND COALESCE(status, 'active') = 'active'
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT 20`,
      [agentId, pgVec]
    );

    return rows.map(r => ({
      ...r,
      _keywordScore: 0,
      _cosineScore: Math.max(0, 1 - r.cosine_distance), // Convert distance to similarity (0-1)
    }));
  } catch (err) {
    console.warn('[AgentMemory] Semantic search failed, falling back to keyword-only:', (err as Error).message);
    return [];
  }
}

// ---------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------

function computeRecencyScore(createdAt: string): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return 1 / (1 + ageDays / 30);
}

function computeImportanceScore(importance: string): number {
  switch (importance) {
    case 'critical': return 1.0;
    case 'high': return 0.75;
    case 'medium': return 0.5;
    case 'low': return 0.25;
    default: return 0.5;
  }
}

// ---------------------------------------------------------------
// Access tracking (update access_count and last_accessed_at)
// ---------------------------------------------------------------

async function updateAccessTracking(memoryIds: number[]): Promise<void> {
  if (memoryIds.length === 0) return;

  try {
    await query(
      `UPDATE agent_memory
       SET access_count = COALESCE(access_count, 0) + 1,
           last_accessed_at = NOW()
       WHERE id = ANY($1::int[])`,
      [memoryIds]
    );
  } catch (err) {
    // Non-critical; log and continue
    console.warn('[AgentMemory] Failed to update access tracking:', (err as Error).message);
  }
}

// ---------------------------------------------------------------
// Get all active memories for an agent (for debugging/display)
// ---------------------------------------------------------------

export async function getAll(agentId: string, limit: number = 50): Promise<MemoryEntry[]> {
  await initialize();
  return query<MemoryEntry>(
    `SELECT id, agent_id, category, content, keywords, importance,
            COALESCE(status, 'active') as status,
            COALESCE(access_count, 0) as access_count,
            last_accessed_at,
            COALESCE(visibility, 'private') as visibility,
            source_agent,
            created_at
     FROM agent_memory
     WHERE agent_id = $1 AND COALESCE(status, 'active') = 'active'
     ORDER BY created_at DESC
     LIMIT $2`,
    [agentId, limit]
  );
}

// ---------------------------------------------------------------
// Delete a specific memory
// ---------------------------------------------------------------

export async function remove(id: number): Promise<void> {
  await initialize();
  await query('DELETE FROM agent_memory WHERE id = $1', [id]);
}

// ---------------------------------------------------------------
// Get memory count for an agent (active only)
// ---------------------------------------------------------------

export async function count(agentId: string): Promise<number> {
  await initialize();
  const row = await queryOne<{ count: string }>(
    'SELECT COUNT(*) FROM agent_memory WHERE agent_id = $1 AND COALESCE(status, \'active\') = \'active\'',
    [agentId]
  );
  return parseInt(row?.count ?? '0', 10);
}

// ---------------------------------------------------------------
// Store a conversation summary (after each agent interaction)
// ---------------------------------------------------------------

// Per-agent importance keyword configuration
const AGENT_IMPORTANCE_KEYWORDS: Record<string, { critical: string[]; high: string[] }> = {
  'legal-advisor': {
    critical: ['court', 'attorney', 'judge', 'violation', 'emergency', 'police', 'threatening'],
    high: ['carrie', 'custody', 'schedule', 'parenting', 'child support', 'theo', 'lyla', 'text', 'email', 'respond', 'reply', 'draft'],
  },
  'wedding-planner': {
    critical: ['contract', 'deadline', 'deposit', 'cancel'],
    high: ['vendor', 'budget', 'jade', 'venue', 'florist', 'caterer', 'photographer', 'dj', 'rsvp', 'guest list'],
  },
  'life-admin': {
    critical: ['overdue', 'final notice', 'collections', 'urgent'],
    high: ['bill', 'payment', 'insurance', 'child support', 'mortgage', 'rent', 'tax', 'medical'],
  },
  'social-media': {
    critical: [],
    high: ['strategy', 'engagement', 'analytics', 'content plan', 'thread', 'viral', 'audience'],
  },
  'research-analyst': {
    critical: [],
    high: ['finding', 'conclusion', 'recommendation', 'competitor', 'market', 'trend', 'data'],
  },
  'comms-drafter': {
    critical: ['legal', 'contract', 'notice'],
    high: ['proposal', 'pitch', 'email', 'letter', 'presentation', 'stakeholder'],
  },
  'ascend-builder': {
    critical: ['launch', 'production', 'outage'],
    high: ['architecture', 'feature', 'roadmap', 'sprint', 'ship protocol', 'design'],
  },
  'gilfoyle': {
    critical: ['deploy', 'production', 'outage', 'security'],
    high: ['bug', 'feature', 'refactor', 'infrastructure', 'database', 'migration', 'docker'],
  },
  'alan-os': {
    critical: ['emergency', 'urgent'],
    high: ['priority', 'important', 'deadline', 'reminder'],
  },
};

export async function storeConversationSummary(
  agentId: string,
  userMessage: string,
  agentResponse: string
): Promise<void> {
  await initialize();

  // Extract meaningful keywords from both messages
  const allText = `${userMessage} ${agentResponse}`;
  const keywords = extractKeywords(allText);

  // Determine importance based on per-agent keywords
  let importance: 'low' | 'medium' | 'high' | 'critical' = 'medium';
  const lowerMsg = userMessage.toLowerCase();
  const agentKeywords = AGENT_IMPORTANCE_KEYWORDS[agentId] ?? AGENT_IMPORTANCE_KEYWORDS['alan-os']!;

  if (agentKeywords.critical.some(kw => lowerMsg.includes(kw))) {
    importance = 'critical';
  } else if (agentKeywords.high.some(kw => lowerMsg.includes(kw))) {
    importance = 'high';
  }

  // Truncate for storage efficiency (keep most relevant parts)
  const summary = `USER: ${userMessage.substring(0, 500)}\nAGENT: ${agentResponse.substring(0, 1000)}`;

  // Categorize the interaction
  let category = 'conversation';
  if (lowerMsg.includes('draft') || lowerMsg.includes('respond') || lowerMsg.includes('reply') || lowerMsg.includes('text')) {
    category = 'communication_draft';
  } else if (lowerMsg.includes('schedule') || lowerMsg.includes('week') || lowerMsg.includes('pickup') || lowerMsg.includes('drop')) {
    category = 'schedule';
  } else if (lowerMsg.includes('support') || lowerMsg.includes('money') || lowerMsg.includes('pay') || lowerMsg.includes('expense')) {
    category = 'financial';
  } else if (lowerMsg.includes('vendor') || lowerMsg.includes('wedding') || lowerMsg.includes('venue')) {
    category = 'wedding';
  } else if (lowerMsg.includes('bug') || lowerMsg.includes('feature') || lowerMsg.includes('code') || lowerMsg.includes('deploy')) {
    category = 'development';
  } else if (lowerMsg.includes('research') || lowerMsg.includes('analysis') || lowerMsg.includes('market')) {
    category = 'research';
  } else if (lowerMsg.includes('carrie') || lowerMsg.includes('she ') || lowerMsg.includes('her ')) {
    category = 'co_parent_issue';
  }

  await store({
    agentId,
    category,
    content: summary,
    keywords,
    importance,
  });
}

// ---------------------------------------------------------------
// Format memories into context string for system prompt injection
// ---------------------------------------------------------------

export function formatMemoriesAsContext(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  const sections: string[] = ['## RELEVANT CONTEXT FROM PREVIOUS CONVERSATIONS\n'];

  for (const mem of memories) {
    const date = new Date(mem.created_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const tag = mem.importance === 'critical' ? ' [IMPORTANT]' : '';
    const via = mem.source_agent && mem.source_agent !== mem.agent_id
      ? ` [via ${mem.source_agent}]`
      : '';
    sections.push(`[${date}]${tag}${via} (${mem.category})\n${mem.content}\n`);
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------
// Keyword extraction (simple but effective)
// ---------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'was', 'be',
  'are', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can',
  'shall', 'not', 'no', 'nor', 'if', 'then', 'than', 'so', 'as', 'up',
  'out', 'about', 'into', 'over', 'after', 'before', 'between', 'each',
  'all', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'too', 'very', 'just', 'because', 'also', 'its', 'my',
  'me', 'we', 'us', 'our', 'your', 'you', 'he', 'she', 'him', 'her',
  'his', 'they', 'them', 'their', 'what', 'which', 'who', 'how', 'when',
  'where', 'why', 'here', 'there', 'i', 'am', 'get', 'got', 'go', 'went',
  'say', 'said', 'one', 'two', 'three', 'still', 'well', 'back', 'even',
  'new', 'want', 'now', 'like', 'make', 'know', 'take', 'come', 'think',
  'see', 'need', 'look', 'give', 'tell', 'help', 'let', 'try', 'ask',
]);

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate
  return [...new Set(words)].slice(0, 30);
}
