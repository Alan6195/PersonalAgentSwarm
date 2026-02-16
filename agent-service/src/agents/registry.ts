import { config } from '../config';
import { AgentDefinition } from './types';
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

const agents: Record<string, AgentDefinition> = {
  'alan-os':          { prompt: alanOsPrompt,          model: config.DEEP_MODEL },
  'ascend-builder':   { prompt: ascendBuilderPrompt,   model: config.DEEP_MODEL },
  'legal-advisor':    { prompt: legalAdvisorPrompt,     model: config.DEEP_MODEL },
  'social-media':     { prompt: socialMediaPrompt,      model: config.ROUTER_MODEL },
  'wedding-planner':  { prompt: weddingPlannerPrompt,   model: config.ROUTER_MODEL },
  'life-admin':       { prompt: lifeAdminPrompt,        model: config.ROUTER_MODEL },
  'research-analyst': { prompt: researchAnalystPrompt,  model: config.DEEP_MODEL },
  'comms-drafter':    { prompt: commsDrafterPrompt,     model: config.ROUTER_MODEL },
  'gilfoyle':         { prompt: gilfoylePrompt,          model: config.DEEP_MODEL },
  'travel-agent':     { prompt: travelAgentPrompt,       model: config.DEEP_MODEL },
};

export function getPrompt(agentId: string): string {
  const agent = agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  return agent.prompt;
}

export function getModel(agentId: string): string {
  const agent = agents[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  return agent.model;
}

export function getAllAgentIds(): string[] {
  return Object.keys(agents);
}
