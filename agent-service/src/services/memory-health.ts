/**
 * Memory Health Dashboard
 *
 * Provides a comprehensive health report for the memory system.
 * Queries run in parallel for performance.
 * Exposed via GET /memory/health on the webhook server.
 */

import { query, queryOne } from '../db';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface MemoryHealthReport {
  overview: {
    total: number;
    active: number;
    archived: number;
    contradicted: number;
    embeddingCoverage: number; // percentage (0-100)
  };
  perAgent: Array<{
    agent_id: string;
    total: number;
    active: number;
    archived: number;
    avgAccessCount: number;
  }>;
  perCategory: Array<{
    category: string;
    count: number;
  }>;
  staleness: {
    staleCount: number; // active, 0 accesses, >90 days old
    conflictRate: number; // contradicted / total
  };
  maintenance: {
    lastRun: string | null;
    lastConflict: string | null;
    totalMaintenanceRuns: number;
  };
  generatedAt: string;
}

// ---------------------------------------------------------------
// Generate health report
// ---------------------------------------------------------------

export async function getMemoryHealth(): Promise<MemoryHealthReport> {
  // Run all queries in parallel
  const [
    overviewResult,
    embeddingResult,
    perAgentResult,
    perCategoryResult,
    staleResult,
    lastMaintenanceResult,
    maintenanceCountResult,
    lastConflictResult,
  ] = await Promise.all([
    // Overview counts
    query<{ status: string; count: string }>(
      `SELECT COALESCE(status, 'active') as status, COUNT(*) as count
       FROM agent_memory
       GROUP BY COALESCE(status, 'active')`
    ),

    // Embedding coverage
    query<{ has_embedding: boolean; count: string }>(
      `SELECT (embedding IS NOT NULL) as has_embedding, COUNT(*) as count
       FROM agent_memory
       GROUP BY (embedding IS NOT NULL)`
    ),

    // Per-agent breakdown
    query<{ agent_id: string; total: string; active: string; archived: string; avg_access: string }>(
      `SELECT
         agent_id,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE COALESCE(status, 'active') = 'active') as active,
         COUNT(*) FILTER (WHERE COALESCE(status, 'active') = 'archived') as archived,
         ROUND(AVG(COALESCE(access_count, 0)), 1) as avg_access
       FROM agent_memory
       GROUP BY agent_id
       ORDER BY total DESC`
    ),

    // Per-category breakdown
    query<{ category: string; count: string }>(
      `SELECT category, COUNT(*) as count
       FROM agent_memory
       WHERE COALESCE(status, 'active') = 'active'
       GROUP BY category
       ORDER BY count DESC`
    ),

    // Stale count (active, 0 accesses, >90 days old)
    queryOne<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM agent_memory
       WHERE COALESCE(status, 'active') = 'active'
         AND COALESCE(access_count, 0) = 0
         AND created_at < NOW() - INTERVAL '90 days'`
    ),

    // Last maintenance run
    queryOne<{ created_at: string }>(
      `SELECT created_at FROM maintenance_log ORDER BY created_at DESC LIMIT 1`
    ),

    // Total maintenance runs
    queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM maintenance_log`
    ),

    // Last conflict
    queryOne<{ created_at: string }>(
      `SELECT created_at FROM memory_conflicts ORDER BY created_at DESC LIMIT 1`
    ),
  ]);

  // Parse overview
  let total = 0;
  let active = 0;
  let archived = 0;
  let contradicted = 0;

  for (const row of overviewResult) {
    const count = parseInt(row.count, 10);
    total += count;
    if (row.status === 'active') active = count;
    else if (row.status === 'archived') archived = count;
    else if (row.status === 'contradicted') contradicted = count;
  }

  // Parse embedding coverage
  let withEmbedding = 0;
  let totalForEmbedding = 0;
  for (const row of embeddingResult) {
    const count = parseInt(row.count, 10);
    totalForEmbedding += count;
    if (row.has_embedding) withEmbedding = count;
  }
  const embeddingCoverage = totalForEmbedding > 0
    ? Math.round((withEmbedding / totalForEmbedding) * 100)
    : 0;

  return {
    overview: { total, active, archived, contradicted, embeddingCoverage },
    perAgent: perAgentResult.map(r => ({
      agent_id: r.agent_id,
      total: parseInt(r.total, 10),
      active: parseInt(r.active, 10),
      archived: parseInt(r.archived, 10),
      avgAccessCount: parseFloat(r.avg_access) || 0,
    })),
    perCategory: perCategoryResult.map(r => ({
      category: r.category,
      count: parseInt(r.count, 10),
    })),
    staleness: {
      staleCount: parseInt(staleResult?.count ?? '0', 10),
      conflictRate: total > 0 ? Math.round((contradicted / total) * 1000) / 10 : 0,
    },
    maintenance: {
      lastRun: lastMaintenanceResult?.created_at ?? null,
      lastConflict: lastConflictResult?.created_at ?? null,
      totalMaintenanceRuns: parseInt(maintenanceCountResult?.count ?? '0', 10),
    },
    generatedAt: new Date().toISOString(),
  };
}
