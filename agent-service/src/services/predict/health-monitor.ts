/**
 * Predict Agent: Health Monitor
 *
 * Runs every 5 minutes via cron. Checks system health across all subsystems
 * and auto-heals where possible. Sends Telegram alerts for issues requiring
 * human attention.
 *
 * Checks:
 * 1. Intel signal freshness (auto-reruns X intel scan if stale > 3.5 hours)
 * 2. Price feed connection (alerts if no update in > 5 minutes)
 * 3. Cron job health (alerts if any predict job missed 2+ scheduled runs)
 * 4. USDC balance (alerts if below minimum for trading)
 * 5. Wallet gas balance (alerts if MATIC too low for approvals)
 */

import { query, queryOne } from '../../db';
import { config } from '../../config';
import { priceFeed } from './price-feed';
import { getIntelSummary } from './intel-signal';

// Track auto-heal cooldowns to avoid spamming
const healCooldowns = new Map<string, number>();
const HEAL_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between auto-heals

interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'critical';
  message: string;
  autoHealed?: boolean;
}

/**
 * Run all health checks. Returns a summary string for cron output.
 * Auto-heals intel signals if stale. Sends Telegram alerts for critical issues.
 */
export async function runHealthChecks(): Promise<{
  summary: string;
  checks: HealthCheck[];
  alertMessage: string | null;
}> {
  const checks: HealthCheck[] = [];

  // 1. Intel signal freshness
  checks.push(await checkIntelFreshness());

  // 2. Price feed health
  checks.push(checkPriceFeedHealth());

  // 3. Cron job health (predict-related jobs)
  checks.push(await checkCronJobHealth());

  // 4. USDC balance
  checks.push(await checkUSDCBalance());

  // 5. MATIC gas balance
  checks.push(await checkGasBalance());

  // Build summary
  const okCount = checks.filter(c => c.status === 'ok').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const critCount = checks.filter(c => c.status === 'critical').length;
  const healed = checks.filter(c => c.autoHealed).length;

  const statusEmoji = critCount > 0 ? '\u{1F6A8}' : warnCount > 0 ? '\u26A0\uFE0F' : '\u2705';
  const summary = `${statusEmoji} Health: ${okCount} ok, ${warnCount} warn, ${critCount} critical${healed > 0 ? `, ${healed} auto-healed` : ''}`;

  // Build alert for warn/critical
  let alertMessage: string | null = null;
  const alertChecks = checks.filter(c => c.status !== 'ok');
  if (alertChecks.length > 0) {
    const lines = alertChecks.map(c => {
      const icon = c.status === 'critical' ? '\u{1F6A8}' : '\u26A0\uFE0F';
      return `${icon} *${c.name}*: ${c.message}${c.autoHealed ? ' (auto-healed)' : ''}`;
    });
    alertMessage = `*Predict Health Monitor*\n\n${lines.join('\n')}`;
  }

  return { summary, checks, alertMessage };
}

/**
 * Check intel signal freshness. Auto-heals by triggering X intel scan.
 */
async function checkIntelFreshness(): Promise<HealthCheck> {
  const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
  let oldestAge = 0;
  let staleCount = 0;

  for (const asset of assets) {
    const intel = await getIntelSummary(asset);
    if (!intel || intel.freshestSignalAge > 180) { // > 3 hours
      staleCount++;
      const age = intel?.freshestSignalAge ?? 999;
      if (age > oldestAge) oldestAge = age;
    }
  }

  if (staleCount === 0) {
    return { name: 'Intel Signals', status: 'ok', message: 'All assets have fresh signals' };
  }

  // Auto-heal: trigger intel scan if stale > 3.5 hours and not recently healed
  const shouldHeal = oldestAge > 210 && canAutoHeal('intel-scan');
  if (shouldHeal) {
    try {
      const { runIntelligenceScan } = await import('../x-intelligence');
      await runIntelligenceScan();
      markHealed('intel-scan');
      return {
        name: 'Intel Signals',
        status: 'warn',
        message: `${staleCount}/4 assets stale (oldest: ${Math.round(oldestAge)}min). Auto-triggered intel scan.`,
        autoHealed: true,
      };
    } catch (err: any) {
      return {
        name: 'Intel Signals',
        status: 'critical',
        message: `${staleCount}/4 assets stale (oldest: ${Math.round(oldestAge)}min). Auto-heal failed: ${err.message?.substring(0, 80)}`,
      };
    }
  }

  return {
    name: 'Intel Signals',
    status: staleCount >= 3 ? 'critical' : 'warn',
    message: `${staleCount}/4 assets stale (oldest: ${Math.round(oldestAge)}min)`,
  };
}

/**
 * Check price feed WebSocket connection and data freshness.
 */
function checkPriceFeedHealth(): HealthCheck {
  const status = priceFeed.getStatus();

  if (!status.connected) {
    return { name: 'Price Feed', status: 'critical', message: `Disconnected (source: ${status.source})` };
  }

  // Check if any asset has a price (connected but no data = issue)
  const activePrices = Object.values(status.assets).filter(p => p > 0).length;
  if (activePrices === 0) {
    return { name: 'Price Feed', status: 'warn', message: 'Connected but no price data yet' };
  }

  // Check signal freshness (getSignal returns lastUpdated timestamp)
  const signals = ['BTC', 'ETH', 'SOL', 'XRP'].map(a => priceFeed.getSignal(a));
  const now = Date.now();
  const stalestSignal = signals
    .filter(s => s !== null)
    .reduce((oldest, s) => {
      const age = now - (s?.lastUpdated ?? 0);
      return age > oldest ? age : oldest;
    }, 0);

  if (stalestSignal > 5 * 60 * 1000) { // > 5 minutes
    return {
      name: 'Price Feed',
      status: 'warn',
      message: `Connected but data stale (${Math.round(stalestSignal / 60000)}min old)`,
    };
  }

  return {
    name: 'Price Feed',
    status: 'ok',
    message: `${status.source} connected, ${activePrices}/4 assets, BTC=$${Math.round(status.assets.BTC || 0)}`,
  };
}

/**
 * Check cron job health for predict-related jobs.
 * Alerts if any job has missed 2+ expected runs.
 */
async function checkCronJobHealth(): Promise<HealthCheck> {
  const jobs = await query<any>(
    `SELECT name, schedule, last_run_at, next_run_at, last_status, enabled
     FROM cron_jobs
     WHERE name LIKE 'Predict%' OR name = 'X Agent Intel Scan'
     ORDER BY name`
  );

  const issues: string[] = [];
  const now = new Date();

  for (const job of jobs) {
    if (!job.enabled) continue;

    // Check if job has missed runs (next_run_at is in the past by > 2x schedule interval)
    if (job.next_run_at) {
      const nextRun = new Date(job.next_run_at);
      const overdue = (now.getTime() - nextRun.getTime()) / 60000; // minutes overdue

      if (overdue > 30) { // More than 30 min overdue
        issues.push(`${job.name}: ${Math.round(overdue)}min overdue`);
      }
    }

    // Check if last run failed
    if (job.last_status === 'error') {
      issues.push(`${job.name}: last run failed`);
    }
  }

  if (issues.length === 0) {
    return { name: 'Cron Jobs', status: 'ok', message: `${jobs.length} jobs healthy` };
  }

  return {
    name: 'Cron Jobs',
    status: issues.length >= 3 ? 'critical' : 'warn',
    message: issues.join('; '),
  };
}

/**
 * Check USDC.e balance in the trading wallet.
 */
async function checkUSDCBalance(): Promise<HealthCheck> {
  if (!config.POLYGON_RPC_URL || !config.POLYMARKET_WALLET_ADDRESS) {
    return { name: 'USDC Balance', status: 'ok', message: 'Wallet not configured (dry run)' };
  }

  try {
    const wallet = config.POLYMARKET_WALLET_ADDRESS;
    const usdc = config.USDC_CONTRACT;
    const data = `0x70a08231${wallet.replace('0x', '').toLowerCase().padStart(64, '0')}`;

    const res = await fetch(config.POLYGON_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: usdc, data }, 'latest'],
      }),
    });

    const json = await res.json() as any;
    if (json.result) {
      const balance = parseInt(json.result, 16) / 1_000_000;
      if (balance < 1) {
        return { name: 'USDC Balance', status: 'critical', message: `$${balance.toFixed(2)} (below $1 minimum)` };
      }
      if (balance < 5) {
        return { name: 'USDC Balance', status: 'warn', message: `$${balance.toFixed(2)} (low)` };
      }
      return { name: 'USDC Balance', status: 'ok', message: `$${balance.toFixed(2)}` };
    }

    return { name: 'USDC Balance', status: 'warn', message: 'RPC returned no result' };
  } catch {
    return { name: 'USDC Balance', status: 'warn', message: 'RPC check failed' };
  }
}

/**
 * Check MATIC/POL balance for gas fees.
 */
async function checkGasBalance(): Promise<HealthCheck> {
  if (!config.POLYGON_RPC_URL || !config.POLYMARKET_WALLET_ADDRESS) {
    return { name: 'Gas (MATIC)', status: 'ok', message: 'Wallet not configured' };
  }

  try {
    const wallet = config.POLYMARKET_WALLET_ADDRESS;
    const res = await fetch(config.POLYGON_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getBalance',
        params: [wallet, 'latest'],
      }),
    });

    const json = await res.json() as any;
    if (json.result) {
      const balance = parseInt(json.result, 16) / 1e18;
      if (balance < 0.005) {
        return { name: 'Gas (MATIC)', status: 'critical', message: `${balance.toFixed(6)} MATIC (need > 0.01 for approvals)` };
      }
      if (balance < 0.05) {
        return { name: 'Gas (MATIC)', status: 'warn', message: `${balance.toFixed(4)} MATIC (low)` };
      }
      return { name: 'Gas (MATIC)', status: 'ok', message: `${balance.toFixed(4)} MATIC` };
    }

    return { name: 'Gas (MATIC)', status: 'warn', message: 'RPC check failed' };
  } catch {
    return { name: 'Gas (MATIC)', status: 'warn', message: 'RPC check failed' };
  }
}

// ── Auto-heal helpers ────────────────────────────────────────────────

function canAutoHeal(key: string): boolean {
  const lastHeal = healCooldowns.get(key);
  if (!lastHeal) return true;
  return Date.now() - lastHeal > HEAL_COOLDOWN_MS;
}

function markHealed(key: string): void {
  healCooldowns.set(key, Date.now());
}
