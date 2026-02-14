import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { handleUserMessage } from '../agents/router';
import { getSystemHealth } from '../services/task-manager';

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

    // Handle /status command
    if (text === '/status' || text === '/start') {
      await handleStatusCommand(chatId, bot);
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
