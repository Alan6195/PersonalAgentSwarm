/**
 * Persistent semantic memory for agents.
 *
 * Stores conversation summaries, key facts, and context in PostgreSQL.
 * Each memory entry has an agent_id, category, content, and keywords
 * for retrieval. Uses keyword-based search (no embeddings needed).
 *
 * Designed primarily for the legal-advisor agent but works for any agent.
 */

import { query, queryOne } from '../db';

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
  created_at: string;
}

export interface StoreMemoryParams {
  agentId: string;
  category: string;
  content: string;
  keywords: string[];
  importance?: 'low' | 'medium' | 'high' | 'critical';
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
// Store a memory
// ---------------------------------------------------------------

export async function store(params: StoreMemoryParams): Promise<number> {
  await initialize();

  const rows = await query<{ id: number }>(
    `INSERT INTO agent_memory (agent_id, category, content, keywords, importance)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      params.agentId,
      params.category,
      params.content,
      params.keywords,
      params.importance ?? 'medium',
    ]
  );

  console.log(`[AgentMemory] Stored memory #${rows[0].id} for ${params.agentId} (${params.category})`);
  return rows[0].id;
}

// ---------------------------------------------------------------
// Retrieve relevant memories for a given message
// ---------------------------------------------------------------

export async function recall(
  agentId: string,
  userMessage: string,
  limit: number = 10
): Promise<MemoryEntry[]> {
  await initialize();

  // Extract keywords from the user message for matching
  const messageWords = extractKeywords(userMessage);

  if (messageWords.length === 0) {
    // Fallback: return most recent important memories
    return query<MemoryEntry>(
      `SELECT id, agent_id, category, content, keywords, importance, created_at
       FROM agent_memory
       WHERE agent_id = $1
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
  }

  // Score memories by keyword overlap + importance + recency
  const rows = await query<MemoryEntry & { relevance: number }>(
    `SELECT
       id, agent_id, category, content, keywords, importance, created_at,
       (
         -- Keyword overlap score (how many of the message words appear in the memory keywords)
         (SELECT COUNT(*) FROM unnest(keywords) AS kw WHERE kw = ANY($2::text[]))::float
         -- Importance multiplier
         * CASE importance
             WHEN 'critical' THEN 4.0
             WHEN 'high' THEN 2.0
             WHEN 'medium' THEN 1.0
             WHEN 'low' THEN 0.5
           END
         -- Recency boost (memories from last 7 days get a boost)
         * CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1.5 ELSE 1.0 END
       ) AS relevance
     FROM agent_memory
     WHERE agent_id = $1
       AND (
         -- Match any keyword
         keywords && $2::text[]
         -- Or match important recent memories regardless of keywords
         OR (importance IN ('critical', 'high') AND created_at > NOW() - INTERVAL '30 days')
       )
     ORDER BY relevance DESC, created_at DESC
     LIMIT $3`,
    [agentId, messageWords, limit]
  );

  return rows;
}

// ---------------------------------------------------------------
// Get all memories for an agent (for debugging/display)
// ---------------------------------------------------------------

export async function getAll(agentId: string, limit: number = 50): Promise<MemoryEntry[]> {
  await initialize();
  return query<MemoryEntry>(
    `SELECT id, agent_id, category, content, keywords, importance, created_at
     FROM agent_memory
     WHERE agent_id = $1
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
// Get memory count for an agent
// ---------------------------------------------------------------

export async function count(agentId: string): Promise<number> {
  await initialize();
  const row = await queryOne<{ count: string }>('SELECT COUNT(*) FROM agent_memory WHERE agent_id = $1', [agentId]);
  return parseInt(row?.count ?? '0', 10);
}

// ---------------------------------------------------------------
// Store a conversation summary (after each legal agent interaction)
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
    sections.push(`[${date}]${tag} (${mem.category})\n${mem.content}\n`);
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
