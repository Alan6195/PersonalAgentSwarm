export const config = {
  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_ALLOWED_USER_ID: parseInt(process.env.TELEGRAM_ALLOWED_USER_ID || '0', 10),

  // Database
  DATABASE_URL: process.env.DATABASE_URL || '',

  // Anthropic
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',

  // X/Twitter (optional; features disabled if not set)
  X_API_KEY: process.env.X_API_KEY || '',
  X_API_SECRET: process.env.X_API_SECRET || '',
  X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN || '',
  X_ACCESS_SECRET: process.env.X_ACCESS_SECRET || '',

  // Microsoft Graph (Outlook email)
  MS_CLIENT_ID: process.env.MS_CLIENT_ID || '',
  MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET || '',
  MS_REFRESH_TOKEN: process.env.MS_REFRESH_TOKEN || '',

  // Atlas Cloud (image/video generation)
  ATLAS_CLOUD_API_KEY: process.env.ATLAS_CLOUD_API_KEY || '',

  // Webhook server
  WEBHOOK_PORT: parseInt(process.env.WEBHOOK_PORT || '3001', 10),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',

  // Developer agent config
  DEV_AGENT_CWD: process.env.DEV_AGENT_CWD || '/opt/mission-control',
  DEV_AGENT_MAX_TURNS: parseInt(process.env.DEV_AGENT_MAX_TURNS || '30', 10),
  DEV_AGENT_MAX_BUDGET_USD: parseFloat(process.env.DEV_AGENT_MAX_BUDGET_USD || '5.00'),

  // Model config
  ROUTER_MODEL: 'claude-sonnet-4-20250514',
  DEEP_MODEL: 'claude-opus-4-20250514',

  // Cost per 1M tokens (in cents)
  MODEL_PRICING: {
    'claude-sonnet-4-20250514': { input: 300, output: 1500 },
    'claude-opus-4-20250514': { input: 1500, output: 7500 },
    'claude-haiku-3-20240307': { input: 25, output: 125 },
  } as Record<string, { input: number; output: number }>,
} as const;

export function validateConfig(): void {
  const required = [
    ['TELEGRAM_BOT_TOKEN', config.TELEGRAM_BOT_TOKEN],
    ['TELEGRAM_ALLOWED_USER_ID', config.TELEGRAM_ALLOWED_USER_ID],
    ['DATABASE_URL', config.DATABASE_URL],
    ['ANTHROPIC_API_KEY', config.ANTHROPIC_API_KEY],
  ] as const;

  for (const [name, value] of required) {
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }

  // X/Twitter keys are optional; just log their status
  if (config.X_API_KEY && config.X_API_SECRET && config.X_ACCESS_TOKEN && config.X_ACCESS_SECRET) {
    console.log('[Config] X/Twitter API credentials found.');
  } else {
    console.log('[Config] X/Twitter API credentials not set; X features disabled.');
  }

  if (config.MS_CLIENT_ID && config.MS_REFRESH_TOKEN) {
    console.log('[Config] Microsoft Graph credentials found; Outlook email features enabled.');
  } else {
    console.log('[Config] Microsoft Graph credentials not set; email features disabled.');
  }

  if (config.ATLAS_CLOUD_API_KEY) {
    console.log('[Config] Atlas Cloud API key found; image/video generation enabled.');
  } else {
    console.log('[Config] ATLAS_CLOUD_API_KEY not set; image/video generation disabled.');
  }

  if (config.WEBHOOK_SECRET) {
    console.log(`[Config] Webhook server: port=${config.WEBHOOK_PORT}, secret configured.`);
  } else {
    console.log('[Config] WEBHOOK_SECRET not set; webhook endpoint will reject all requests.');
  }

  console.log(`[Config] Developer agent: cwd=${config.DEV_AGENT_CWD}, maxTurns=${config.DEV_AGENT_MAX_TURNS}, maxBudget=$${config.DEV_AGENT_MAX_BUDGET_USD}`);
  console.log('[Config] All environment variables validated.');
}

export function getModelCategory(model: string): 'opus' | 'sonnet' | 'haiku' {
  if (model.includes('opus')) return 'opus';
  if (model.includes('haiku')) return 'haiku';
  return 'sonnet';
}
