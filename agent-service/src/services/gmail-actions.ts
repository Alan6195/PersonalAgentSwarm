import * as gmailMail from './gmail-mail';

export interface GmailActionResult {
  actionsTaken: boolean;
  actions: string[];
  result: string;
  originalResponse: string;
}

/**
 * Parse and execute all [GMAIL_ACTION]...[/GMAIL_ACTION] blocks in agent response.
 * Supports multiple blocks per response (processed sequentially).
 * Returns the modified response with action blocks replaced by results.
 */
export async function processGmailActions(
  agentResponse: string,
  taskId?: number
): Promise<GmailActionResult> {
  // Check if Gmail is configured
  if (!gmailMail.isConfigured()) {
    const cleaned = agentResponse
      .replace(/\[GMAIL_ACTION\][\s\S]*?\[\/GMAIL_ACTION\]/g, '')
      .trim();
    return {
      actionsTaken: false,
      actions: [],
      result: cleaned + (cleaned !== agentResponse ? '\n\n(Gmail integration not configured; no Gmail actions taken)' : ''),
      originalResponse: agentResponse,
    };
  }

  const blockRegex = /\[GMAIL_ACTION\]([\s\S]*?)\[\/GMAIL_ACTION\]/g;
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
          const messages = await gmailMail.getInboxMessages({ maxResults: count, unreadOnly });
          replacement = `\n\nGmail Inbox (${messages.length} messages):\n${gmailMail.formatMessagesForAgent(messages)}`;
          actions.push(`read_inbox (${messages.length} messages)`);
          break;
        }

        case 'read_message': {
          const msgId = fields.message_id;
          if (!msgId) {
            replacement = '\n\n(Error: read_message requires message_id)';
            break;
          }
          const msg = await gmailMail.getMessage(msgId);
          replacement = `\n\nEmail from ${msg.from} <${msg.fromEmail}>:\nSubject: ${msg.subject}\nTo: ${msg.to}\nDate: ${msg.receivedDateTime}\nThread: ${msg.threadId}\n\n${msg.body || msg.snippet}`;
          actions.push('read_message');
          break;
        }

        case 'mark_read': {
          const ids = parseMessageIds(fields.message_ids);
          if (ids.length === 0) {
            replacement = '\n\n(Error: mark_read requires message_ids)';
            break;
          }
          const count = await gmailMail.markAsRead(ids, taskId);
          replacement = `\n\nMarked ${count} email(s) as read.`;
          actions.push(`mark_read (${count})`);
          break;
        }

        case 'archive': {
          const ids = parseMessageIds(fields.message_ids);
          if (ids.length === 0) {
            replacement = '\n\n(Error: archive requires message_ids)';
            break;
          }
          // SAFETY: Hold archive for Alan's approval via Telegram.
          replacement = `\n\n**PENDING ARCHIVE (${ids.length} email(s)):**\nMessage IDs: ${ids.join(', ')}\n\nReply "archive approved" to confirm. I will NOT archive until you confirm.`;
          actions.push(`archive_pending (${ids.length})`);
          console.log(`[GmailActions] HELD archive of ${ids.length} messages for approval`);
          break;
        }

        case 'delete': {
          const ids = parseMessageIds(fields.message_ids);
          if (ids.length === 0) {
            replacement = '\n\n(Error: delete requires message_ids)';
            break;
          }
          // SAFETY: Hold deletion for Alan's approval via Telegram.
          replacement = `\n\n**PENDING DELETION (${ids.length} email(s)):**\nMessage IDs: ${ids.join(', ')}\n\nReply "delete approved" to confirm. I will NOT delete until you confirm.`;
          actions.push(`delete_pending (${ids.length})`);
          console.log(`[GmailActions] HELD delete of ${ids.length} messages for approval`);
          break;
        }

        case 'send_email': {
          const to = fields.to;
          const subject = fields.subject;
          // Body is multi-line: grab everything from body: to the end of the block content
          const bodyContent = extractMultilineField(block.body, 'body');
          if (!to || !subject || !bodyContent) {
            replacement = '\n\n(Error: send_email requires to, subject, and body)';
            break;
          }

          // SAFETY: Never auto-send emails. Hold as draft for Alan's approval via Telegram.
          // The agent must tell Alan what it wants to send; Alan can then approve manually.
          replacement = `\n\n**DRAFT EMAIL (pending your approval):**\nTo: ${to}\nSubject: ${subject}\n${fields.thread_id ? `Thread: ${fields.thread_id}\n` : ''}---\n${bodyContent}\n---\nReply "send it" or "approve" to send this email. I will NOT send it until you confirm.`;
          actions.push(`send_email_draft to ${to}`);
          console.log(`[GmailActions] HELD send_email to ${to} (subject: "${subject}") for approval`);
          break;
        }

        case 'list_labels': {
          const labels = await gmailMail.getLabels();
          const formatted = labels.map(l =>
            `- ${l.name} (${l.type}${l.messagesUnread !== undefined ? `, ${l.messagesUnread} unread` : ''})`
          ).join('\n');
          replacement = `\n\nGmail Labels:\n${formatted}`;
          actions.push('list_labels');
          break;
        }

        case 'add_label': {
          const ids = parseMessageIds(fields.message_ids);
          const label = fields.label;
          if (ids.length === 0 || !label) {
            replacement = '\n\n(Error: add_label requires message_ids and label)';
            break;
          }
          const count = await gmailMail.addLabel(ids, label, taskId);
          replacement = `\n\nAdded label "${label}" to ${count} email(s).`;
          actions.push(`add_label "${label}" (${count})`);
          break;
        }

        case 'remove_label': {
          const ids = parseMessageIds(fields.message_ids);
          const label = fields.label;
          if (ids.length === 0 || !label) {
            replacement = '\n\n(Error: remove_label requires message_ids and label)';
            break;
          }
          const count = await gmailMail.removeLabel(ids, label, taskId);
          replacement = `\n\nRemoved label "${label}" from ${count} email(s).`;
          actions.push(`remove_label "${label}" (${count})`);
          break;
        }

        default:
          replacement = `\n\n(Unknown Gmail action: ${action})`;
      }
    } catch (err) {
      replacement = `\n\n(Gmail action "${action}" failed: ${(err as Error).message})`;
      console.error(`[GmailActions] Action "${action}" failed:`, (err as Error).message);
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
// Extract multi-line field value (for send_email body)
// Captures everything from "body: first line" through end of block content,
// stopping before any key that looks like a new field (key: value at start of line).
// ------------------------------------------------------------------
function extractMultilineField(blockBody: string, fieldName: string): string {
  const lines = blockBody.trim().split('\n');
  const startIdx = lines.findIndex(l => {
    const colonIdx = l.indexOf(':');
    if (colonIdx === -1) return false;
    return l.substring(0, colonIdx).trim().toLowerCase() === fieldName;
  });

  if (startIdx === -1) return '';

  // Get the first line's value
  const firstLine = lines[startIdx].substring(lines[startIdx].indexOf(':') + 1).trim();
  const bodyLines = [firstLine];

  // Collect subsequent lines until we hit another field-like line or end
  // A field-like line starts with a word followed by a colon (no leading whitespace heavy content)
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop if this looks like a new field (a short key followed by colon, not indented heavily)
    if (/^[a-z_]{2,20}:/i.test(line.trim())) break;
    bodyLines.push(line);
  }

  return bodyLines.join('\n').trim();
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
