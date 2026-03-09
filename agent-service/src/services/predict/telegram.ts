/**
 * Predict Agent: Telegram Commands
 *
 * /predict subcommands for monitoring and controlling the trading agent.
 * 5-minute cooldown on /predict scan to prevent API abuse.
 */

import TelegramBot from 'node-telegram-bot-api';
import { query, queryOne } from '../../db';
import { getCurrentBankroll, getTradeStats, getManifoldBalance } from './execute';
import { getUSDCBalance, checkApprovals, ensureWalletReady } from './execute-polymarket';
import { RISK_LIMITS } from './risk-gate';
import { priceFeed } from './price-feed';
import { runHealthChecks } from './health-monitor';
import { config, isPolyDryRun, setConfigOverride, removeConfigOverride } from '../../config';

let lastScanAt = 0;
const SCAN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// One-time notification flag: fires when first edge > 6c candidate found after /predict golive wait
let notifyOnFirstEdgeCandidate = false;

/**
 * Handle /predict <subcommand>
 */
export async function handlePredictCommand(
  chatId: number,
  subcommand: string,
  bot: TelegramBot,
): Promise<void> {
  const sub = (subcommand || 'status').toLowerCase().trim();

  try {
    switch (sub) {
      case 'status':
      case '':
        await sendStatus(chatId, bot);
        break;
      case 'positions':
        await sendPositions(chatId, bot);
        break;
      case 'scan':
        await triggerScan(chatId, bot);
        break;
      case 'pause':
        await pauseTrading(chatId, bot);
        break;
      case 'resume':
        await resumeTrading(chatId, bot);
        break;
      case 'gate':
        await sendGateProgress(chatId, bot);
        break;
      case 'golive':
        await handleGoLive(chatId, bot);
        break;
      case 'golive confirm':
        await handleGoLiveConfirm(chatId, bot);
        break;
      case 'golive wait':
        await handleGoLiveWait(chatId, bot);
        break;
      case 'health':
        await sendHealthCheck(chatId, bot);
        break;
      case 'setup':
        await runWalletSetup(chatId, bot);
        break;
      default:
        await bot.sendMessage(chatId,
          `Unknown subcommand: \`${sub}\`\n\nUsage:\n/predict status\n/predict positions\n/predict scan\n/predict pause\n/predict resume\n/predict gate\n/predict golive\n/predict health\n/predict setup`,
          { parse_mode: 'Markdown' }
        );
    }
  } catch (err) {
    console.error(`[PredictTG] Error handling /predict ${sub}:`, (err as Error).message);
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}

async function sendStatus(chatId: number, bot: TelegramBot): Promise<void> {
  const platform = 'manifold';
  const bankroll = await getCurrentBankroll(platform);
  const stats = await getTradeStats(platform);
  const manifoldBalance = await getManifoldBalance();

  // Open positions
  const openPos = await queryOne<{ count: string; total: string }>(
    `SELECT COUNT(*) as count, COALESCE(SUM(bet_size), 0) as total
     FROM market_positions WHERE platform = $1 AND status = 'open'`,
    [platform]
  );

  // Risk state
  const todayStr = new Date().toISOString().split('T')[0];
  const risk = await queryOne<any>(
    `SELECT * FROM daily_risk_state WHERE date = $1 AND platform = $2`,
    [todayStr, platform]
  );

  // Last scan
  const lastScan = await queryOne<any>(
    `SELECT scanned_at FROM market_scans WHERE platform = $1 ORDER BY scanned_at DESC LIMIT 1`,
    [platform]
  );

  const phase = parseInt(process.env.PREDICT_PHASE || '1');
  const paused = risk?.trading_paused ? '  PAUSED' : '';

  let msg = `*PREDICT AGENT STATUS*${paused}\n\n`;
  msg += `Phase: ${phase} (${phase === 1 ? 'Manifold paper' : 'Polymarket live'})\n`;
  msg += `Bankroll: M$${bankroll.toFixed(0)}${manifoldBalance !== null ? ` (Manifold: M$${manifoldBalance.toFixed(0)})` : ''}\n`;
  msg += `Open positions: ${openPos?.count || 0} (M$${parseFloat(openPos?.total || '0').toFixed(0)} deployed)\n\n`;

  msg += `*Performance*\n`;
  msg += `Trades: ${stats.totalTrades} (${stats.wins}W / ${stats.losses}L)\n`;
  msg += `Win rate: ${(stats.winRate * 100).toFixed(1)}%\n`;
  msg += `Total P&L: ${stats.totalPnl >= 0 ? '+' : ''}M$${stats.totalPnl.toFixed(2)}\n`;
  msg += `Sharpe: ${stats.sharpe.toFixed(2)}\n\n`;

  if (risk) {
    msg += `*Today*\n`;
    msg += `Daily P&L: ${parseFloat(risk.daily_pnl) >= 0 ? '+' : ''}M$${parseFloat(risk.daily_pnl).toFixed(2)}\n`;
    msg += `Drawdown: ${(parseFloat(risk.current_drawdown) * 100).toFixed(1)}%\n`;
    if (risk.trading_paused) msg += `Paused: ${risk.pause_reason}\n`;
  }

  if (lastScan) {
    const scanAge = Math.round((Date.now() - new Date(lastScan.scanned_at).getTime()) / 60000);
    msg += `\nLast scan: ${scanAge}m ago`;
  }

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

async function sendPositions(chatId: number, bot: TelegramBot): Promise<void> {
  const positions = await query<any>(
    `SELECT id, question, direction, p_market, p_model, edge, bet_size, intel_aligned, opened_at
     FROM market_positions WHERE platform = 'manifold' AND status = 'open'
     ORDER BY opened_at DESC LIMIT 10`
  );

  if (positions.length === 0) {
    await bot.sendMessage(chatId, 'No open positions.');
    return;
  }

  let msg = `*OPEN POSITIONS (${positions.length})*\n\n`;
  for (const p of positions) {
    const edge = parseFloat(p.edge);
    const bet = parseFloat(p.bet_size);
    msg += `#${p.id} ${p.direction} @ ${parseFloat(p.p_market).toFixed(2)} | M$${bet.toFixed(0)} | edge: ${(edge * 100).toFixed(0)}c${p.intel_aligned ? ' | intel' : ''}\n`;
    msg += `  ${p.question.substring(0, 60)}\n\n`;
  }

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

async function triggerScan(chatId: number, bot: TelegramBot): Promise<void> {
  // Cooldown check
  const now = Date.now();
  const elapsed = now - lastScanAt;

  if (elapsed < SCAN_COOLDOWN_MS) {
    const remaining = Math.ceil((SCAN_COOLDOWN_MS - elapsed) / 1000);
    await bot.sendMessage(chatId, `Scan on cooldown. Try again in ${remaining}s.`);
    return;
  }

  lastScanAt = now;
  await bot.sendMessage(chatId, 'Triggering manual scan...');

  try {
    const { handleManifoldScan } = await import('./cron');
    // Create a temporary task for tracking
    const result = await handleManifoldScan(0);
    await bot.sendMessage(chatId, `Scan complete: ${result}`);
  } catch (err) {
    await bot.sendMessage(chatId, `Scan failed: ${(err as Error).message}`);
  }
}

async function pauseTrading(chatId: number, bot: TelegramBot): Promise<void> {
  const todayStr = new Date().toISOString().split('T')[0];
  await query(
    `UPDATE daily_risk_state SET trading_paused = true, pause_reason = 'manual_telegram', updated_at = NOW()
     WHERE date = $1 AND platform = 'manifold'`,
    [todayStr]
  );
  await bot.sendMessage(chatId, 'Trading paused. Monitoring only.');
}

async function resumeTrading(chatId: number, bot: TelegramBot): Promise<void> {
  const todayStr = new Date().toISOString().split('T')[0];
  await query(
    `UPDATE daily_risk_state SET trading_paused = false, pause_reason = NULL, updated_at = NOW()
     WHERE date = $1 AND platform = 'manifold'`,
    [todayStr]
  );
  await bot.sendMessage(chatId, 'Trading resumed.');
}

async function sendGateProgress(chatId: number, bot: TelegramBot): Promise<void> {
  const stats = await getTradeStats('manifold');

  const tradesGate = stats.totalTrades >= 30;
  const winRateGate = stats.winRate >= 0.60;
  const sharpeGate = stats.sharpe >= 1.5;
  const allClear = tradesGate && winRateGate && sharpeGate;

  let msg = `*PHASE GATE: Manifold -> Polymarket*\n\n`;
  msg += `${tradesGate ? '✓' : '○'} Trades: ${stats.totalTrades}/30\n`;
  msg += `${winRateGate ? '✓' : '○'} Win Rate: ${(stats.winRate * 100).toFixed(1)}% (need >= 60%)\n`;
  msg += `${sharpeGate ? '✓' : '○'} Sharpe: ${stats.sharpe.toFixed(2)} (need >= 1.5)\n\n`;

  if (allClear) {
    msg += 'ALL GATES CLEAR. Ready for Phase 2 (Polymarket live USDC).';
  } else {
    msg += 'Gates not cleared. Continue Manifold paper trading.';
  }

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// ── Go Live: dry-run -> live USDC transition ────────────────────────────

async function handleGoLive(chatId: number, bot: TelegramBot): Promise<void> {
  // Already live?
  if (!isPolyDryRun()) {
    await bot.sendMessage(chatId, 'Already in LIVE mode. Send /predict pause to halt trading.');
    return;
  }

  // Run pre-flight checks
  const checks: { label: string; pass: boolean; detail: string }[] = [];

  // 1. Price feed connected
  const btcSignal = priceFeed.getSignal('BTC');
  const tickAge = btcSignal ? Math.round((Date.now() - btcSignal.lastUpdated) / 1000) : null;
  checks.push({
    label: 'Price feed connected',
    pass: !!btcSignal && tickAge !== null && tickAge < 120,
    detail: tickAge !== null ? `last tick: ${tickAge}s ago` : 'no data',
  });

  // 2. Wallet key configured
  const hasWallet = !!config.POLYMARKET_WALLET_KEY;
  checks.push({
    label: 'Wallet key configured',
    pass: hasWallet,
    detail: hasWallet ? 'set' : 'POLYMARKET_WALLET_KEY not set',
  });

  // 3. USDC balance
  const usdcBalance = await getUSDCBalance();
  checks.push({
    label: 'USDC balance',
    pass: usdcBalance !== null && usdcBalance >= 10,
    detail: usdcBalance !== null ? `$${usdcBalance.toFixed(2)} on Polygon` : 'could not fetch (RPC not configured)',
  });

  // 4. Recent scan found candidates
  const recentScan = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM market_scans
     WHERE platform = 'polymarket' AND scanned_at > NOW() - INTERVAL '2 hours'`
  );
  const recentScanCount = parseInt(recentScan?.count || '0');
  checks.push({
    label: 'Recent scans running',
    pass: recentScanCount > 0,
    detail: recentScanCount > 0 ? `${recentScanCount} in last 2h` : 'no scans in last 2h',
  });

  // 5. Dry-run candidates with net edge > 9c
  const edgeCandidates = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM market_scans
     WHERE platform = 'polymarket'
       AND COALESCE(net_edge, abs_edge) > 0.09
       AND scanned_at > NOW() - INTERVAL '24 hours'`
  );
  const edgeCount = parseInt(edgeCandidates?.count || '0');
  checks.push({
    label: 'Candidates with net edge > 9c (24h)',
    pass: edgeCount > 0,
    detail: edgeCount > 0 ? `${edgeCount} found` : 'none yet',
  });

  // 6. Risk gate functioning
  const riskScans = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM market_scans
     WHERE platform = 'polymarket'
       AND reward_score IS NOT NULL
       AND scanned_at > NOW() - INTERVAL '24 hours'`
  );
  const riskWorking = parseInt(riskScans?.count || '0') > 0;
  checks.push({
    label: 'Risk gate functioning',
    pass: riskWorking,
    detail: riskWorking ? 'scans scored' : 'no scored scans in 24h',
  });

  // 7. No agent errors in last 24h
  const errorRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM cron_runs cr
     JOIN cron_jobs cj ON cr.cron_job_id = cj.id
     WHERE cj.name LIKE 'Predict%'
       AND cr.status = 'error'
       AND cr.started_at > NOW() - INTERVAL '24 hours'`
  );
  const errors = parseInt(errorRow?.count || '0');
  checks.push({
    label: 'No agent errors (24h)',
    pass: errors === 0,
    detail: errors === 0 ? 'clean' : `${errors} error(s)`,
  });

  // Verdict
  const allPass = checks.every(c => c.pass);

  let msg = `PRE-FLIGHT CHECK: DRY RUN -> LIVE USDC\n\n`;
  msg += `Technical\n`;
  for (const c of checks) {
    msg += `${c.pass ? '✅' : '❌'} ${c.label} (${c.detail})\n`;
  }

  if (allPass) {
    msg += `\nVERDICT: READY\nAll checks passed.\n`;
  } else {
    const failures = checks.filter(c => !c.pass);
    msg += `\nVERDICT: NOT READY\n`;
    msg += `Reason: ${failures.map(f => f.label).join(', ')}\n`;
  }

  msg += `\nSend /predict golive confirm to ${allPass ? 'go live' : 'override and go live anyway'}.`;
  msg += `\nSend /predict golive wait to keep monitoring (default).`;

  await bot.sendMessage(chatId, msg);
}

async function handleGoLiveConfirm(chatId: number, bot: TelegramBot): Promise<void> {
  if (!isPolyDryRun()) {
    await bot.sendMessage(chatId, 'Already in LIVE mode.');
    return;
  }

  // Flip dry run to false
  await setConfigOverride('PREDICT_POLY_DRY_RUN', 'false');

  const bankroll = config.PREDICT_POLY_STARTING_BANKROLL;
  const maxBet = (bankroll * 0.05).toFixed(2);

  const msg = [
    '✅ LIVE MODE ACTIVATED',
    '',
    `First real USDC trade will execute on next scan with edge > 6c.`,
    `Max bet size: $${maxBet} (5% of $${bankroll.toFixed(0)})`,
    '',
    'Send /predict pause to halt immediately if needed.',
  ].join('\n');

  await bot.sendMessage(chatId, msg);
}

async function handleGoLiveWait(chatId: number, bot: TelegramBot): Promise<void> {
  if (!isPolyDryRun()) {
    await bot.sendMessage(chatId, 'Already in LIVE mode. This command is for dry-run mode only.');
    return;
  }

  notifyOnFirstEdgeCandidate = true;
  await bot.sendMessage(chatId,
    "Continuing dry-run. I'll notify you when the first edge > 6c candidate appears."
  );
}

/**
 * Called by scan loop after each Polymarket scan to check if we should
 * send a one-time notification about a qualifying candidate.
 */
export function checkEdgeCandidateNotification(
  topEdge: number,
  question: string,
): { shouldNotify: boolean; message: string } {
  if (!notifyOnFirstEdgeCandidate) return { shouldNotify: false, message: '' };
  if (topEdge < 0.09) return { shouldNotify: false, message: '' };

  notifyOnFirstEdgeCandidate = false;
  return {
    shouldNotify: true,
    message: [
      'EDGE CANDIDATE FOUND',
      '',
      `"${question.substring(0, 80)}"`,
      `Net edge: ${(topEdge * 100).toFixed(1)}c (threshold: 9c, after fees)`,
      '',
      'This market would qualify for a live trade.',
      'Send /predict golive to review pre-flight checks.',
    ].join('\n'),
  };
}

// ── Health Check + Setup ────────────────────────────────────────────────

async function sendHealthCheck(chatId: number, bot: TelegramBot): Promise<void> {
  await bot.sendMessage(chatId, 'Running health checks...');

  const health = await runHealthChecks();

  let msg = '*PREDICT HEALTH MONITOR*\n\n';
  for (const check of health.checks) {
    const icon = check.status === 'ok' ? '\u2705' : check.status === 'warn' ? '\u26A0\uFE0F' : '\u{1F6A8}';
    msg += `${icon} *${check.name}*: ${check.message}`;
    if (check.autoHealed) msg += ' (auto-healed)';
    msg += '\n';
  }

  msg += `\n${health.summary}`;

  try {
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch {
    await bot.sendMessage(chatId, msg);
  }
}

async function runWalletSetup(chatId: number, bot: TelegramBot): Promise<void> {
  await bot.sendMessage(chatId, 'Running wallet setup (checking balance, approvals)...');

  // 1. Check current state
  const approvals = await checkApprovals();
  const usdcBalance = await getUSDCBalance();

  let msg = '*WALLET SETUP*\n\n';
  msg += `*Wallet*: ${config.POLYMARKET_WALLET_ADDRESS?.slice(0, 10)}...\n`;
  msg += `*USDC.e balance*: $${usdcBalance?.toFixed(2) ?? 'unknown'}\n\n`;

  msg += '*Approvals*:\n';
  for (const [name, detail] of Object.entries(approvals.details)) {
    const icon = detail.sufficient ? '\u2705' : '\u274C';
    msg += `${icon} ${name}: $${detail.allowance > 1e12 ? 'unlimited' : detail.allowance.toFixed(2)}\n`;
  }

  if (approvals.approved) {
    msg += '\n\u2705 All approvals in place. Ready to trade.';
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, msg);
    }
    return;
  }

  // Try auto-setup
  msg += '\nMissing approvals. Attempting auto-setup...';
  try {
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch {
    await bot.sendMessage(chatId, msg);
  }

  const result = await ensureWalletReady();

  if (result.ready) {
    await bot.sendMessage(chatId, `\u2705 ${result.message}`);
  } else {
    await bot.sendMessage(chatId, `\u274C ${result.message}`);
  }
}
