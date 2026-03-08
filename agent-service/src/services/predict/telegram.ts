/**
 * Predict Agent: Telegram Commands
 *
 * /predict subcommands for monitoring and controlling the trading agent.
 * 5-minute cooldown on /predict scan to prevent API abuse.
 */

import TelegramBot from 'node-telegram-bot-api';
import { query, queryOne } from '../../db';
import { getCurrentBankroll, getTradeStats, getManifoldBalance } from './execute';
import { RISK_LIMITS } from './risk-gate';

let lastScanAt = 0;
const SCAN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

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
      default:
        await bot.sendMessage(chatId,
          `Unknown subcommand: \`${sub}\`\n\nUsage:\n/predict status\n/predict positions\n/predict scan\n/predict pause\n/predict resume\n/predict gate`,
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
