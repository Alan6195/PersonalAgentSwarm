import * as http from 'http';
import { config } from '../config';
import * as taskManager from './task-manager';
import * as activityLogger from './activity-logger';
import { getMemoryHealth } from './memory-health';
import { handleUserMessage } from '../agents/router';
import { query } from '../db';

interface ContactPayload {
  name: string;
  email?: string;
  phone?: string;
  message?: string;
  source?: string;
  // Extended fields from chat leads
  company?: string;
  team_size?: string;
  urgency?: string;
  lead_score?: number;
  lead_id?: string;
}

interface DashboardPayload {
  message: string;
  item_context?: {
    id: number;
    name: string;
    region: string;
    item_type: string;
  };
  notification?: boolean;
}

// Fixed chatId for dashboard conversations (separate from Telegram)
const DASHBOARD_CHAT_ID = -999;

type TelegramNotifier = (text: string) => Promise<void>;

let sendTelegramNotification: TelegramNotifier | null = null;

export function setTelegramNotifier(notifier: TelegramNotifier): void {
  sendTelegramNotification = notifier;
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 64 * 1024; // 64KB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Secret',
  });
  res.end(JSON.stringify(body));
}

function validatePayload(data: unknown): ContactPayload | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return null;

  const email = typeof obj.email === 'string' ? obj.email.trim() : undefined;
  const phone = typeof obj.phone === 'string' ? obj.phone.trim() : undefined;

  // Must have at least email or phone
  if (!email && !phone) return null;

  return {
    name,
    email: email || undefined,
    phone: phone || undefined,
    message: typeof obj.message === 'string' ? obj.message.trim() : undefined,
    source: typeof obj.source === 'string' ? obj.source.trim() : undefined,
    company: typeof obj.company === 'string' ? obj.company.trim() : undefined,
    team_size: typeof obj.team_size === 'string' ? obj.team_size.trim() : undefined,
    urgency: typeof obj.urgency === 'string' ? obj.urgency.trim() : undefined,
    lead_score: typeof obj.lead_score === 'number' ? obj.lead_score : undefined,
    lead_id: typeof obj.lead_id === 'string' ? obj.lead_id.trim() : undefined,
  };
}

async function handleContactWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // Verify webhook secret
  const secret = req.headers['x-webhook-secret'];
  if (secret !== config.WEBHOOK_SECRET) {
    console.log('[Webhook] Rejected: invalid secret');
    jsonResponse(res, 401, { success: false, error: 'Invalid webhook secret' });
    return;
  }

  // Parse and validate body
  let body: string;
  try {
    body = await parseBody(req);
  } catch {
    jsonResponse(res, 400, { success: false, error: 'Invalid request body' });
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { success: false, error: 'Invalid JSON' });
    return;
  }

  const payload = validatePayload(data);
  if (!payload) {
    jsonResponse(res, 400, {
      success: false,
      error: 'Missing required fields: name and (email or phone)',
    });
    return;
  }

  console.log(`[Webhook] Contact form submission from ${payload.name} (${payload.source || 'unknown source'})`);

  // Respond immediately (don't make the form wait for DB/Telegram)
  jsonResponse(res, 200, { success: true });

  // Log as task and notify async
  try {
    const task = await taskManager.createTask({
      title: `Lead: ${payload.name}`,
      description: `Contact form submission from ${payload.name}`,
      status: 'completed',
      priority: 'normal',
      assigned_agent: 'alan-os',
      domain: 'leads',
      input_summary: JSON.stringify(payload),
      metadata: {
        channel: 'webhook',
        source: payload.source || 'unknown',
        contact_name: payload.name,
        contact_email: payload.email,
        contact_phone: payload.phone,
        company: payload.company,
        team_size: payload.team_size,
        urgency: payload.urgency,
        lead_score: payload.lead_score,
        lead_id: payload.lead_id,
      },
    });

    await activityLogger.log({
      event_type: 'lead_received',
      agent_id: 'alan-os',
      task_id: task.id,
      channel: 'webhook',
      summary: `New lead: ${payload.name} via ${payload.source || 'contact form'}${payload.company ? ` (${payload.company})` : ''}`,
      metadata: {
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        source: payload.source,
        company: payload.company,
        team_size: payload.team_size,
        urgency: payload.urgency,
        lead_score: payload.lead_score,
        lead_id: payload.lead_id,
      },
    });

    // Send Telegram notification
    if (sendTelegramNotification) {
      const isChat = payload.source === 'chat';
      const lines = [
        isChat ? '\u{1F4AC} *New Chat Lead*' : '\u{1F4E8} *New Contact Form Lead*',
        '',
        `*Name:* ${payload.name}`,
      ];
      if (payload.email) lines.push(`*Email:* ${payload.email}`);
      if (payload.phone) lines.push(`*Phone:* ${payload.phone}`);
      if (payload.company) lines.push(`*Company:* ${payload.company}`);
      if (payload.team_size) lines.push(`*Team Size:* ${payload.team_size}`);
      if (payload.urgency) lines.push(`*Urgency:* ${payload.urgency}`);
      if (payload.lead_score != null) lines.push(`*Lead Score:* ${payload.lead_score}/100`);
      if (payload.source) lines.push(`*Source:* ${payload.source}`);
      if (payload.message) {
        lines.push('');
        lines.push(`*Message:*`);
        lines.push(payload.message);
      }

      await sendTelegramNotification(lines.join('\n'));
    }

    console.log(`[Webhook] Lead processed: ${payload.name} (task #${task.id})`);
  } catch (err) {
    // Don't let async processing errors affect the response (already sent 200)
    console.error('[Webhook] Error processing lead:', (err as Error).message);
  }
}

async function handleDashboardWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // Verify webhook secret
  const secret = req.headers['x-webhook-secret'];
  if (secret !== config.WEBHOOK_SECRET) {
    console.log('[Webhook] Dashboard rejected: invalid secret');
    jsonResponse(res, 401, { success: false, error: 'Invalid webhook secret' });
    return;
  }

  // Parse body
  let body: string;
  try {
    body = await parseBody(req);
  } catch {
    jsonResponse(res, 400, { success: false, error: 'Invalid request body' });
    return;
  }

  let data: DashboardPayload;
  try {
    data = JSON.parse(body) as DashboardPayload;
  } catch {
    jsonResponse(res, 400, { success: false, error: 'Invalid JSON' });
    return;
  }

  if (!data.message || typeof data.message !== 'string') {
    jsonResponse(res, 400, { success: false, error: 'message field is required' });
    return;
  }

  const message = data.message.trim();
  console.log(`[Webhook] Dashboard message: "${message.substring(0, 80)}"`);

  // If this is just a notification (approve/veto echo), send to Telegram and return
  if (data.notification) {
    try {
      if (sendTelegramNotification) {
        await sendTelegramNotification(message);
      }
      jsonResponse(res, 200, { success: true });
    } catch (err) {
      console.error('[Webhook] Telegram notification error:', (err as Error).message);
      jsonResponse(res, 200, { success: true }); // Don't fail on notification errors
    }
    return;
  }

  // Build the agent message; if item_context provided, compose a richer prompt
  let agentMessage = message;
  if (data.item_context) {
    const ctx = data.item_context;
    agentMessage = `${message}\n\n[Context: This is about "${ctx.name}" (${ctx.item_type}) in ${ctx.region}, item ID ${ctx.id}]`;
  }

  try {
    // Get trip ID for storing messages
    const tripRows = await query(
      `SELECT id FROM travel_trips WHERE trip_id = 'portugal-honeymoon-2026' LIMIT 1`
    );
    const tripDbId = tripRows.length > 0 ? tripRows[0].id : null;

    // Store user message
    if (tripDbId) {
      await query(
        `INSERT INTO dashboard_messages (trip_db_id, direction, content, item_id, action_type)
         VALUES ($1, 'user', $2, $3, $4)`,
        [tripDbId, message, data.item_context?.id || null, 'chat']
      );
    }

    // Route through the full agent pipeline
    const response = await handleUserMessage(agentMessage, 0, DASHBOARD_CHAT_ID);

    // Store agent response
    let messageId: number | null = null;
    if (tripDbId) {
      const inserted = await query(
        `INSERT INTO dashboard_messages (trip_db_id, direction, content, action_type)
         VALUES ($1, 'agent', $2, 'chat') RETURNING id`,
        [tripDbId, response]
      );
      messageId = inserted.length > 0 ? inserted[0].id : null;
    }

    // Echo to Telegram
    if (sendTelegramNotification) {
      try {
        const telegramMsg = `\u{1F4BB} *Dashboard*\n_${message.substring(0, 100)}_\n\n${response}`;
        await sendTelegramNotification(telegramMsg);
      } catch (err) {
        console.error('[Webhook] Telegram echo error:', (err as Error).message);
      }
    }

    jsonResponse(res, 200, {
      success: true,
      response,
      message_id: messageId,
    });
  } catch (err) {
    console.error('[Webhook] Dashboard message error:', (err as Error).message);
    jsonResponse(res, 500, {
      success: false,
      error: 'Failed to process message',
      details: (err as Error).message,
    });
  }
}

export function startWebhookServer(): http.Server {
  const port = config.WEBHOOK_PORT;

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      jsonResponse(res, 200, {});
      return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      jsonResponse(res, 200, { status: 'ok' });
      return;
    }

    // Memory health dashboard
    if (req.method === 'GET' && req.url === '/memory/health') {
      try {
        const report = await getMemoryHealth();
        jsonResponse(res, 200, report as unknown as Record<string, unknown>);
      } catch (err) {
        jsonResponse(res, 500, { error: 'Failed to generate memory health report', details: (err as Error).message });
      }
      return;
    }

    // Contact form webhook
    if (req.method === 'POST' && req.url === '/api/webhooks/contact') {
      await handleContactWebhook(req, res);
      return;
    }

    // Dashboard message webhook
    if (req.method === 'POST' && req.url === '/api/webhooks/dashboard') {
      await handleDashboardWebhook(req, res);
      return;
    }

    // 404 for everything else
    jsonResponse(res, 404, { error: 'Not found' });
  });

  server.listen(port, () => {
    console.log(`[Webhook] Server listening on port ${port}`);
  });

  return server;
}
