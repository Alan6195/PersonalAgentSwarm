/**
 * Google Calendar Service
 *
 * Provides read access to Alan's Google Calendar via REST API.
 * Uses the same OAuth2 refresh token pattern as gmail-mail.ts.
 * Calendar events are injected into agent context for scheduling awareness.
 */

import { config } from '../config';

// ---- Token state (shared OAuth2 credentials with Gmail if same project) ----
let accessToken = '';
let tokenExpiresAt = 0;

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  status: string;
  attendees: string[];
  meetLink?: string;
}

// ------------------------------------------------------------------
// Configuration check
// ------------------------------------------------------------------
export function isConfigured(): boolean {
  return !!(config.GOOGLE_CALENDAR_CLIENT_ID && config.GOOGLE_CALENDAR_REFRESH_TOKEN);
}

// ------------------------------------------------------------------
// Token management
// ------------------------------------------------------------------
async function ensureAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return accessToken;
  }

  if (!isConfigured()) {
    throw new Error('Google Calendar credentials not configured');
  }

  const params = new URLSearchParams({
    client_id: config.GOOGLE_CALENDAR_CLIENT_ID,
    client_secret: config.GOOGLE_CALENDAR_CLIENT_SECRET,
    refresh_token: config.GOOGLE_CALENDAR_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Calendar token refresh failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log(`[Calendar] Access token refreshed, expires in ${data.expires_in}s`);
  return accessToken;
}

// ------------------------------------------------------------------
// Calendar API helper
// ------------------------------------------------------------------
async function calendarFetch(path: string, params?: Record<string, string>): Promise<any> {
  const token = await ensureAccessToken();
  const url = new URL(`${CALENDAR_BASE}${path}`);

  if (params) {
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, val);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Calendar API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ------------------------------------------------------------------
// Parse event from API response
// ------------------------------------------------------------------
function parseEvent(item: any): CalendarEvent {
  const isAllDay = !!item.start?.date;
  const startTime = isAllDay ? item.start.date : item.start?.dateTime || '';
  const endTime = isAllDay ? item.end.date : item.end?.dateTime || '';

  const attendees = (item.attendees || [])
    .filter((a: any) => !a.self)
    .map((a: any) => a.displayName || a.email || 'unknown');

  const meetLink = item.conferenceData?.entryPoints?.find(
    (e: any) => e.entryPointType === 'video'
  )?.uri;

  return {
    id: item.id || '',
    summary: item.summary || '(No title)',
    description: item.description,
    location: item.location,
    startTime,
    endTime,
    allDay: isAllDay,
    status: item.status || 'confirmed',
    attendees,
    meetLink,
  };
}

// ------------------------------------------------------------------
// Get upcoming events
// ------------------------------------------------------------------
export async function getUpcomingEvents(days: number = 3): Promise<CalendarEvent[]> {
  const calendarId = config.GOOGLE_CALENDAR_ID || 'primary';
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const data = await calendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  const events: CalendarEvent[] = (data.items || [])
    .filter((item: any) => item.status !== 'cancelled')
    .map(parseEvent);

  console.log(`[Calendar] Fetched ${events.length} events for next ${days} days`);
  return events;
}

// ------------------------------------------------------------------
// Get events for a specific date
// ------------------------------------------------------------------
export async function getEventsForDate(date: Date): Promise<CalendarEvent[]> {
  const calendarId = config.GOOGLE_CALENDAR_ID || 'primary';
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const data = await calendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '25',
  });

  const events: CalendarEvent[] = (data.items || [])
    .filter((item: any) => item.status !== 'cancelled')
    .map(parseEvent);

  console.log(`[Calendar] Fetched ${events.length} events for ${date.toLocaleDateString()}`);
  return events;
}

// ------------------------------------------------------------------
// Get today's events (convenience)
// ------------------------------------------------------------------
export async function getTodaysEvents(): Promise<CalendarEvent[]> {
  return getEventsForDate(new Date());
}

// ------------------------------------------------------------------
// Format events for agent context injection
// ------------------------------------------------------------------
export function formatEventsForAgent(events: CalendarEvent[]): string {
  if (events.length === 0) return 'No events scheduled.';

  const lines: string[] = [];
  let currentDate = '';

  for (const event of events) {
    // Group by date
    const eventDate = event.allDay
      ? event.startTime
      : new Date(event.startTime).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });

    if (eventDate !== currentDate) {
      if (currentDate) lines.push('');
      lines.push(`**${eventDate}**`);
      currentDate = eventDate;
    }

    if (event.allDay) {
      lines.push(`  All day: ${event.summary}`);
    } else {
      const startStr = new Date(event.startTime).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Denver',
      });
      const endStr = new Date(event.endTime).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Denver',
      });
      lines.push(`  ${startStr}-${endStr}: ${event.summary}`);
    }

    if (event.location) lines.push(`    Location: ${event.location}`);
    if (event.meetLink) lines.push(`    Meet: ${event.meetLink}`);
    if (event.attendees.length > 0) {
      lines.push(`    With: ${event.attendees.join(', ')}`);
    }
    if (event.description) {
      const shortDesc = event.description.substring(0, 150).replace(/\n/g, ' ');
      lines.push(`    Note: ${shortDesc}`);
    }
  }

  return lines.join('\n');
}
