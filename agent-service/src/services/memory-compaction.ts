/**
 * Memory Compaction Service
 *
 * Periodically reviews each agent's MEMORY.md file:
 * - Removes lowest-scored sections first (importance-aware)
 * - Preserves pinned sections (<!-- pin --> in heading)
 * - Keeps file under the size limit
 * - Logs removed sections to maintenance_log for audit
 *
 * Section scoring:
 *   - Recency: later sections score higher (0-30 pts based on position)
 *   - Category priority: Active Decisions=40, Current Projects=35, etc.
 *   - Pinned: +100 pts (never removed)
 */

import { loadMemory, writeMemory, listAgentsWithSouls } from './memory-files';
import { query } from '../db';

const MAX_MEMORY_CHARS = 3000;

interface CompactionResult {
  agentId: string;
  originalSize: number;
  compactedSize: number;
  wasCompacted: boolean;
  removedSections: string[];
}

// Category priority scoring (matched against section headings)
const CATEGORY_SCORES: Record<string, number> = {
  'active decisions': 40,
  'active decision': 40,
  'decisions': 40,
  'current projects': 35,
  'current project': 35,
  'projects': 35,
  'current state': 30,
  'state': 30,
  'status': 30,
  'pending': 25,
  'pending items': 25,
  'action items': 25,
  'todo': 25,
  'recent context': 20,
  'recent': 20,
  'context': 20,
  'notes': 15,
  'completed': 10,
  'done': 10,
  'historical': 5,
  'archive': 5,
  'history': 5,
};

interface ScoredSection {
  heading: string;
  content: string;
  score: number;
  isPinned: boolean;
  index: number;
}

/**
 * Run compaction across all agents.
 * Uses importance-aware scoring to decide which sections to remove.
 */
export async function compactAllMemories(): Promise<CompactionResult[]> {
  const agents = listAgentsWithSouls();
  const results: CompactionResult[] = [];

  for (const agentId of agents) {
    const memory = loadMemory(agentId);
    const originalSize = memory.length;

    if (originalSize <= MAX_MEMORY_CHARS) {
      results.push({ agentId, originalSize, compactedSize: originalSize, wasCompacted: false, removedSections: [] });
      continue;
    }

    const { compacted, removedSections } = smartTrim(memory, MAX_MEMORY_CHARS);
    writeMemory(agentId, compacted);

    results.push({
      agentId,
      originalSize,
      compactedSize: compacted.length,
      wasCompacted: true,
      removedSections,
    });

    console.log(`[MemoryCompaction] Compacted ${agentId}: ${originalSize} -> ${compacted.length} chars (removed ${removedSections.length} sections)`);

    // Log removed sections for audit
    if (removedSections.length > 0) {
      try {
        await query(
          `INSERT INTO maintenance_log (run_type, details)
           VALUES ('compaction', $1)`,
          [JSON.stringify({ agentId, originalSize, compactedSize: compacted.length, removedSections })]
        );
      } catch {
        // maintenance_log might not exist pre-migration; non-critical
      }
    }
  }

  return results;
}

/**
 * Smart trim: scores sections by importance and removes lowest-scored
 * sections first until under the character limit.
 * Pinned sections (<!-- pin --> in heading) are never removed.
 */
function smartTrim(content: string, maxChars: number): { compacted: string; removedSections: string[] } {
  const lines = content.split('\n');

  // Parse sections (## headers delimit sections)
  const sections: ScoredSection[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];
  let headerLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      // Save previous section
      if (currentHeading || currentLines.length > 0) {
        sections.push(createScoredSection(currentHeading, currentLines.join('\n'), sections.length));
      }
      currentHeading = lines[i];
      currentLines = [lines[i]];
      headerLine = i;
    } else if (i === 0 && lines[i].startsWith('# ')) {
      // Top-level heading (title); always keep
      currentHeading = lines[i];
      currentLines = [lines[i]];
    } else {
      currentLines.push(lines[i]);
    }
  }

  // Save last section
  if (currentHeading || currentLines.length > 0) {
    sections.push(createScoredSection(currentHeading, currentLines.join('\n'), sections.length));
  }

  // If no sections found, just truncate
  if (sections.length === 0) {
    return { compacted: content.substring(content.length - maxChars), removedSections: [] };
  }

  // Assign recency scores (later sections = higher score)
  const totalSections = sections.length;
  for (let i = 0; i < totalSections; i++) {
    const recencyScore = Math.round((i / Math.max(totalSections - 1, 1)) * 30);
    sections[i].score += recencyScore;
  }

  // Sort by score ascending (lowest first = first to remove)
  const sortedByScore = [...sections].sort((a, b) => a.score - b.score);

  // Remove lowest-scored sections until under limit
  const removedIndices = new Set<number>();
  const removedSections: string[] = [];

  let currentSize = content.length;

  for (const section of sortedByScore) {
    if (currentSize <= maxChars) break;
    if (section.isPinned) continue; // Never remove pinned sections

    removedIndices.add(section.index);
    removedSections.push(section.heading || '(untitled section)');
    currentSize -= section.content.length;
  }

  // Rebuild content without removed sections
  const kept = sections
    .filter(s => !removedIndices.has(s.index))
    .map(s => s.content);

  const compacted = kept.join('\n').trim();

  return { compacted, removedSections };
}

/**
 * Create a scored section from heading and content.
 */
function createScoredSection(heading: string, content: string, index: number): ScoredSection {
  const isPinned = heading.includes('<!-- pin -->');
  let score = isPinned ? 100 : 0;

  // Match heading against category priorities
  const headingLower = heading.replace(/^#+\s*/, '').toLowerCase().trim();
  for (const [keyword, points] of Object.entries(CATEGORY_SCORES)) {
    if (headingLower.includes(keyword)) {
      score += points;
      break;
    }
  }

  // Title section (# heading at top) always gets high score
  if (heading.startsWith('# ') && !heading.startsWith('## ')) {
    score += 50;
  }

  return { heading: heading.trim(), content, score, isPinned, index };
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
    `- ${r.agentId}: ${r.originalSize} -> ${r.compactedSize} chars (removed: ${r.removedSections.join(', ') || 'none'})`
  );

  return `Memory compaction: ${compacted.length} agents trimmed.\n${lines.join('\n')}`;
}
