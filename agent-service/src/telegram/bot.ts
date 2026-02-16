import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { handleUserMessage } from '../agents/router';
import { getSystemHealth } from '../services/task-manager';
import * as xpSystem from '../services/xp-system';
import { query, queryOne } from '../db';

function splitMessage(text: string, maxLength: number = 4096): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph break
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Try a single newline
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Last resort: split at space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt === -1) {
      splitAt = maxLength;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}

function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function handleLeaderboardCommand(chatId: number, bot: TelegramBot): Promise<void> {
  try {
    const leaderboard = await xpSystem.getLeaderboard();
    const msg = xpSystem.formatLeaderboardForTelegram(leaderboard);
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(chatId, `Leaderboard failed: ${(err as Error).message}`);
  }
}

async function handleQueueCommand(chatId: number, bot: TelegramBot): Promise<void> {
  try {
    const items = await query<{ id: number; title: string; status: string; priority: number; created_at: string }>(
      `SELECT id, title, status, priority, created_at FROM dev_queue
       WHERE status IN ('pending', 'in_progress')
       ORDER BY priority DESC, created_at ASC
       LIMIT 15`
    );

    if (items.length === 0) {
      await bot.sendMessage(chatId, '*Dev Queue*\n\nNo pending items. Gilfoyle is idle.', { parse_mode: 'Markdown' });
      return;
    }

    const statusEmoji: Record<string, string> = { pending: '⏳', in_progress: '🔨', completed: '✅', failed: '❌' };
    const lines = items.map(item => {
      const emoji = statusEmoji[item.status] || '❓';
      return `${emoji} #${item.id} [P${item.priority}] ${item.title}`;
    });

    const msg = `*Dev Queue* (${items.length} items)\n\n${lines.join('\n')}`;
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(chatId, `Queue check failed: ${(err as Error).message}`);
  }
}

async function handleShipCommand(chatId: number, text: string, bot: TelegramBot): Promise<void> {
  // Parse: /ship <description>
  const description = text.replace(/^\/ship\s*/i, '').trim();
  if (!description) {
    await bot.sendMessage(chatId, 'Usage: /ship <description of what to build>\n\nExample: /ship Build a health check endpoint with uptime tracking', { parse_mode: 'Markdown' });
    return;
  }

  try {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO dev_queue (title, description, priority, created_by)
       VALUES ($1, $2, $3, 'alan')
       RETURNING id`,
      [description.substring(0, 100), description, 7]
    );

    if (row) {
      await bot.sendMessage(chatId, `*Queued for Gilfoyle*\n\nDev Queue #${row.id}: ${description.substring(0, 100)}\nPriority: 7/10\n\nGilfoyle will pick this up during his night shift (11 PM) or you can ask him directly.`, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    await bot.sendMessage(chatId, `Failed to queue item: ${(err as Error).message}`);
  }
}

async function handleStatusCommand(chatId: number, bot: TelegramBot): Promise<void> {
  try {
    const health = await getSystemHealth();
    const now = new Date();
    const weddingDate = new Date('2026-07-12');
    const daysToWedding = Math.ceil(
      (weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    const msg = [
      '*Alan OS Status Report*',
      '',
      `Active Agents: ${health.activeAgents}`,
      `Tasks Today: ${health.tasksToday}`,
      `Pending Tasks: ${health.tasksPending}`,
      `Cost Today: ${formatCost(health.costTodayCents)}`,
      `Last Cron: ${health.lastCronStatus}`,
      '',
      `Days to Wedding: ${daysToWedding}`,
      '',
      `_${now.toLocaleString('en-US', { timeZone: 'America/Denver' })} MT_`,
    ].join('\n');

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(chatId, `Status check failed: ${(err as Error).message}`);
  }
}

export function startBot(): TelegramBot {
  const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on('message', async (msg) => {
    // Security: only respond to the allowed user
    if (msg.from?.id !== config.TELEGRAM_ALLOWED_USER_ID) {
      console.log(`[Telegram] Rejected message from user ${msg.from?.id}`);
      return;
    }

    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    // Handle slash commands
    if (text === '/status' || text === '/start') {
      await handleStatusCommand(chatId, bot);
      return;
    }
    if (text === '/leaderboard' || text === '/xp') {
      await handleLeaderboardCommand(chatId, bot);
      return;
    }
    if (text === '/queue') {
      await handleQueueCommand(chatId, bot);
      return;
    }
    if (text.startsWith('/ship')) {
      await handleShipCommand(chatId, text, bot);
      return;
    }

    // Periodic typing indicator (refreshes every 4s for long-running tasks)
    const typingInterval = setInterval(async () => {
      try { await bot.sendChatAction(chatId, 'typing'); } catch { /* ignore */ }
    }, 4000);

    try {
      // Show initial typing indicator
      await bot.sendChatAction(chatId, 'typing');

      // Process message through agent router (pass chatId for conversation memory)
      const response = await handleUserMessage(text, msg.message_id, chatId);

      clearInterval(typingInterval);

      // Send response (split if too long for Telegram)
      const chunks = splitMessage(response);
      for (const chunk of chunks) {
        try {
          await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        } catch {
          // If Markdown parsing fails, send as plain text
          await bot.sendMessage(chatId, chunk);
        }
      }
    } catch (err) {
      clearInterval(typingInterval);
      const errorMsg = (err as Error).message;
      console.error('[Telegram] Error handling message:', errorMsg);
      await bot.sendMessage(
        chatId,
        `Something went wrong processing your message. Error: ${errorMsg.substring(0, 200)}`
      );
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[Telegram] Polling error:', err.message);
  });

  console.log('[Telegram] Bot started, polling for messages...');
  return bot;
}
