/**
 * Memory Compaction Service
 *
 * Periodically reviews each agent's MEMORY.md file:
 * - Removes stale/resolved items
 * - Keeps file under the size limit
 * - Can be triggered by cron or manually
 *
 * This is a lightweight cleanup pass, not a full rewrite.
 * Agents are responsible for keeping their own MEMORY.md current
 * via [MEMORY_UPDATE] blocks. This service is a safety net.
 */

import { loadMemory, writeMemory, listAgentsWithSouls } from './memory-files';

const MAX_MEMORY_AGE_DAYS = 30;
const MAX_MEMORY_CHARS = 3000;

interface CompactionResult {
  agentId: string;
  originalSize: number;
  compactedSize: number;
  wasCompacted: boolean;
}

/**
 * Run compaction across all agents.
 * Simple approach: if a MEMORY.md is over the char limit, trim from the top
 * (oldest items are typically at the top of the file).
 *
 * For a smarter approach, this could call Claude to summarize,
 * but that adds cost. The simple trim is sufficient as a safety net
 * since agents manage their own memory via [MEMORY_UPDATE].
 */
export async function compactAllMemories(): Promise<CompactionResult[]> {
  const agents = listAgentsWithSouls();
  const results: CompactionResult[] = [];

  for (const agentId of agents) {
    const memory = loadMemory(agentId);
    const originalSize = memory.length;

    if (originalSize <= MAX_MEMORY_CHARS) {
      results.push({ agentId, originalSize, compactedSize: originalSize, wasCompacted: false });
      continue;
    }

    // Simple compaction: keep only the content from the last section headers
    // This preserves the most recent structured data
    const compacted = smartTrim(memory, MAX_MEMORY_CHARS);
    writeMemory(agentId, compacted);

    results.push({
      agentId,
      originalSize,
      compactedSize: compacted.length,
      wasCompacted: true,
    });

    console.log(`[MemoryCompaction] Compacted ${agentId}: ${originalSize} -> ${compacted.length} chars`);
  }

  return results;
}

/**
 * Smart trim: preserves markdown structure by keeping complete sections.
 * Removes earliest sections first until under the limit.
 */
function smartTrim(content: string, maxChars: number): string {
  const lines = content.split('\n');

  // Find section boundaries (## headers)
  const sectionStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      sectionStarts.push(i);
    }
  }

  // If no sections, just truncate from the top
  if (sectionStarts.length === 0) {
    return content.substring(content.length - maxChars);
  }

  // Try removing sections from the top until we're under the limit
  for (let skipSections = 1; skipSections < sectionStarts.length; skipSections++) {
    const startLine = sectionStarts[skipSections];
    const remaining = lines.slice(startLine).join('\n');
    if (remaining.length <= maxChars) {
      return remaining;
    }
  }

  // If still over limit, just take the last section
  const lastSection = lines.slice(sectionStarts[sectionStarts.length - 1]).join('\n');
  return lastSection.substring(0, maxChars);
}

/**
 * Format compaction results for logging/Telegram notification.
 */
export function formatCompactionReport(results: CompactionResult[]): string {
  const compacted = results.filter(r => r.wasCompacted);
  if (compacted.length === 0) {
    return 'Memory compaction: all agents within limits, no changes needed.';
  }

  const lines = compacted.map(r =>
    `- ${r.agentId}: ${r.originalSize} -> ${r.compactedSize} chars`
  );

  return `Memory compaction: ${compacted.length} agents trimmed.\n${lines.join('\n')}`;
}
