import { config, validateConfig, loadConfigOverrides } from './config';
import { pool } from './db';
import { startBot } from './telegram/bot';
import { startWebhookServer, setTelegramNotifier } from './services/webhook-server';
import { startScheduler, stopScheduler, setCronNotifier } from './services/cron-scheduler';
import { setProgressNotifier } from './agents/router';
import { setBudgetAlertNotifier } from './services/cost-tracker';
import { priceFeed } from './services/predict/price-feed';
import { startMomentumWatcher, stopMomentumWatcher } from './services/predict/cron';

async function main(): Promise<void> {
  console.log('[Agent Service] Starting...');

  // 1. Validate environment
  validateConfig();

  // 2. Test database connection
  try {
    const result = await pool.query('SELECT NOW() as now, COUNT(*) as agents FROM agents');
    console.log(
      `[DB] Connected. Server time: ${result.rows[0].now}, Agents: ${result.rows[0].agents}`
    );
  } catch (err) {
    console.error('[DB] Connection failed:', (err as Error).message);
    process.exit(1);
  }

  // 2b. Load runtime config overrides from agent_config table
  await loadConfigOverrides();

  // 3. Start Telegram bot
  const bot = startBot();

  // 4. Wire Telegram notifications for webhooks
  const chatId = config.TELEGRAM_ALLOWED_USER_ID;
  setTelegramNotifier(async (text: string) => {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch {
      // Fall back to plain text if Markdown fails
      try {
        await bot.sendMessage(chatId, text);
      } catch (err) {
        console.error('[Webhook] Failed to send Telegram notification:', (err as Error).message);
      }
    }
  });

  // 5. Start webhook server
  const webhookServer = startWebhookServer();

  // 6. Wire Telegram notifications for cron scheduler
  setCronNotifier(async (text: string) => {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch {
      try {
        await bot.sendMessage(chatId, text);
      } catch (err) {
        console.error('[Cron] Failed to send Telegram notification:', (err as Error).message);
      }
    }
  });

  // 7. Wire Telegram notifications for Gilfoyle progress reports and budget alerts
  const telegramNotifier = async (text: string) => {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch {
      try { await bot.sendMessage(chatId, text); } catch { /* ignore */ }
    }
  };
  setProgressNotifier(telegramNotifier);
  setBudgetAlertNotifier(telegramNotifier);

  // 8. Start price feed for Polymarket scanner
  priceFeed.start();

  // 8b. Start momentum watcher (Loop 1): checks price feed every 60s,
  // triggers immediate Polymarket scan when momentum detected.
  // 5-min cooldown prevents repeated scans on same momentum event.
  startMomentumWatcher((result, asset, direction) => {
    telegramNotifier(
      `*Momentum scan triggered*\n` +
      `${asset} ${direction}\n` +
      `${result}`
    );
  });

  // 9. Start cron scheduler (includes */15 Polymarket scan as heartbeat fallback)
  await startScheduler();

  // 10. Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('[Agent Service] Shutting down...');
    stopScheduler();
    stopMomentumWatcher();
    priceFeed.stop();
    bot.stopPolling();
    webhookServer.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('[Agent Service] Ready. Waiting for Telegram messages...');
}

main().catch((err) => {
  console.error('[Agent Service] Fatal:', err);
  process.exit(1);
});
