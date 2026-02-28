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

  // Gmail (Wedding email)
  GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID || '',
  GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET || '',
  GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN || '',

  // Atlas Cloud (image/video generation)
  ATLAS_CLOUD_API_KEY: process.env.ATLAS_CLOUD_API_KEY || '',

  // Webhook server
  WEBHOOK_PORT: parseInt(process.env.WEBHOOK_PORT || '3001', 10),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',

  // Developer agent config
  DEV_AGENT_CWD: process.env.DEV_AGENT_CWD || '/opt/mission-control',
  DEV_AGENT_MAX_TURNS: parseInt(process.env.DEV_AGENT_MAX_TURNS || '30', 10),
  DEV_AGENT_MAX_BUDGET_USD: parseFloat(process.env.DEV_AGENT_MAX_BUDGET_USD || '5.00'),

  // Ship mode (autonomous overnight builds)
  DEV_AGENT_SHIP_MAX_TURNS: parseInt(process.env.DEV_AGENT_SHIP_MAX_TURNS || '100', 10),
  DEV_AGENT_SHIP_MAX_BUDGET_USD: parseFloat(process.env.DEV_AGENT_SHIP_MAX_BUDGET_USD || '25.00'),

  // OpenAI (embeddings for memory system)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMS: 1536,

  // SerpAPI (Google Search, Hotels, Flights, Maps)
  SERPAPI_KEY: process.env.SERPAPI_KEY || '',

  // Google Calendar
  GOOGLE_CALENDAR_CLIENT_ID: process.env.GOOGLE_CALENDAR_CLIENT_ID || '',
  GOOGLE_CALENDAR_CLIENT_SECRET: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '',
  GOOGLE_CALENDAR_REFRESH_TOKEN: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || '',
  GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID || 'primary',

  // Cost guardrails
  DAILY_BUDGET_LIMIT_CENTS: parseInt(process.env.DAILY_BUDGET_LIMIT_CENTS || '5000', 10),
  AGENT_DAILY_LIMIT_CENTS: parseInt(process.env.AGENT_DAILY_LIMIT_CENTS || '1000', 10),

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

  if (config.GMAIL_CLIENT_ID && config.GMAIL_REFRESH_TOKEN) {
    console.log('[Config] Gmail credentials found; wedding email features enabled.');
  } else {
    console.log('[Config] Gmail credentials not set; wedding email features disabled.');
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
  console.log(`[Config] Ship mode: maxTurns=${config.DEV_AGENT_SHIP_MAX_TURNS}, maxBudget=$${config.DEV_AGENT_SHIP_MAX_BUDGET_USD}`);

  if (config.OPENAI_API_KEY) {
    console.log('[Config] OpenAI API key found; semantic memory embeddings enabled.');
  } else {
    console.log('[Config] OPENAI_API_KEY not set; memory system will use keyword-only recall.');
  }

  if (config.SERPAPI_KEY) {
    console.log('[Config] SerpAPI configured; web search, hotels, flights, maps enabled.');
  } else {
    console.log('[Config] SERPAPI_KEY not set; web search disabled.');
  }

  if (config.GOOGLE_CALENDAR_CLIENT_ID && config.GOOGLE_CALENDAR_REFRESH_TOKEN) {
    console.log('[Config] Google Calendar credentials found; calendar features enabled.');
  } else {
    console.log('[Config] Google Calendar credentials not set; calendar features disabled.');
  }

  console.log(`[Config] Cost guardrails: daily=$${(config.DAILY_BUDGET_LIMIT_CENTS / 100).toFixed(2)}, per-agent=$${(config.AGENT_DAILY_LIMIT_CENTS / 100).toFixed(2)}`);
  console.log('[Config] All environment variables validated.');
}

export function getModelCategory(model: string): 'opus' | 'sonnet' | 'haiku' {
  if (model.includes('opus')) return 'opus';
  if (model.includes('haiku')) return 'haiku';
  return 'sonnet';
}
