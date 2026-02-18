/**
 * Microsoft 365 — Direct Graph API Client
 *
 * Calls Microsoft Graph API directly using fetch().
 * No MCP server, no subprocess spawning, no libuv crashes.
 *
 * Auth: reads the refresh token from the MSAL cache file
 * (created by @softeria/ms-365-mcp-server --login) and
 * exchanges it for a fresh access token via the OAuth2 endpoint.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const CLIENT_ID = process.env.MS365_MCP_CLIENT_ID || "4e867585-b915-4309-8683-7e5b2df4513c";
const TENANT_ID = process.env.MS365_MCP_TENANT_ID || "c5076972-58d0-45f3-bc1c-25cd8d4821ed";
const TOKEN_CACHE_PATH = process.env.MS365_TOKEN_CACHE_PATH ||
  join(process.env.USERPROFILE || process.env.HOME || "~", ".ms365-tokens", ".token-cache.json");
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let cachedAccessToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Read the refresh token from the MSAL cache file.
 */
async function getRefreshToken(): Promise<string> {
  const raw = await readFile(TOKEN_CACHE_PATH, "utf-8");
  const cache = JSON.parse(raw);
  const rtKeys = Object.keys(cache.RefreshToken || {});
  if (!rtKeys.length) throw new Error("No refresh token in cache");
  return cache.RefreshToken[rtKeys[0]].secret;
}

/**
 * Exchange refresh token for a new access token.
 * Updates the cache file with the new refresh token (rotation).
 */
async function refreshAccessToken(): Promise<string> {
  const refreshToken = await getRefreshToken();

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: "Mail.ReadWrite Mail.Send Calendars.ReadWrite User.Read offline_access",
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${err}`);
  }

  const data = await resp.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  // Cache the access token in memory
  cachedAccessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // 60s buffer

  // If refresh token rotated, update the cache file
  if (data.refresh_token) {
    try {
      const raw = await readFile(TOKEN_CACHE_PATH, "utf-8");
      const cache = JSON.parse(raw);
      const rtKeys = Object.keys(cache.RefreshToken || {});
      if (rtKeys.length) {
        cache.RefreshToken[rtKeys[0]].secret = data.refresh_token;
        await writeFile(TOKEN_CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
      }
    } catch (e) {
      console.error("Warning: could not update refresh token cache:", e);
    }
  }

  return data.access_token;
}

/**
 * Get a valid access token (cached or refreshed).
 */
async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiry) {
    return cachedAccessToken;
  }
  return refreshAccessToken();
}

/**
 * Make an authenticated request to Microsoft Graph API.
 */
async function graphRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    params?: Record<string, string>;
  } = {}
): Promise<unknown> {
  const token = await getAccessToken();
  const { method = "GET", body, headers = {}, params } = options;

  let url = `${GRAPH_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Graph API error (${resp.status}): ${err.substring(0, 300)}`);
  }

  // Some endpoints return 204 No Content
  if (resp.status === 204) return { success: true };

  return resp.json();
}

// ============================================================
// PUBLIC API — Called by the relay
// ============================================================

export interface Email {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  preview: string;
  isRead: boolean;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  organizer: string;
  status: string;
  isOnline: boolean;
  onlineUrl?: string;
}

/**
 * List recent emails.
 */
export async function listEmails(count: number = 10): Promise<Email[]> {
  const data = await graphRequest("/me/messages", {
    params: {
      $top: String(count),
      $select: "id,subject,from,receivedDateTime,bodyPreview,isRead",
      $orderby: "receivedDateTime desc",
    },
  }) as { value: any[] };

  return (data.value || []).map((m: any) => ({
    id: m.id,
    subject: m.subject || "(no subject)",
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "unknown",
    receivedAt: m.receivedDateTime,
    preview: m.bodyPreview?.substring(0, 200) || "",
    isRead: m.isRead,
  }));
}

/**
 * Read a specific email by ID.
 */
export async function readEmail(messageId: string): Promise<{ subject: string; from: string; body: string; receivedAt: string }> {
  const m = await graphRequest(`/me/messages/${messageId}`, {
    params: { $select: "subject,from,body,receivedDateTime" },
  }) as any;

  return {
    subject: m.subject || "(no subject)",
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "unknown",
    body: m.body?.content || "",
    receivedAt: m.receivedDateTime,
  };
}

/**
 * Search emails by query string.
 */
export async function searchEmails(query: string, count: number = 5): Promise<Email[]> {
  const data = await graphRequest("/me/messages", {
    params: {
      $top: String(count),
      $search: `"${query}"`,
      $select: "id,subject,from,receivedDateTime,bodyPreview,isRead",
    },
  }) as { value: any[] };

  return (data.value || []).map((m: any) => ({
    id: m.id,
    subject: m.subject || "(no subject)",
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "unknown",
    receivedAt: m.receivedDateTime,
    preview: m.bodyPreview?.substring(0, 200) || "",
    isRead: m.isRead,
  }));
}

/**
 * List calendar events for a date range.
 */
export async function listCalendarEvents(
  startDate?: string,
  endDate?: string,
  count: number = 20
): Promise<CalendarEvent[]> {
  // Default: today
  const tz = process.env.USER_TIMEZONE || "America/New_York";
  const now = new Date();
  const start = startDate || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end = endDate || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const data = await graphRequest("/me/calendarView", {
    params: {
      startDateTime: start,
      endDateTime: end,
      $top: String(count),
      $select: "id,subject,start,end,location,organizer,responseStatus,isOnlineMeeting,onlineMeeting",
      $orderby: "start/dateTime",
    },
    headers: {
      Prefer: `outlook.timezone="${tz}"`,
    },
  }) as { value: any[] };

  return (data.value || []).map((e: any) => ({
    id: e.id,
    subject: e.subject || "(no subject)",
    start: e.start?.dateTime || "",
    end: e.end?.dateTime || "",
    location: e.location?.displayName || "",
    organizer: e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || "",
    status: e.responseStatus?.response || "none",
    isOnline: e.isOnlineMeeting || false,
    onlineUrl: e.onlineMeeting?.joinUrl || undefined,
  }));
}

/**
 * Create a calendar event.
 */
export async function createCalendarEvent(params: {
  subject: string;
  startDateTime: string;
  endDateTime: string;
  timeZone?: string;
  location?: string;
  body?: string;
  attendees?: Array<{ email: string; name?: string }>;
}): Promise<{ id: string; subject: string }> {
  const tz = params.timeZone || process.env.USER_TIMEZONE || "America/New_York";

  const eventBody: any = {
    subject: params.subject,
    start: { dateTime: params.startDateTime, timeZone: tz },
    end: { dateTime: params.endDateTime, timeZone: tz },
  };

  if (params.location) eventBody.location = { displayName: params.location };
  if (params.body) eventBody.body = { contentType: "Text", content: params.body };
  if (params.attendees?.length) {
    eventBody.attendees = params.attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name || a.email },
      type: "required",
    }));
  }

  const result = await graphRequest("/me/events", {
    method: "POST",
    body: eventBody,
  }) as any;

  return { id: result.id, subject: result.subject };
}

/**
 * Accept a calendar event.
 */
export async function acceptCalendarEvent(eventId: string, comment?: string): Promise<void> {
  await graphRequest(`/me/events/${eventId}/accept`, {
    method: "POST",
    body: { comment: comment || "", sendResponse: true },
  });
}

/**
 * Decline a calendar event.
 */
export async function declineCalendarEvent(eventId: string, comment?: string): Promise<void> {
  await graphRequest(`/me/events/${eventId}/decline`, {
    method: "POST",
    body: { comment: comment || "", sendResponse: true },
  });
}

/**
 * Send an email.
 */
export async function sendEmail(params: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
}): Promise<void> {
  await graphRequest("/me/sendMail", {
    method: "POST",
    body: {
      message: {
        subject: params.subject,
        body: { contentType: "Text", content: params.body },
        toRecipients: params.to.map(addr => ({ emailAddress: { address: addr } })),
        ccRecipients: (params.cc || []).map(addr => ({ emailAddress: { address: addr } })),
      },
      saveToSentItems: true,
    },
  });
}

/**
 * Create a draft email (saves to Drafts folder without sending).
 */
export async function createDraft(params: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
}): Promise<{ id: string; subject: string }> {
  const result = await graphRequest("/me/messages", {
    method: "POST",
    body: {
      subject: params.subject,
      body: { contentType: "Text", content: params.body },
      toRecipients: params.to.map(addr => ({ emailAddress: { address: addr } })),
      ccRecipients: (params.cc || []).map(addr => ({ emailAddress: { address: addr } })),
    },
  }) as any;

  return { id: result.id, subject: result.subject };
}

/**
 * Process a natural language MS365 request using Claude.
 * Claude gets the available functions and figures out which to call.
 */
export async function handleMs365Request(userMessage: string, recentHistory: string): Promise<string> {
  try {
    // First, gather context based on what the user seems to want
    const msg = userMessage.toLowerCase();
    let context = "";

    // Fetch relevant data
    if (msg.match(/\b(calendars?|schedule|meetings?|events?|agenda|appointments?|what'?s on)\b/i)) {
      const events = await listCalendarEvents();
      if (events.length) {
        context += "TODAY'S CALENDAR:\n" + events.map(e => {
          const start = new Date(e.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
          const end = new Date(e.end).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
          return `- ${start}-${end}: ${e.subject} (organizer: ${e.organizer}, status: ${e.status})${e.isOnline ? " [Teams]" : ""}`;
        }).join("\n");
      } else {
        context += "TODAY'S CALENDAR: No events found.";
      }
    }

    if (msg.match(/\b(emails?|e-?mails?|mails?|inbox|messages?|correio|caixa de entrada)\b/i)) {
      const emails = await listEmails(10);
      if (emails.length) {
        context += "\nRECENT EMAILS:\n" + emails.map(e => {
          const date = new Date(e.receivedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          return `- [${e.isRead ? "read" : "UNREAD"}] ${date} — From: ${e.from} — Subject: ${e.subject}\n  Preview: ${e.preview.substring(0, 100)}`;
        }).join("\n");
      } else {
        context += "\nRECENT EMAILS: No emails found.";
      }
    }

    // For create/add/accept actions, try to do them directly
    if (msg.match(/\b(add|create|schedule|book)\b/i) && msg.match(/\b(calendar|meeting|event|lunch|dinner|call)\b|at\s+\d|noon|morning|afternoon/i)) {
      // Let Claude parse the details and we'll create the event
      // For now, pass the context and let Claude respond
      context += "\n\nACTION AVAILABLE: You can create calendar events. Extract the details (subject, date, time, duration) from the user's message and respond with the event details. If you have enough info, include this tag: [CREATE_EVENT: subject | start_datetime | end_datetime | timezone]";
    }

    if (msg.match(/\b(accept|confirm|rsvp)\b/i) && msg.match(/\b(meeting|event|invite|calendar)\b/i)) {
      context += "\n\nACTION AVAILABLE: You can accept calendar events. Include this tag: [ACCEPT_EVENT: event_subject_search_text]";
    }

    if (msg.match(/\b(draft|save.{0,10}draft|add.{0,10}draft)\b/i)) {
      context += "\n\nACTION AVAILABLE: You can save emails to the Drafts folder. Include this tag: [CREATE_DRAFT: recipient@email.com | Subject line | Email body text]";
    }

    return context || "No relevant MS365 data found for this request.";
  } catch (error: any) {
    console.error("MS365 direct API error:", error.message);
    if (error.message.includes("Token refresh failed")) {
      return "ERROR: MS365 authentication expired. You need to re-login by running: npx @softeria/ms-365-mcp-server --login";
    }
    return `ERROR: ${error.message}`;
  }
}
