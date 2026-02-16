import { config } from '../config';
import { AgentDefinition } from './types';
import { loadSoul, hasSoul } from '../services/memory-files';

// Legacy .ts prompt imports (fallback if no SOUL.md file exists)
import { alanOsPrompt } from './prompts/alan-os';
import { ascendBuilderPrompt } from './prompts/ascend-builder';
import { legalAdvisorPrompt } from './prompts/legal-advisor';
import { socialMediaPrompt } from './prompts/social-media';
import { weddingPlannerPrompt } from './prompts/wedding-planner';
import { lifeAdminPrompt } from './prompts/life-admin';
import { researchAnalystPrompt } from './prompts/research-analyst';
import { commsDrafterPrompt } from './prompts/comms-drafter';
import { gilfoylePrompt } from './prompts/gilfoyle';
import { travelAgentPrompt } from './prompts/travel-agent';

// Fallback prompts from .ts files (used only if SOUL.md doesn't exist)
const fallbackPrompts: Record<string, string> = {
  'alan-os': alanOsPrompt,
  'ascend-builder': ascendBuilderPrompt,
  'legal-advisor': legalAdvisorPrompt,
  'social-media': socialMediaPrompt,
  'wedding-planner': weddingPlannerPrompt,
  'life-admin': lifeAdminPrompt,
  'research-analyst': researchAnalystPrompt,
  'comms-drafter': commsDrafterPrompt,
  'gilfoyle': gilfoylePrompt,
  'travel-agent': travelAgentPrompt,
};

// Model assignments per agent
const agentModels: Record<string, string> = {
  'alan-os': config.DEEP_MODEL,
  'ascend-builder': config.DEEP_MODEL,
  'legal-advisor': config.DEEP_MODEL,
  'social-media': config.ROUTER_MODEL,
  'wedding-planner': config.ROUTER_MODEL,
  'life-admin': config.ROUTER_MODEL,
  'research-analyst': config.DEEP_MODEL,
  'comms-drafter': config.ROUTER_MODEL,
  'gilfoyle': config.DEEP_MODEL,
  'travel-agent': config.DEEP_MODEL,
};

/**
 * Get the prompt for an agent. Reads from SOUL.md on disk (hot-reloadable),
 * falling back to the compiled .ts export if no .md file exists.
 */
export function getPrompt(agentId: string): string {
  if (!agentModels[agentId]) throw new Error(`Unknown agent: ${agentId}`);

  // Tier 1: load from SOUL.md on disk (hot-reloadable, Gilfoyle-editable)
  if (hasSoul(agentId)) {
    const soul = loadSoul(agentId);
    if (soul.length > 0) return soul;
  }

  // Fallback: compiled .ts prompt
  const fallback = fallbackPrompts[agentId];
  if (fallback) return fallback;

  throw new Error(`No prompt found for agent: ${agentId}`);
}

export function getModel(agentId: string): string {
  const model = agentModels[agentId];
  if (!model) throw new Error(`Unknown agent: ${agentId}`);
  return model;
}

export function getAllAgentIds(): string[] {
  return Object.keys(agentModels);
}
