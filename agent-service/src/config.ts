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

  // Runway (video generation via Gen 4.5)
  RUNWAY_API_KEY: process.env.RUNWAY_API_KEY || '',

  // Predict Agent (prediction market trading)
  MANIFOLD_API_KEY: process.env.MANIFOLD_API_KEY || '',
  POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY || '',
  POLYMARKET_API_SECRET: process.env.POLYMARKET_API_SECRET || '',
  POLYMARKET_API_PASSPHRASE: process.env.POLYMARKET_API_PASSPHRASE || '',
  POLYMARKET_WALLET_KEY: process.env.POLYMARKET_WALLET_KEY || '',
  POLYMARKET_WALLET_ADDRESS: process.env.POLYMARKET_WALLET_ADDRESS || '',
  POLYGON_RPC_URL: process.env.POLYGON_RPC_URL || '',
  USDC_CONTRACT: process.env.USDC_CONTRACT || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  PREDICT_PHASE: parseInt(process.env.PREDICT_PHASE || '1', 10),

  // Predict: model strings (no inline model strings anywhere else)
  PREDICT_SCAN_MODEL: 'claude-sonnet-4-20250514',
  PREDICT_REVIEWER_MODEL: 'claude-haiku-4-5-20251001',

  // Predict: scan filter thresholds (env-driven, tunable without rebuild)
  PREDICT_SCAN_MIN_TRADERS: parseInt(process.env.PREDICT_SCAN_MIN_TRADERS || '10', 10),
  PREDICT_SCAN_MIN_PRICE: parseFloat(process.env.PREDICT_SCAN_MIN_PRICE || '0.10'),
  PREDICT_SCAN_MAX_PRICE: parseFloat(process.env.PREDICT_SCAN_MAX_PRICE || '0.90'),
  PREDICT_SCAN_MIN_DAYS: parseInt(process.env.PREDICT_SCAN_MIN_DAYS || '1', 10),
  PREDICT_SCAN_MAX_DAYS: parseInt(process.env.PREDICT_SCAN_MAX_DAYS || '60', 10),

  // Predict: Polymarket config
  PREDICT_POLY_DRY_RUN: (process.env.PREDICT_POLY_DRY_RUN || 'true') === 'true',
  PREDICT_POLY_STARTING_BANKROLL: parseFloat(process.env.PREDICT_POLY_STARTING_BANKROLL || '50'),
  PREDICT_POLY_KELLY_FRACTION: parseFloat(process.env.PREDICT_POLY_KELLY_FRACTION || '0.15'),
  PREDICT_POLY_LMSR_B: parseFloat(process.env.PREDICT_POLY_LMSR_B || '3000'),

  // Unsplash (stock photos for authentic visual content)
  UNSPLASH_ACCESS_KEY: process.env.UNSPLASH_ACCESS_KEY || '',

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
    'claude-haiku-4-5-20251001': { input: 80, output: 400 },
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

  if (config.RUNWAY_API_KEY) {
    console.log('[Config] Runway API key found; video generation enabled (Gen 4.5).');
  } else {
    console.log('[Config] RUNWAY_API_KEY not set; video generation disabled.');
  }

  if (config.UNSPLASH_ACCESS_KEY) {
    console.log('[Config] Unsplash API key found; stock photo search enabled.');
  } else {
    console.log('[Config] UNSPLASH_ACCESS_KEY not set; stock photo search disabled.');
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

  // Predict Agent
  if (config.MANIFOLD_API_KEY) {
    console.log(`[Config] Manifold API key found; predict agent Phase ${config.PREDICT_PHASE} enabled.`);
    console.log(`[Config] Predict scan: model=${config.PREDICT_SCAN_MODEL}, reviewer=${config.PREDICT_REVIEWER_MODEL}`);
    console.log(`[Config] Predict filters: traders>=${config.PREDICT_SCAN_MIN_TRADERS}, price=${config.PREDICT_SCAN_MIN_PRICE}-${config.PREDICT_SCAN_MAX_PRICE}, days=${config.PREDICT_SCAN_MIN_DAYS}-${config.PREDICT_SCAN_MAX_DAYS}`);
  } else {
    console.log('[Config] MANIFOLD_API_KEY not set; predict agent disabled.');
  }

  if (config.POLYMARKET_API_KEY) {
    const hasWallet = !!(config.POLYMARKET_WALLET_KEY);
    const hasL2 = !!(config.POLYMARKET_API_SECRET && config.POLYMARKET_API_PASSPHRASE);
    console.log(`[Config] Polymarket API key found; scanner enabled. DRY_RUN=${config.PREDICT_POLY_DRY_RUN}, bankroll=$${config.PREDICT_POLY_STARTING_BANKROLL}, kelly=${config.PREDICT_POLY_KELLY_FRACTION}, wallet=${hasWallet ? 'configured' : 'not set (dry-run only)'}, L2_auth=${hasL2 ? 'ready' : 'missing secret/passphrase'}`);
  } else {
    console.log('[Config] POLYMARKET_API_KEY not set; Polymarket scanner disabled.');
  }

  console.log(`[Config] Cost guardrails: daily=$${(config.DAILY_BUDGET_LIMIT_CENTS / 100).toFixed(2)}, per-agent=$${(config.AGENT_DAILY_LIMIT_CENTS / 100).toFixed(2)}`);
  console.log('[Config] All environment variables validated.');
}

// ── Runtime config overrides (from agent_config table) ──────────────────

/** Mutable overrides loaded from DB. Takes precedence over env vars. */
const runtimeOverrides: Record<string, string> = {};

/**
 * Load config overrides from agent_config table on startup.
 * Must be called after DB pool is initialized.
 */
export async function loadConfigOverrides(): Promise<void> {
  try {
    // Dynamic import to avoid circular dependency (db.ts imports config.ts)
    const { query } = await import('./db');
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM agent_config`
    );
    for (const row of rows) {
      runtimeOverrides[row.key] = row.value;
      console.log(`[Config] DB override: ${row.key}=${row.value}`);
    }
  } catch {
    // Table may not exist yet (pre-migration); silently continue
  }
}

/**
 * Set a runtime config override and persist to DB.
 */
export async function setConfigOverride(key: string, value: string): Promise<void> {
  runtimeOverrides[key] = value;
  const { query } = await import('./db');
  await query(
    `INSERT INTO agent_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

/**
 * Remove a runtime config override.
 */
export async function removeConfigOverride(key: string): Promise<void> {
  delete runtimeOverrides[key];
  const { query } = await import('./db');
  await query(`DELETE FROM agent_config WHERE key = $1`, [key]);
}

/**
 * Check if Polymarket dry run is active.
 * DB override takes precedence over env var.
 */
export function isPolyDryRun(): boolean {
  if ('PREDICT_POLY_DRY_RUN' in runtimeOverrides) {
    return runtimeOverrides['PREDICT_POLY_DRY_RUN'] !== 'false';
  }
  return config.PREDICT_POLY_DRY_RUN;
}

export function getModelCategory(model: string): 'opus' | 'sonnet' | 'haiku' {
  if (model.includes('opus')) return 'opus';
  if (model.includes('haiku')) return 'haiku';
  return 'sonnet';
}
