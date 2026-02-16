/**
 * Two-Tier Memory: File-based always-on context (Tier 1)
 *
 * Tier 1: SOUL.md (agent identity, loaded every message) + MEMORY.md (working state, loaded every message)
 * Tier 2: agent_memory table (historical keyword-matched recall, loaded on demand) -- handled by agent-memory.ts
 *
 * SOUL.md files live in agent-service/data/souls/<agent-id>.md
 * MEMORY.md files live in agent-service/data/memory/<agent-id>.md
 *
 * SOUL files are read-only at runtime (edited by Gilfoyle or manually).
 * MEMORY files are read/write: agents update their own via [MEMORY_UPDATE] blocks.
 */

import * as fs from 'fs';
import * as path from 'path';

// Resolve paths relative to the agent-service root (one level up from src/)
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const SOULS_DIR = path.join(DATA_DIR, 'souls');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');

// Max MEMORY.md size in characters (~500 words)
const MAX_MEMORY_SIZE = 3000;

// ---------------------------------------------------------------
// Initialization: ensure directories exist
// ---------------------------------------------------------------

function ensureDirs(): void {
  if (!fs.existsSync(SOULS_DIR)) {
    fs.mkdirSync(SOULS_DIR, { recursive: true });
  }
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------
// SOUL.md: Agent identity (read-only at runtime)
// ---------------------------------------------------------------

/**
 * Load the SOUL.md file for an agent. Returns the full prompt string.
 * Falls back to empty string if the file doesn't exist.
 */
export function loadSoul(agentId: string): string {
  ensureDirs();
  const filePath = path.join(SOULS_DIR, `${agentId}.md`);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    console.warn(`[MemoryFiles] No SOUL.md found for ${agentId} at ${filePath}`);
    return '';
  }
}

/**
 * Check if a SOUL.md file exists for an agent.
 */
export function hasSoul(agentId: string): boolean {
  const filePath = path.join(SOULS_DIR, `${agentId}.md`);
  return fs.existsSync(filePath);
}

// ---------------------------------------------------------------
// MEMORY.md: Working memory (read/write at runtime)
// ---------------------------------------------------------------

/**
 * Load the MEMORY.md file for an agent. Returns the working memory string.
 * Returns empty string if file doesn't exist.
 */
export function loadMemory(agentId: string): string {
  ensureDirs();
  const filePath = path.join(MEMORY_DIR, `${agentId}.md`);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write updated working memory for an agent. Overwrites the entire MEMORY.md file.
 * Enforces MAX_MEMORY_SIZE to prevent unbounded growth.
 */
export function writeMemory(agentId: string, content: string): void {
  ensureDirs();
  const filePath = path.join(MEMORY_DIR, `${agentId}.md`);

  // Enforce size limit
  let trimmed = content.trim();
  if (trimmed.length > MAX_MEMORY_SIZE) {
    console.warn(`[MemoryFiles] MEMORY.md for ${agentId} exceeds ${MAX_MEMORY_SIZE} chars (${trimmed.length}), truncating`);
    trimmed = trimmed.substring(0, MAX_MEMORY_SIZE);
  }

  fs.writeFileSync(filePath, trimmed, 'utf-8');
  console.log(`[MemoryFiles] Updated MEMORY.md for ${agentId} (${trimmed.length} chars)`);
}

// ---------------------------------------------------------------
// Parse [MEMORY_UPDATE] blocks from agent responses
// ---------------------------------------------------------------

const MEMORY_UPDATE_REGEX = /\[MEMORY_UPDATE\]([\s\S]*?)\[\/MEMORY_UPDATE\]/g;

/**
 * Extract [MEMORY_UPDATE] blocks from an agent's response.
 * Returns the content of the last block (if multiple exist, last wins).
 * Returns null if no block found.
 */
export function extractMemoryUpdate(response: string): string | null {
  let lastMatch: string | null = null;
  let match: RegExpExecArray | null;

  // Reset regex state
  MEMORY_UPDATE_REGEX.lastIndex = 0;

  while ((match = MEMORY_UPDATE_REGEX.exec(response)) !== null) {
    lastMatch = match[1].trim();
  }

  return lastMatch;
}

/**
 * Process [MEMORY_UPDATE] blocks: extract, write to disk, strip from response.
 * Returns the cleaned response (with blocks removed) and whether an update occurred.
 */
export function processMemoryUpdate(
  agentId: string,
  response: string
): { result: string; updated: boolean } {
  const memoryContent = extractMemoryUpdate(response);

  if (!memoryContent) {
    return { result: response, updated: false };
  }

  // Write the update to disk
  writeMemory(agentId, memoryContent);

  // Strip [MEMORY_UPDATE] blocks from the response (don't show to user)
  const cleaned = response.replace(MEMORY_UPDATE_REGEX, '').trim();

  return { result: cleaned, updated: true };
}

// ---------------------------------------------------------------
// Build always-on context string for injection into executor
// ---------------------------------------------------------------

/**
 * Build the full Tier 1 context: SOUL.md + MEMORY.md formatted for prompt injection.
 * Returns the combined string to use as the agent's system prompt base.
 */
export function buildTier1Context(agentId: string): { soul: string; memory: string } {
  const soul = loadSoul(agentId);
  const memory = loadMemory(agentId);

  return { soul, memory };
}

/**
 * Format the working memory for injection into the prompt.
 * Only returns content if the memory file has meaningful data.
 */
export function formatMemoryForPrompt(memory: string): string {
  if (!memory || memory.trim().length === 0) return '';

  return `\n\n## WORKING MEMORY (your current state, loaded automatically)\n\n${memory.trim()}`;
}

// ---------------------------------------------------------------
// Utility: list all agents with SOUL files
// ---------------------------------------------------------------

export function listAgentsWithSouls(): string[] {
  ensureDirs();
  try {
    return fs.readdirSync(SOULS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// Utility: get paths (for debugging/Gilfoyle access)
// ---------------------------------------------------------------

export function getSoulPath(agentId: string): string {
  return path.join(SOULS_DIR, `${agentId}.md`);
}

export function getMemoryPath(agentId: string): string {
  return path.join(MEMORY_DIR, `${agentId}.md`);
}

export { SOULS_DIR, MEMORY_DIR };
