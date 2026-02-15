import * as outlookMail from './outlook-mail';

export interface EmailActionResult {
  actionsTaken: boolean;
  actions: string[];
  result: string;
  originalResponse: string;
}

/**
 * Parse and execute all [EMAIL_ACTION]...[/EMAIL_ACTION] blocks in agent response.
 * Supports multiple blocks per response (processed sequentially).
 * Returns the modified response with action blocks replaced by results.
 */
export async function processEmailActions(
  agentResponse: string,
  taskId?: number
): Promise<EmailActionResult> {
  // Check if Outlook is configured
  if (!outlookMail.isConfigured()) {
    const cleaned = agentResponse
      .replace(/\[EMAIL_ACTION\][\s\S]*?\[\/EMAIL_ACTION\]/g, '')
      .trim();
    return {
      actionsTaken: false,
      actions: [],
      result: cleaned + (cleaned !== agentResponse ? '\n\n(Outlook email integration not configured; no email actions taken)' : ''),
      originalResponse: agentResponse,
    };
  }

  const blockRegex = /\[EMAIL_ACTION\]([\s\S]*?)\[\/EMAIL_ACTION\]/g;
  const blocks: { full: string; body: string }[] = [];
  let match;

  while ((match = blockRegex.exec(agentResponse)) !== null) {
    blocks.push({ full: match[0], body: match[1] });
  }

  // No action blocks found
  if (blocks.length === 0) {
    return {
      actionsTaken: false,
      actions: [],
      result: agentResponse,
      originalResponse: agentResponse,
    };
  }

  let modifiedResponse = agentResponse;
  const actions: string[] = [];

  for (const block of blocks) {
    const fields = parseFields(block.body);
    const action = fields.action || '';
    let replacement = '';

    try {
      switch (action) {
        case 'read_inbox': {
          const count = parseInt(fields.count || '25', 10);
          const unreadOnly = fields.unread_only === 'true';
          const messages = await outlookMail.getInboxMessages({ top: count, unreadOnly });
          replacement = `\n\nInbox (${messages.length} messages):\n${outlookMail.formatMessagesForAgent(messages)}`;
          actions.push(`read_inbox (${messages.length} messages)`);
          break;
        }

        case 'read_message': {
          const msgId = fields.message_id;
          if (!msgId) {
            replacement = '\n\n(Error: read_message requires message_id)';
            break;
          }
          const msg = await outlookMail.getMessage(msgId);
          replacement = `\n\nEmail from ${msg.from} <${msg.fromEmail}>:\nSubject: ${msg.subject}\nReceived: ${msg.receivedDateTime}\n\n${msg.body || msg.bodyPreview}`;
          actions.push('read_message');
          break;
        }

        case 'mark_read': {
          const ids = parseMessageIds(fields.message_ids);
          if (ids.length === 0) {
            replacement = '\n\n(Error: mark_read requires message_ids)';
            break;
          }
          const count = await outlookMail.markAsRead(ids, taskId);
          replacement = `\n\nMarked ${count} email(s) as read.`;
          actions.push(`mark_read (${count})`);
          break;
        }

        case 'mark_unread': {
          const ids = parseMessageIds(fields.message_ids);
          if (ids.length === 0) {
            replacement = '\n\n(Error: mark_unread requires message_ids)';
            break;
          }
          const count = await outlookMail.markAsUnread(ids, taskId);
          replacement = `\n\nMarked ${count} email(s) as unread.`;
          actions.push(`mark_unread (${count})`);
          break;
        }

        case 'move': {
          const ids = parseMessageIds(fields.message_ids);
          const destination = fields.destination;
          if (ids.length === 0 || !destination) {
            replacement = '\n\n(Error: move requires message_ids and destination)';
            break;
          }
          const count = await outlookMail.moveToFolder(ids, destination, taskId);
          replacement = `\n\nMoved ${count} email(s) to ${destination}.`;
          actions.push(`move to ${destination} (${count})`);
          break;
        }

        case 'delete': {
          const ids = parseMessageIds(fields.message_ids);
          if (ids.length === 0) {
            replacement = '\n\n(Error: delete requires message_ids)';
            break;
          }
          const count = await outlookMail.deleteMessages(ids, taskId);
          replacement = `\n\nDeleted ${count} email(s).`;
          actions.push(`delete (${count})`);
          break;
        }

        case 'list_folders': {
          const folders = await outlookMail.getMailFolders();
          const formatted = folders.map(f =>
            `- ${f.displayName} (${f.unreadItemCount} unread / ${f.totalItemCount} total)`
          ).join('\n');
          replacement = `\n\nMail Folders:\n${formatted}`;
          actions.push('list_folders');
          break;
        }

        default:
          replacement = `\n\n(Unknown email action: ${action})`;
      }
    } catch (err) {
      replacement = `\n\n(Email action "${action}" failed: ${(err as Error).message})`;
      console.error(`[EmailActions] Action "${action}" failed:`, (err as Error).message);
    }

    modifiedResponse = modifiedResponse.replace(block.full, replacement);
  }

  return {
    actionsTaken: actions.length > 0,
    actions,
    result: modifiedResponse.trim(),
    originalResponse: agentResponse,
  };
}

// ------------------------------------------------------------------
// Parse key: value fields from an action block body
// ------------------------------------------------------------------
function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = body.trim().split('\n');

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();
    if (key) fields[key] = value;
  }

  return fields;
}

// ------------------------------------------------------------------
// Parse message_ids from a JSON array string or comma-separated list
// ------------------------------------------------------------------
function parseMessageIds(raw: string | undefined): string[] {
  if (!raw) return [];

  // Try JSON array first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* not JSON */ }

  // Fall back to comma-separated
  return raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}
