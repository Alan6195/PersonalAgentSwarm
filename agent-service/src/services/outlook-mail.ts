import { config } from '../config';
import * as activityLogger from './activity-logger';

// ---- Token state ----
let accessToken = '';
let tokenExpiresAt = 0;

// ---- Folder cache ----
let folderCache: Map<string, string> | null = null;

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

// Well-known folder IDs (no API call needed)
const WELL_KNOWN_FOLDERS: Record<string, string> = {
  inbox: 'inbox',
  archive: 'archive',
  deleteditems: 'deleteditems',
  drafts: 'drafts',
  junkemail: 'junkemail',
  sentitems: 'sentitems',
};

export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
  receivedDateTime: string;
  bodyPreview: string;
  body?: string;
  isRead: boolean;
  importance: string;
  hasAttachments: boolean;
  categories: string[];
}

export interface MailFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

// ------------------------------------------------------------------
// Configuration check
// ------------------------------------------------------------------
export function isConfigured(): boolean {
  return !!(config.MS_CLIENT_ID && config.MS_REFRESH_TOKEN);
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
    throw new Error('Microsoft Graph credentials not configured');
  }

  const params = new URLSearchParams({
    client_id: config.MS_CLIENT_ID,
    client_secret: config.MS_CLIENT_SECRET,
    refresh_token: config.MS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
    scope: 'offline_access Mail.ReadWrite User.Read',
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log(`[Outlook] Access token refreshed, expires in ${data.expires_in}s`);
  return accessToken;
}

// ------------------------------------------------------------------
// Graph API helper
// ------------------------------------------------------------------
async function graphFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = await ensureAccessToken();
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

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
    throw new Error(`Graph API ${response.status}: ${errorText.substring(0, 500)}`);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) return null;

  return response.json();
}

// ------------------------------------------------------------------
// Get inbox messages
// ------------------------------------------------------------------
export async function getInboxMessages(opts: {
  top?: number;
  unreadOnly?: boolean;
} = {}): Promise<EmailMessage[]> {
  const { top = 25, unreadOnly = false } = opts;

  const params = new URLSearchParams({
    $top: String(top),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead,importance,hasAttachments,categories',
  });

  if (unreadOnly) {
    params.set('$filter', 'isRead eq false');
  }

  try {
    const data = await graphFetch(`/me/mailFolders/inbox/messages?${params}`);
    const messages: EmailMessage[] = (data.value || []).map((m: any) => ({
      id: m.id,
      subject: m.subject || '(no subject)',
      from: m.from?.emailAddress?.name || 'Unknown',
      fromEmail: m.from?.emailAddress?.address || '',
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.bodyPreview || '',
      isRead: m.isRead,
      importance: m.importance || 'normal',
      hasAttachments: m.hasAttachments || false,
      categories: m.categories || [],
    }));

    console.log(`[Outlook] Fetched ${messages.length} inbox messages (unreadOnly=${unreadOnly})`);
    return messages;
  } catch (err) {
    console.error('[Outlook] getInboxMessages failed:', (err as Error).message);
    throw err;
  }
}

// ------------------------------------------------------------------
// Get full message body
// ------------------------------------------------------------------
export async function getMessage(messageId: string): Promise<EmailMessage> {
  try {
    const m = await graphFetch(`/me/messages/${messageId}`, {
      headers: { Prefer: 'outlook.body-content-type="text"' },
    });

    return {
      id: m.id,
      subject: m.subject || '(no subject)',
      from: m.from?.emailAddress?.name || 'Unknown',
      fromEmail: m.from?.emailAddress?.address || '',
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.bodyPreview || '',
      body: m.body?.content || '',
      isRead: m.isRead,
      importance: m.importance || 'normal',
      hasAttachments: m.hasAttachments || false,
      categories: m.categories || [],
    };
  } catch (err) {
    console.error('[Outlook] getMessage failed:', (err as Error).message);
    throw err;
  }
}

// ------------------------------------------------------------------
// Mark messages as read
// ------------------------------------------------------------------
export async function markAsRead(messageIds: string[], taskId?: number): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    try {
      await graphFetch(`/me/messages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isRead: true }),
      });
      count++;
    } catch (err) {
      console.error(`[Outlook] markAsRead failed for ${id}:`, (err as Error).message);
    }
  }

  if (count > 0) {
    console.log(`[Outlook] Marked ${count} messages as read`);
    await activityLogger.log({
      event_type: 'email_action',
      agent_id: 'life-admin',
      task_id: taskId,
      channel: 'email',
      summary: `Marked ${count} emails as read`,
    });
  }
  return count;
}

// ------------------------------------------------------------------
// Mark messages as unread
// ------------------------------------------------------------------
export async function markAsUnread(messageIds: string[], taskId?: number): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    try {
      await graphFetch(`/me/messages/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isRead: false }),
      });
      count++;
    } catch (err) {
      console.error(`[Outlook] markAsUnread failed for ${id}:`, (err as Error).message);
    }
  }

  if (count > 0) {
    console.log(`[Outlook] Marked ${count} messages as unread`);
    await activityLogger.log({
      event_type: 'email_action',
      agent_id: 'life-admin',
      task_id: taskId,
      channel: 'email',
      summary: `Marked ${count} emails as unread`,
    });
  }
  return count;
}

// ------------------------------------------------------------------
// Resolve folder name to ID
// ------------------------------------------------------------------
async function resolveFolderId(folderName: string): Promise<string> {
  const lowerName = folderName.toLowerCase().replace(/\s+/g, '');

  // Check well-known folders first
  if (WELL_KNOWN_FOLDERS[lowerName]) {
    return WELL_KNOWN_FOLDERS[lowerName];
  }

  // Load folder cache if needed
  if (!folderCache) {
    const folders = await getMailFolders();
    folderCache = new Map();
    for (const f of folders) {
      folderCache.set(f.displayName.toLowerCase().replace(/\s+/g, ''), f.id);
    }
  }

  const folderId = folderCache.get(lowerName);
  if (!folderId) {
    throw new Error(`Unknown folder: "${folderName}". Use list_folders to see available folders.`);
  }
  return folderId;
}

// ------------------------------------------------------------------
// Move messages to a folder
// ------------------------------------------------------------------
export async function moveToFolder(
  messageIds: string[],
  folder: string,
  taskId?: number
): Promise<number> {
  const destinationId = await resolveFolderId(folder);
  let count = 0;

  for (const id of messageIds) {
    try {
      await graphFetch(`/me/messages/${id}/move`, {
        method: 'POST',
        body: JSON.stringify({ destinationId }),
      });
      count++;
    } catch (err) {
      console.error(`[Outlook] moveToFolder failed for ${id}:`, (err as Error).message);
    }
  }

  if (count > 0) {
    console.log(`[Outlook] Moved ${count} messages to ${folder}`);
    await activityLogger.log({
      event_type: 'email_action',
      agent_id: 'life-admin',
      task_id: taskId,
      channel: 'email',
      summary: `Moved ${count} emails to ${folder}`,
    });
  }
  return count;
}

// ------------------------------------------------------------------
// Delete messages (soft: move to deleted items)
// ------------------------------------------------------------------
export async function deleteMessages(messageIds: string[], taskId?: number): Promise<number> {
  const count = await moveToFolder(messageIds, 'deleteditems', taskId);
  if (count > 0) {
    console.log(`[Outlook] Deleted ${count} messages (moved to trash)`);
  }
  return count;
}

// ------------------------------------------------------------------
// Get mail folders
// ------------------------------------------------------------------
export async function getMailFolders(): Promise<MailFolder[]> {
  try {
    const data = await graphFetch('/me/mailFolders?$top=50');
    const folders: MailFolder[] = (data.value || []).map((f: any) => ({
      id: f.id,
      displayName: f.displayName,
      totalItemCount: f.totalItemCount || 0,
      unreadItemCount: f.unreadItemCount || 0,
    }));

    console.log(`[Outlook] Fetched ${folders.length} mail folders`);
    return folders;
  } catch (err) {
    console.error('[Outlook] getMailFolders failed:', (err as Error).message);
    throw err;
  }
}

// ------------------------------------------------------------------
// Format messages for agent prompt injection
// ------------------------------------------------------------------
export function formatMessagesForAgent(messages: EmailMessage[]): string {
  if (messages.length === 0) return 'No messages found.';

  return messages.map((m, i) => {
    const readStatus = m.isRead ? 'Read' : 'UNREAD';
    const importance = m.importance !== 'normal' ? ` | ${m.importance.toUpperCase()}` : '';
    const attachments = m.hasAttachments ? ' | Has attachments' : '';
    const received = new Date(m.receivedDateTime).toLocaleString('en-US', {
      timeZone: 'America/Denver',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    return `[${i + 1}] From: ${m.from} <${m.fromEmail}> | Subject: ${m.subject} | ${received} | ${readStatus}${importance}${attachments}\n    Preview: ${m.bodyPreview.substring(0, 120)}\n    ID: ${m.id}`;
  }).join('\n\n');
}
