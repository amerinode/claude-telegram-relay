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

const CLIENT_ID = process.env.MS365_MCP_CLIENT_ID || "084a3e9f-a9f4-43f7-89f9-d229cf97853e";
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
    scope: "Mail.ReadWrite Mail.Send Calendars.ReadWrite OnlineMeetingTranscript.Read.All User.Read offline_access",
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

// ============================================================
// TEAMS MEETING TRANSCRIPTS
// ============================================================

interface TranscriptInfo {
  id: string;
  meetingId: string;
  createdDateTime: string;
}

/**
 * Find the online meeting ID by join URL.
 * Calendar events have a joinUrl; the transcript API needs the meeting ID.
 */
async function getOnlineMeetingByJoinUrl(joinUrl: string): Promise<string | null> {
  try {
    const data = await graphRequest("/me/onlineMeetings", {
      params: {
        $filter: `JoinWebUrl eq '${joinUrl}'`,
      },
    }) as { value: any[] };
    return data.value?.[0]?.id || null;
  } catch (e: any) {
    console.error("Failed to find online meeting:", e.message);
    return null;
  }
}

/**
 * List transcripts for an online meeting.
 */
async function listMeetingTranscripts(onlineMeetingId: string): Promise<TranscriptInfo[]> {
  const data = await graphRequest(
    `/me/onlineMeetings/${onlineMeetingId}/transcripts`,
    {}
  ) as { value: any[] };

  return (data.value || []).map((t: any) => ({
    id: t.id,
    meetingId: t.meetingId,
    createdDateTime: t.createdDateTime,
  }));
}

/**
 * Get transcript content as VTT text and parse it into readable format.
 */
async function getTranscriptContent(onlineMeetingId: string, transcriptId: string): Promise<string> {
  const token = await getAccessToken();
  const url = `${GRAPH_BASE}/me/onlineMeetings/${onlineMeetingId}/transcripts/${transcriptId}/content?$format=text/vtt`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/vtt",
    },
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Transcript fetch failed (${resp.status}): ${err.substring(0, 300)}`);
  }

  return resp.text();
}

/**
 * Parse VTT transcript into readable speaker/text format.
 * VTT format:
 *   WEBVTT
 *   00:00:00.000 --> 00:00:05.000
 *   <v Speaker Name>Some text here</v>
 */
function parseVtt(vtt: string): Array<{ speaker: string; text: string; time: string }> {
  const entries: Array<{ speaker: string; text: string; time: string }> = [];
  const lines = vtt.split("\n");

  let currentTime = "";
  for (const line of lines) {
    const trimmed = line.trim();

    // Timestamp line: 00:00:00.000 --> 00:00:05.000
    const timeMatch = trimmed.match(/^(\d{2}:\d{2}:\d{2})\.\d+ -->/);
    if (timeMatch) {
      currentTime = timeMatch[1];
      continue;
    }

    // Speaker line: <v Speaker Name>text</v>
    const speakerMatch = trimmed.match(/^<v\s+([^>]+)>(.+?)(?:<\/v>)?$/);
    if (speakerMatch) {
      entries.push({
        speaker: speakerMatch[1].trim(),
        text: speakerMatch[2].trim(),
        time: currentTime,
      });
      continue;
    }

    // Plain text line (no speaker tag, but has content after a timestamp)
    if (trimmed && currentTime && !trimmed.startsWith("WEBVTT") && !trimmed.startsWith("NOTE")) {
      const lastEntry = entries[entries.length - 1];
      if (lastEntry && lastEntry.time === currentTime) {
        lastEntry.text += " " + trimmed;
      } else if (trimmed.length > 1) {
        entries.push({ speaker: "Unknown", text: trimmed, time: currentTime });
      }
    }
  }

  return entries;
}

/**
 * Fetch transcript for a Teams meeting, given the calendar event's join URL.
 * Returns formatted transcript text or null if no transcript available.
 */
export async function getMeetingTranscript(joinUrl: string, subject: string): Promise<string | null> {
  try {
    const meetingId = await getOnlineMeetingByJoinUrl(joinUrl);
    if (!meetingId) {
      console.log(`No online meeting found for: ${subject}`);
      return null;
    }

    const transcripts = await listMeetingTranscripts(meetingId);
    if (!transcripts.length) {
      console.log(`No transcripts for meeting: ${subject}`);
      return null;
    }

    // Get the most recent transcript
    const latest = transcripts[transcripts.length - 1];
    const vttContent = await getTranscriptContent(meetingId, latest.id);
    const parsed = parseVtt(vttContent);

    if (!parsed.length) return null;

    // Format: consolidate consecutive lines from same speaker
    const consolidated: Array<{ speaker: string; text: string; time: string }> = [];
    for (const entry of parsed) {
      const last = consolidated[consolidated.length - 1];
      if (last && last.speaker === entry.speaker) {
        last.text += " " + entry.text;
      } else {
        consolidated.push({ ...entry });
      }
    }

    // Limit to avoid blowing up context
    const maxEntries = 60;
    const limited = consolidated.slice(0, maxEntries);
    const lines = limited.map(e => `[${e.time}] ${e.speaker}: ${e.text}`);
    if (consolidated.length > maxEntries) {
      lines.push(`... (${consolidated.length - maxEntries} more entries truncated)`);
    }

    return lines.join("\n");
  } catch (error: any) {
    console.error(`Transcript error for "${subject}":`, error.message);
    return null;
  }
}

/**
 * Fetch transcripts for recent Teams meetings.
 * Gets calendar events, finds ones with Teams, fetches their transcripts.
 */
export async function getRecentMeetingTranscripts(
  startDate?: string,
  endDate?: string,
  targetSubject?: string
): Promise<string> {
  const events = await listCalendarEvents(startDate, endDate, 20);
  const teamsEvents = events.filter(e => e.isOnline && e.onlineUrl);

  if (!teamsEvents.length) return "No Teams meetings found for this period.";

  // If asking about a specific meeting, find it
  if (targetSubject) {
    const target = targetSubject.toLowerCase();
    const match = teamsEvents.find(e =>
      e.subject.toLowerCase().includes(target) ||
      target.split(/\s+/).filter(w => w.length > 3).some(w => e.subject.toLowerCase().includes(w))
    );
    if (match && match.onlineUrl) {
      const transcript = await getMeetingTranscript(match.onlineUrl, match.subject);
      if (transcript) {
        const time = new Date(match.start).toLocaleString("en-US", {
          timeZone: process.env.USER_TIMEZONE || "America/Sao_Paulo",
          weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        });
        return `MEETING TRANSCRIPT: ${match.subject} (${time})\nOrganizer: ${match.organizer}\n\n${transcript}`;
      }
      return `Meeting "${match.subject}" found but no transcript available. Transcription may not have been enabled for this meeting.`;
    }
  }

  // List meetings with transcript availability
  const results: string[] = [];
  results.push(`TEAMS MEETINGS (${teamsEvents.length}):\n`);

  for (const event of teamsEvents.slice(0, 5)) {
    const time = new Date(event.start).toLocaleString("en-US", {
      timeZone: process.env.USER_TIMEZONE || "America/Sao_Paulo",
      weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });

    let transcriptStatus = "";
    if (event.onlineUrl) {
      const meetingId = await getOnlineMeetingByJoinUrl(event.onlineUrl);
      if (meetingId) {
        const transcripts = await listMeetingTranscripts(meetingId);
        transcriptStatus = transcripts.length > 0 ? " [TRANSCRIPT AVAILABLE]" : " [no transcript]";
      }
    }

    results.push(`- ${time}: ${event.subject} (${event.organizer})${transcriptStatus}`);
  }

  results.push("\nAsk about a specific meeting to see its full transcript.");
  return results.join("\n");
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

    // Meeting transcripts — check before general calendar to handle transcript-specific requests
    if (msg.match(/\b(transcript|transcrição|transcription|transcri[çc])/i) ||
        (msg.match(/\b(what|o que).{0,15}(was|were|foi|foram).{0,15}(discussed|decided|said|talked|falado|decidido|discutido)\b/i)) ||
        (msg.match(/\b(who|quem).{0,15}(said|falou|disse)\b/i)) ||
        (msg.match(/\b(meeting|reunião|call).{0,15}(notes?|notas?|summary|resumo)\b/i))) {
      const isTomorrow = /\b(tomorrow)\b|amanh[aã]/i.test(msg);
      const isYesterday = /\b(yesterday)\b|ontem/i.test(msg);
      const isThisWeek = /\b(this week|esta semana)\b/i.test(msg);
      const now = new Date();
      let start: string, end: string;

      if (isYesterday) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        start = d.toISOString();
        end = new Date(d.getTime() + 86400000).toISOString();
      } else if (isTomorrow) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        start = d.toISOString();
        end = new Date(d.getTime() + 86400000).toISOString();
      } else if (isThisWeek) {
        const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
        start = weekStart.toISOString();
        end = new Date(weekStart.getTime() + 7 * 86400000).toISOString();
      } else {
        // Default: last 3 days
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3).toISOString();
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      }

      // Try to extract a specific meeting name from the message
      let targetSubject: string | undefined;
      const aboutMatch = msg.match(/(?:about|from|da|do|de|sobre|with|com)\s+(?:the\s+)?(?:meeting\s+(?:with\s+)?)?["']?([^"'?.!]+)/i);
      if (aboutMatch) targetSubject = aboutMatch[1].trim();

      const transcriptContext = await getRecentMeetingTranscripts(start, end, targetSubject);
      context += transcriptContext;
    }

    // Fetch relevant data
    if (msg.match(/\b(calendars?|calend[aá]rios?|schedule|meetings?|events?|agenda|appointments?|what'?s on|compromissos?|reuni[aãõo])/i)) {
      // Determine date range: today or tomorrow?
      const isTomorrow = /\b(tomorrow)\b|amanh[aã]/i.test(msg);
      const now = new Date();
      const targetDate = isTomorrow ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) : now;
      const start = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).toISOString();
      const end = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() + 1).toISOString();
      const dayLabel = isTomorrow ? "TOMORROW'S" : "TODAY'S";
      const events = await listCalendarEvents(start, end);
      if (events.length) {
        context += `${dayLabel} CALENDAR:\n` + events.map(e => {
          const start = new Date(e.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
          const end = new Date(e.end).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
          return `- ${start}-${end}: ${e.subject} (organizer: ${e.organizer}, status: ${e.status})${e.isOnline ? " [Teams]" : ""}`;
        }).join("\n");
      } else {
        context += `${dayLabel} CALENDAR: No events found.`;
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
