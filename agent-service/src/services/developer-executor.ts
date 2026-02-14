import { config } from '../config';

export interface DeveloperResult {
  content: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  numTurns: number;
  model: string;
  filesModified: string[];
}

const BLOCKED_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  'dd if=',
  'mkfs',
  ':(){:|:&};:',
  'chmod -R 777 /',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'docker rm -f',
  'docker system prune -a',
  'git push --force origin main',
  'git push --force origin master',
  'git push -f origin main',
  'git push -f origin master',
  'git reset --hard',
  'git clean -fd',
  'DROP DATABASE',
  'DROP TABLE',
  'TRUNCATE',
];

export async function executeDeveloperTask(
  userMessage: string,
  systemPrompt: string,
  cwd: string
): Promise<DeveloperResult> {
  const startTime = Date.now();

  // Dynamic import for ESM module in CommonJS context
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const filesModified: string[] = [];

  try {
    let finalResult = '';
    let totalCostUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let numTurns = 0;
    let durationMs = 0;
    let model: string = config.DEEP_MODEL;

    const response = query({
      prompt: userMessage,
      options: {
        systemPrompt: systemPrompt,
        cwd,
        model: 'claude-opus-4-20250514',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',
        maxTurns: config.DEV_AGENT_MAX_TURNS,
        maxBudgetUsd: config.DEV_AGENT_MAX_BUDGET_USD,
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          // Block dangerous bash commands
          if (toolName === 'Bash') {
            const cmd = String(input.command ?? '').toLowerCase();
            for (const blocked of BLOCKED_PATTERNS) {
              if (cmd.includes(blocked.toLowerCase())) {
                console.log(`[Gilfoyle] Blocked dangerous command: ${cmd}`);
                return {
                  behavior: 'deny' as const,
                  message: `Blocked dangerous command pattern: ${blocked}`,
                };
              }
            }
          }
          return { behavior: 'allow' as const };
        },
      },
    });

    for await (const message of response) {
      if (message.type === 'assistant') {
        // Track file modifications from tool use
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
              const filePath = block.input?.file_path;
              if (filePath && !filesModified.includes(filePath)) {
                filesModified.push(filePath);
              }
            }
          }
        }
      } else if (message.type === 'result') {
        const result = message as any;
        finalResult = result.result ?? '';
        totalCostUsd = result.total_cost_usd ?? 0;
        inputTokens = result.usage?.input_tokens ?? 0;
        outputTokens = result.usage?.output_tokens ?? 0;
        numTurns = result.num_turns ?? 0;
        durationMs = result.duration_ms ?? (Date.now() - startTime);

        if (result.modelUsage) {
          const models = Object.keys(result.modelUsage);
          if (models.length > 0) model = models[0];
        }

        if (result.is_error) {
          const errors = result.errors ?? ['Unknown error'];
          finalResult = `Developer agent encountered an error: ${errors.join('; ')}`;
        }
      }
    }

    return {
      content: finalResult || 'Developer agent completed without output.',
      totalCostUsd,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      durationMs: durationMs || (Date.now() - startTime),
      numTurns,
      model,
      filesModified,
    };
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.error('[Gilfoyle] Execution error:', errorMsg);

    return {
      content: `Developer agent failed: ${errorMsg}`,
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: Date.now() - startTime,
      numTurns: 0,
      model: config.DEEP_MODEL,
      filesModified,
    };
  }
}
