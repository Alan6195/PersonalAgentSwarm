import { config, validateConfig } from './config';
import { pool } from './db';
import { startBot } from './telegram/bot';
import { startWebhookServer, setTelegramNotifier } from './services/webhook-server';
import { startScheduler, stopScheduler, setCronNotifier } from './services/cron-scheduler';

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

  // 7. Start cron scheduler
  startScheduler();

  // 8. Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('[Agent Service] Shutting down...');
    stopScheduler();
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
