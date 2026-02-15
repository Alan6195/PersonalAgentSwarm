import { config } from '../config';
import * as activityLogger from './activity-logger';

// ---- Token state ----
let accessToken = '';
let tokenExpiresAt = 0;

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string;
  to: string;
  receivedDateTime: string;
  snippet: string;
  body?: string;
  isRead: boolean;
  labels: string[];
  hasAttachments: boolean;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

// ------------------------------------------------------------------
// Configuration check
// ------------------------------------------------------------------
export function isConfigured(): boolean {
  return !!(config.GMAIL_CLIENT_ID && config.GMAIL_REFRESH_TOKEN);
}

// ------------------------------------------------------------------
// Token management
// ------------------------------------------------------------------
async function ensureAccessToken(): Promise<string> {
  // Refresh 5 minutes before expiry
  if (accessToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return accessToken;
  }

  if (!isConfigured()) {
    throw new Error('Gmail credentials not configured');
  }

  const params = new URLSearchParams({
    client_id: config.GMAIL_CLIENT_ID,
    client_secret: config.GMAIL_CLIENT_SECRET,
    refresh_token: config.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail token refresh failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log(`[Gmail] Access token refreshed, expires in ${data.expires_in}s`);
  return accessToken;
}

// ------------------------------------------------------------------
// Gmail API helper
// ------------------------------------------------------------------
async function gmailFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = await ensureAccessToken();
  const url = path.startsWith('http') ? path : `${GMAIL_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail API ${response.status}: ${errorText.substring(0, 500)}`);
  }

  if (response.status === 204) return null;

  return response.json();
}

// ------------------------------------------------------------------
// Base64url helpers
// ------------------------------------------------------------------
function base64urlDecode(str: string): string {
  // Convert base64url to base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function base64urlEncode(str: string): string {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ------------------------------------------------------------------
// Extract text body from message parts (recursive)
// ------------------------------------------------------------------
function extractTextBody(payload: any): string {
  if (!payload) return '';

  // Direct body on the payload
  if (payload.body?.data && payload.mimeType === 'text/plain') {
    return base64urlDecode(payload.body.data);
  }

  // Multipart: recurse into parts
  if (payload.parts) {
    // Prefer text/plain over text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return base64urlDecode(part.body.data);
      }
    }
    // Fall back to text/html stripped, or recurse deeper
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = base64urlDecode(part.body.data);
        // Basic HTML strip
        return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (part.parts) {
        const nested = extractTextBody(part);
        if (nested) return nested;
      }
    }
  }

  // Single-part message with body data
  if (payload.body?.data) {
    return base64urlDecode(payload.body.data);
  }

  return '';
}

// ------------------------------------------------------------------
// Parse headers from Gmail message
// ------------------------------------------------------------------
function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

function parseFromHeader(from: string): { name: string; email: string } {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].replace(/^"|"$/g, '').trim(), email: match[2] };
  }
  return { name: from, email: from };
}

// ------------------------------------------------------------------
// Check if message has attachments
// ------------------------------------------------------------------
function hasAttachmentParts(payload: any): boolean {
  if (!payload) return false;
  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) return true;
  if (payload.parts) {
    return payload.parts.some((p: any) => hasAttachmentParts(p));
  }
  return false;
}

// ------------------------------------------------------------------
// Convert raw Gmail message to our type
// ------------------------------------------------------------------
function parseMessage(raw: any, includeBody: boolean = false): GmailMessage {
  const headers = raw.payload?.headers || [];
  const from = parseFromHeader(getHeader(headers, 'From'));
  const dateStr = getHeader(headers, 'Date');

  return {
    id: raw.id,
    threadId: raw.threadId,
    subject: getHeader(headers, 'Subject') || '(no subject)',
    from: from.name,
    fromEmail: from.email,
    to: getHeader(headers, 'To'),
    receivedDateTime: dateStr || raw.internalDate ? new Date(parseInt(raw.internalDate)).toISOString() : '',
    snippet: raw.snippet || '',
    body: includeBody ? extractTextBody(raw.payload) : undefined,
    isRead: !(raw.labelIds || []).includes('UNREAD'),
    labels: raw.labelIds || [],
    hasAttachments: hasAttachmentParts(raw.payload),
  };
}

// ------------------------------------------------------------------
// Get inbox messages
// ------------------------------------------------------------------
export async function getInboxMessages(opts: {
  maxResults?: number;
  unreadOnly?: boolean;
} = {}): Promise<GmailMessage[]> {
  const { maxResults = 25, unreadOnly = false } = opts;

  const params = new URLSearchParams({
    maxResults: String(maxResults),
    labelIds: 'INBOX',
  });

  if (unreadOnly) {
    params.set('q', 'is:unread');
  }

  try {
    // Step 1: List message IDs
    const listData = await gmailFetch(`/messages?${params}`);
    const messageIds: string[] = (listData.messages || []).map((m: any) => m.id);

    if (messageIds.length === 0) {
      console.log('[Gmail] No inbox messages found');
      return [];
    }

    // Step 2: Batch-fetch message metadata (batches of 10)
    const messages: GmailMessage[] = [];
    const batchSize = 10;

    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = messageIds.slice(i, i + batchSize);
      const fetched = await Promise.all(
        batch.map(id =>
          gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`)
        )
      );
      for (const raw of fetched) {
        messages.push(parseMessage(raw));
      }
    }

    console.log(`[Gmail] Fetched ${messages.length} inbox messages (unreadOnly=${unreadOnly})`);
    return messages;
  } catch (err) {
    console.error('[Gmail] getInboxMessages failed:', (err as Error).message);
    throw err;
  }
}

// ------------------------------------------------------------------
// Get full message with body
// ------------------------------------------------------------------
export async function getMessage(messageId: string): Promise<GmailMessage> {
  try {
    const raw = await gmailFetch(`/messages/${messageId}?format=full`);
    return parseMessage(raw, true);
  } catch (err) {
    console.error('[Gmail] getMessage failed:', (err as Error).message);
    throw err;
  }
}

// ------------------------------------------------------------------
// Mark messages as read (remove UNREAD label)
// ------------------------------------------------------------------
export async function markAsRead(messageIds: string[], taskId?: number): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    try {
      await gmailFetch(`/messages/${id}/modify`, {
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      });
      count++;
    } catch (err) {
      console.error(`[Gmail] markAsRead failed for ${id}:`, (err as Error).message);
    }
  }

  if (count > 0) {
    console.log(`[Gmail] Marked ${count} messages as read`);
    await activityLogger.log({
      event_type: 'gmail_action',
      agent_id: 'wedding-planner',
      task_id: taskId,
      channel: 'gmail',
      summary: `Marked ${count} emails as read`,
    });
  }
  return count;
}

// ------------------------------------------------------------------
// Archive messages (remove INBOX label)
// ------------------------------------------------------------------
export async function archiveMessages(messageIds: string[], taskId?: number): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    try {
      await gmailFetch(`/messages/${id}/modify`, {
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
      });
      count++;
    } catch (err) {
      console.error(`[Gmail] archiveMessages failed for ${id}:`, (err as Error).message);
    }
  }

  if (count > 0) {
    console.log(`[Gmail] Archived ${count} messages`);
    await activityLogger.log({
      event_type: 'gmail_action',
      agent_id: 'wedding-planner',
      task_id: taskId,
      channel: 'gmail',
      summary: `Archived ${count} emails`,
    });
  }
  return count;
}

// ------------------------------------------------------------------
// Trash messages
// ------------------------------------------------------------------
export async function trashMessages(messageIds: string[], taskId?: number): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    try {
      await gmailFetch(`/messages/${id}/trash`, { method: 'POST' });
      count++;
    } catch (err) {
      console.error(`[Gmail] trashMessages failed for ${id}:`, (err as Error).message);
    }
  }

  if (count > 0) {
    console.log(`[Gmail] Trashed ${count} messages`);
    await activityLogger.log({
      event_type: 'gmail_action',
      agent_id: 'wedding-planner',
      task_id: taskId,
      channel: 'gmail',
      summary: `Trashed ${count} emails`,
    });
  }
  return count;
}

// ------------------------------------------------------------------
// Add label to messages
// ------------------------------------------------------------------
export async function addLabel(messageIds: string[], labelId: string, taskId?: number): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    try {
      await gmailFetch(`/messages/${id}/modify`, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: [labelId] }),
      });
      count++;
    } catch (err) {
      console.error(`[Gmail] addLabel failed for ${id}:`, (err as Error).message);
    }
  }

  if (count > 0) {
    console.log(`[Gmail] Added label "${labelId}" to ${count} messages`);
    await activityLogger.log({
      event_type: 'gmail_action',
      agent_id: 'wedding-planner',
      task_id: taskId,
      channel: 'gmail',
      summary: `Added label "${labelId}" to ${count} emails`,
    });
  }
  return count;
}

// ------------------------------------------------------------------
// Remove label from messages
// ------------------------------------------------------------------
export async function removeLabel(messageIds: string[], labelId: string, taskId?: number): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    try {
      await gmailFetch(`/messages/${id}/modify`, {
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: [labelId] }),
      });
      count++;
    } catch (err) {
      console.error(`[Gmail] removeLabel failed for ${id}:`, (err as Error).message);
    }
  }

  if (count > 0) {
    console.log(`[Gmail] Removed label "${labelId}" from ${count} messages`);
    await activityLogger.log({
      event_type: 'gmail_action',
      agent_id: 'wedding-planner',
      task_id: taskId,
      channel: 'gmail',
      summary: `Removed label "${labelId}" from ${count} emails`,
    });
  }
  return count;
}

// ------------------------------------------------------------------
// Get labels
// ------------------------------------------------------------------
export async function getLabels(): Promise<GmailLabel[]> {
  try {
    const data = await gmailFetch('/labels');
    const labels: GmailLabel[] = (data.labels || []).map((l: any) => ({
      id: l.id,
      name: l.name,
      type: l.type || 'user',
      messagesTotal: l.messagesTotal,
      messagesUnread: l.messagesUnread,
    }));

    console.log(`[Gmail] Fetched ${labels.length} labels`);
    return labels;
  } catch (err) {
    console.error('[Gmail] getLabels failed:', (err as Error).message);
    throw err;
  }
}

// ------------------------------------------------------------------
// Send email
// ------------------------------------------------------------------
export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  threadId?: string;
}, taskId?: number): Promise<{ id: string; threadId: string }> {
  const { to, subject, body, inReplyTo, threadId } = opts;

  // Build RFC 2822 MIME message
  const lines: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ];

  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${inReplyTo}`);
  }

  lines.push('', body);
  const rawMessage = lines.join('\r\n');
  const encoded = base64urlEncode(rawMessage);

  const payload: any = { raw: encoded };
  if (threadId) payload.threadId = threadId;

  try {
    const result = await gmailFetch('/messages/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    console.log(`[Gmail] Sent email to ${to}: "${subject}"`);
    await activityLogger.log({
      event_type: 'gmail_action',
      agent_id: 'wedding-planner',
      task_id: taskId,
      channel: 'gmail',
      summary: `Sent email to ${to}: "${subject}"`,
    });

    return { id: result.id, threadId: result.threadId };
  } catch (err) {
    console.error('[Gmail] sendEmail failed:', (err as Error).message);
    throw err;
  }
}

// ------------------------------------------------------------------
// Format messages for agent prompt injection
// ------------------------------------------------------------------
export function formatMessagesForAgent(messages: GmailMessage[]): string {
  if (messages.length === 0) return 'No messages found.';

  return messages.map((m, i) => {
    const readStatus = m.isRead ? 'Read' : 'UNREAD';
    const attachments = m.hasAttachments ? ' | Has attachments' : '';
    const received = m.receivedDateTime
      ? new Date(m.receivedDateTime).toLocaleString('en-US', {
          timeZone: 'America/Denver',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'Unknown date';

    return `[${i + 1}] From: ${m.from} <${m.fromEmail}> | Subject: ${m.subject} | ${received} | ${readStatus}${attachments}\n    Preview: ${m.snippet.substring(0, 120)}\n    ID: ${m.id} | Thread: ${m.threadId}`;
  }).join('\n\n');
}
