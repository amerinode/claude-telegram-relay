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
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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
    scope: "Mail.ReadWrite Mail.Send Calendars.ReadWrite Tasks.ReadWrite User.Read offline_access",
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

/**
 * Load the email whitelist from config/email-whitelist.json.
 * Returns lowercased email addresses that should never be flagged as spam.
 */
async function loadEmailWhitelist(): Promise<string[]> {
  try {
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const raw = await readFile(join(projectRoot, "config", "email-whitelist.json"), "utf-8");
    const data = JSON.parse(raw);
    return (data.whitelist || []).map((e: string) => e.toLowerCase().trim());
  } catch {
    return [];
  }
}

// ============================================================
// PUBLIC API — Called by the relay
// ============================================================

export interface Email {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
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

export interface TodoTaskList {
  id: string;
  displayName: string;
}

export interface TodoTask {
  id: string;
  listId: string;
  listName: string;
  title: string;
  body: string;
  importance: string;
  status: string;
  dueDateTime: string | null;
  createdDateTime: string;
}

/**
 * List all To Do task lists.
 */
export async function listTaskLists(): Promise<TodoTaskList[]> {
  const data = await graphRequest("/me/todo/lists", {
    params: { $top: "50" },
  }) as { value: any[] };

  return (data.value || []).map((l: any) => ({
    id: l.id,
    displayName: l.displayName || "(untitled)",
  }));
}

/**
 * List tasks in a specific To Do list.
 */
export async function listTasks(
  listId: string,
  listName: string,
  filter?: string
): Promise<TodoTask[]> {
  const params: Record<string, string> = {
    $top: "100",
  };

  const data = await graphRequest(`/me/todo/lists/${listId}/tasks`, {
    params,
  }) as { value: any[] };

  let tasks = (data.value || []).map((t: any) => ({
    id: t.id,
    listId,
    listName,
    title: t.title || "(untitled)",
    body: t.body?.content || "",
    importance: t.importance || "normal",
    status: t.status || "notStarted",
    dueDateTime: t.dueDateTime?.dateTime || null,
    createdDateTime: t.createdDateTime || "",
  }));

  // Filter in code — Graph API $filter on To Do tasks is unreliable
  if (filter === "status ne 'completed'") {
    tasks = tasks.filter(t => t.status !== "completed");
  }

  // Sort: high importance first
  tasks.sort((a, b) => {
    const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
    return (order[a.importance] ?? 1) - (order[b.importance] ?? 1);
  });

  return tasks;
}

/**
 * Update a To Do task (e.g. mark complete).
 */
export async function updateTask(
  listId: string,
  taskId: string,
  updates: Record<string, unknown>
): Promise<void> {
  await graphRequest(`/me/todo/lists/${listId}/tasks/${taskId}`, {
    method: "PATCH",
    body: updates,
  });
}

/**
 * Find a task list by display name (case-insensitive).
 */
export async function findTaskList(name: string): Promise<TodoTaskList | null> {
  const lists = await listTaskLists();
  const lower = name.toLowerCase().replace(/[^\w\s]/g, "").trim();
  return lists.find((l) => {
    const listName = l.displayName.toLowerCase().replace(/[^\w\s]/g, "").trim();
    return listName === lower || listName.includes(lower) || lower.includes(listName);
  }) || null;
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
    fromEmail: m.from?.emailAddress?.address || "",
    receivedAt: m.receivedDateTime,
    preview: m.bodyPreview?.substring(0, 200) || "",
    isRead: m.isRead,
  }));
}

/**
 * Read a specific email by ID.
 */
export async function readEmail(messageId: string): Promise<{ subject: string; from: string; fromEmail: string; body: string; receivedAt: string }> {
  const m = await graphRequest(`/me/messages/${messageId}`, {
    params: { $select: "subject,from,body,receivedDateTime" },
  }) as any;

  return {
    subject: m.subject || "(no subject)",
    from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "unknown",
    fromEmail: m.from?.emailAddress?.address || "",
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
    fromEmail: m.from?.emailAddress?.address || "",
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
 * Update a calendar event (reschedule, rename, change location, etc.).
 */
export async function updateCalendarEvent(
  eventId: string,
  updates: {
    subject?: string;
    startDateTime?: string;
    endDateTime?: string;
    timeZone?: string;
    location?: string;
  }
): Promise<{ id: string; subject: string }> {
  const tz = updates.timeZone || process.env.USER_TIMEZONE || "America/New_York";
  const body: any = {};

  if (updates.subject) body.subject = updates.subject;
  if (updates.startDateTime) body.start = { dateTime: updates.startDateTime, timeZone: tz };
  if (updates.endDateTime) body.end = { dateTime: updates.endDateTime, timeZone: tz };
  if (updates.location) body.location = { displayName: updates.location };

  const result = await graphRequest(`/me/events/${eventId}`, {
    method: "PATCH",
    body,
  }) as any;

  return { id: result.id, subject: result.subject };
}

/**
 * Delete a calendar event.
 */
export async function deleteCalendarEvent(eventId: string): Promise<void> {
  await graphRequest(`/me/events/${eventId}`, { method: "DELETE" });
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
 * Create a mail folder under Inbox (or another parent folder).
 */
export async function createMailFolder(
  displayName: string,
  parentFolderId?: string
): Promise<{ id: string; displayName: string }> {
  const path = parentFolderId
    ? `/me/mailFolders/${parentFolderId}/childFolders`
    : "/me/mailFolders/Inbox/childFolders";

  const result = await graphRequest(path, {
    method: "POST",
    body: { displayName },
  }) as any;

  return { id: result.id, displayName: result.displayName };
}

/**
 * Find a mail folder by display name (searches Inbox children).
 */
export async function findMailFolder(name: string): Promise<{ id: string; displayName: string } | null> {
  const data = await graphRequest("/me/mailFolders/Inbox/childFolders", {
    params: { $top: "100" },
  }) as { value: any[] };

  const lower = name.toLowerCase().trim();
  const found = (data.value || []).find((f: any) =>
    (f.displayName || "").toLowerCase().trim() === lower
  );
  return found ? { id: found.id, displayName: found.displayName } : null;
}

/**
 * Move an email to a different folder.
 */
export async function moveEmail(
  messageId: string,
  destinationFolderId: string
): Promise<{ id: string }> {
  const result = await graphRequest(`/me/messages/${messageId}/move`, {
    method: "POST",
    body: { destinationId: destinationFolderId },
  }) as any;

  return { id: result.id };
}

/**
 * Create a mail folder if it doesn't exist, return the folder ID either way.
 */
export async function getOrCreateMailFolder(name: string): Promise<{ id: string; displayName: string; created: boolean }> {
  const existing = await findMailFolder(name);
  if (existing) return { ...existing, created: false };
  const created = await createMailFolder(name);
  return { ...created, created: true };
}

/**
 * Create a task in a To Do list.
 */
export async function createTask(
  listId: string,
  title: string,
  body?: string,
  dueDateTime?: string,
  importance?: string
): Promise<{ id: string; title: string }> {
  const taskBody: any = { title };
  if (body) taskBody.body = { contentType: "Text", content: body };
  if (dueDateTime) taskBody.dueDateTime = { dateTime: dueDateTime, timeZone: "UTC" };
  if (importance) taskBody.importance = importance;

  const result = await graphRequest(`/me/todo/lists/${listId}/tasks`, {
    method: "POST",
    body: taskBody,
  }) as any;

  return { id: result.id, title: result.title };
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

    if (msg.match(/\b(tasks?|to.?dos?|tarefas?|work\s*tasks?|pendentes?|pending|checklist|action\s*items?)\b/i)) {
      // Determine which list(s) the user wants
      const wantsWork = /\b(work|trabalho|profission)/i.test(msg);
      const wantsPersonal = /\b(personal|pessoal|my tasks|minhas tarefas)\b/i.test(msg);
      const wantsSpecific = wantsWork || wantsPersonal;

      let tasks: TodoTask[] = [];
      const allLists = await listTaskLists();

      if (wantsWork) {
        // Only the "Work" list
        const workList = allLists.find(l => l.displayName.toLowerCase() === "work");
        if (workList) tasks = await listTasks(workList.id, workList.displayName, "status ne 'completed'");
      } else if (wantsPersonal) {
        // "Personal" = everything EXCEPT the "Work" list
        const personalLists = allLists.filter(l => l.displayName.toLowerCase() !== "work");
        for (const list of personalLists.slice(0, 8)) {
          try {
            const t = await listTasks(list.id, list.displayName, "status ne 'completed'");
            console.log(`  Tasks in "${list.displayName}": ${t.length}`);
            tasks.push(...t);
          } catch (e: any) {
            console.error(`  Failed to fetch "${list.displayName}": ${e.message}`);
          }
        }
      }

      if (!wantsSpecific || tasks.length === 0) {
        // Generic "tasks" or specific came back empty — fetch from all lists
        tasks = [];
        for (const list of allLists.slice(0, 8)) {
          try {
            const t = await listTasks(list.id, list.displayName, "status ne 'completed'");
            console.log(`  Tasks in "${list.displayName}": ${t.length}`);
            tasks.push(...t);
          } catch (e: any) {
            console.error(`  Failed to fetch "${list.displayName}": ${e.message}`);
          }
        }
      }
      console.log(`  Total tasks fetched: ${tasks.length}`);

      // Show available lists so Claude can reference them
      context += `\nTASK LISTS: ${allLists.map(l => l.displayName).join(", ")}`;

      if (tasks.length) {
        context += "\nPENDING TASKS:\n" + tasks.map(t => {
          const due = t.dueDateTime ? ` (due: ${new Date(t.dueDateTime).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : "";
          const imp = t.importance === "high" ? " [HIGH]" : "";
          return `- ${t.title}${due}${imp} — list: ${t.listName}`;
        }).join("\n");
      } else {
        context += "\nPENDING TASKS: No pending tasks found.";
      }
    }

    if (msg.match(/\b(emails?|e-?mails?|mails?|inbox|messages?|correio|caixa de entrada)\b/i)) {
      // Detect if user wants to SEARCH for a specific email (by sender, subject, keyword)
      const hasSearchIntent =
        /\b(busca|search|find|procura|acha|localiza|pesquisa)\b/i.test(msg) ||
        /\b(email|e-mail|mail)\b.{0,40}\b(do|da|de|from|sobre|about|regarding|of)\s+[A-Z\u00C0-\u024F]/i.test(msg) ||
        /\b(do|da|de|from|sobre|about)\s+[A-Z\u00C0-\u024F].{0,40}\b(email|e-mail|mail)\b/i.test(msg);

      if (hasSearchIntent) {
        // Extract search terms: strip verbs, articles, "email", prepositions
        const searchQuery = msg
          .replace(/\b(busca|search|find|procura|acha|localiza|pesquisa|mostra|show|get|read|ler|me|passe|mostre|ver|check|open|abrir)\b/gi, "")
          .replace(/\b(o|a|os|as|um|uma|the|an|my|meu|minha|meus|minhas|uns|umas)\b/gi, "")
          .replace(/\b(emails?|e-?mails?|mails?|inbox|messages?|correio)\b/gi, "")
          .replace(/\b(do|da|dos|das|de|from|about|sobre|regarding|of|que|que o|que a)\b/gi, "")
          .replace(/["""''?!.]/g, "")
          .replace(/\s+/g, " ")
          .trim();

        if (searchQuery.length > 2) {
          console.log(`  Email search query: "${searchQuery}"`);
          const results = await searchEmails(searchQuery, 5);

          if (results.length) {
            if (results.length <= 3) {
              // Auto-fetch full bodies for small result sets
              context += "\nEMAIL SEARCH RESULTS:\n";
              for (const email of results) {
                try {
                  const full = await readEmail(email.id);
                  const bodyText = full.body
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/&nbsp;/g, " ")
                    .replace(/&amp;/g, "&")
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/\s+/g, " ")
                    .trim();
                  const date = new Date(email.receivedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                  context += `\n--- EMAIL ---\nFrom: ${email.from} <${email.fromEmail}>\nSubject: ${email.subject}\nDate: ${date}\nBody:\n${bodyText.substring(0, 2000)}\n`;
                } catch {
                  const date = new Date(email.receivedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                  context += `\n--- EMAIL ---\nFrom: ${email.from} <${email.fromEmail}>\nSubject: ${email.subject}\nDate: ${date}\nPreview: ${email.preview}\n`;
                }
              }
            } else {
              context += "\nEMAIL SEARCH RESULTS:\n" + results.map(e => {
                const date = new Date(e.receivedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                return `- [${e.isRead ? "read" : "UNREAD"}] ${date} — From: ${e.from} <${e.fromEmail}> — Subject: ${e.subject}\n  Preview: ${e.preview.substring(0, 150)}`;
              }).join("\n");
              context += "\n\nMultiple results found. Ask the user which email they want to read in full.";
            }
          } else {
            context += `\nEMAIL SEARCH: No emails found matching "${searchQuery}".`;
          }
        } else {
          // Search terms too short, fall back to listing
          const emails = await listEmails(10);
          if (emails.length) {
            context += "\nRECENT EMAILS:\n" + emails.map(e => {
              const date = new Date(e.receivedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
              return `- [${e.isRead ? "read" : "UNREAD"}] ${date} — From: ${e.from} <${e.fromEmail}> — Subject: ${e.subject}\n  Preview: ${e.preview.substring(0, 100)}`;
            }).join("\n");
          } else {
            context += "\nRECENT EMAILS: No emails found.";
          }
        }
      } else {
        // Standard listing — no specific search intent
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
    }

    // Send email: "send the email", "reply to Ricardo", "enviar email"
    if (msg.match(/\b(send|reply|respond|forward|enviar?|mandar?|responder?|reenviar?)\b/i) && msg.match(/\b(emails?|e-?mails?|mails?|message|reply|resposta|mensagem)\b|to\s+[A-Z\u00C0-\u024F]/i)) {
      context += "\n\nACTION AVAILABLE: You can send emails directly. Include this tag:";
      context += "\n[SEND_EMAIL: recipient@email.com | Subject line | Email body text]";
      context += "\n  Use the recipient's email address from the email data above (shown in angle brackets after the name).";
      context += "\n  For replies, use 'Re: original subject' as the subject line.";
      context += "\n  You CAN send emails — do NOT tell the user the integration is read-only.";
    }

    // Task creation: "add X to list Y", "adiciona X na lista Y"
    if (msg.match(/\b(add|create|adiciona|coloca|bota|põe|inclui)\b/i) && msg.match(/\b(list|lista|to.?do|task|tarefa|grocer)/i)) {
      const allLists = context.includes("TASK LISTS:") ? [] : await listTaskLists();
      if (!context.includes("TASK LISTS:")) {
        context += `\nTASK LISTS: ${allLists.map(l => l.displayName).join(", ")}`;
      }
      context += "\n\nACTION AVAILABLE: You can create tasks in To Do lists. Include this tag: [CREATE_TASK: list_name | task title]";
      context += "\n  Example: [CREATE_TASK: Groceries | Nespresso coffee]";
      context += "\n  Match the list name to the available lists above (case-insensitive, partial match OK).";
    }

    // For move/reschedule/update/cancel/delete actions, fetch calendar context and offer tags
    if (msg.match(/\b(move|reschedule|change|push|delay|shift|mover|mudar|trocar|remarcar|adiar|antecipar)\b/i) && msg.match(/\b(meeting|event|lunch|dinner|breakfast|call|calendar|appointment|reuni[aãõo]|almo[cç]o|jantar)\b|to\s+\d|from\s+\d|to\s+(noon|morning|afternoon)/i)) {
      // Make sure calendar is fetched if not already
      if (!context.includes("CALENDAR:")) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();
        const events = await listCalendarEvents(start, end);
        if (events.length) {
          context += "UPCOMING CALENDAR:\n" + events.map(e => {
            const s = new Date(e.start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
            const en = new Date(e.end).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
            return `- ${s}-${en}: ${e.subject}${e.location ? ` @ ${e.location}` : ""}`;
          }).join("\n");
        }
      }
      context += "\n\nACTION AVAILABLE: You can update (reschedule) calendar events. Find the matching event from the calendar above, then include this tag:";
      context += "\n[UPDATE_EVENT: event_subject_search_text | new_start_datetime (ISO) | new_end_datetime (ISO) | timezone]";
      context += "\n  Example: [UPDATE_EVENT: Lunch with Fabio | 2026-02-26T12:30:00 | 2026-02-26T13:30:00 | America/Sao_Paulo]";
      context += "\n  Keep the same duration unless the user specifies otherwise.";
    }

    if (msg.match(/\b(cancel|delete|remove|cancelar|excluir|remover|apagar)\b/i) && msg.match(/\b(meeting|event|lunch|dinner|call|calendar|appointment)\b/i)) {
      if (!context.includes("CALENDAR:")) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();
        const events = await listCalendarEvents(start, end);
        if (events.length) {
          context += "UPCOMING CALENDAR:\n" + events.map(e => {
            const s = new Date(e.start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
            const en = new Date(e.end).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
            return `- ${s}-${en}: ${e.subject}${e.location ? ` @ ${e.location}` : ""}`;
          }).join("\n");
        }
      }
      context += "\n\nACTION AVAILABLE: You can delete calendar events. Include this tag:";
      context += "\n[DELETE_EVENT: event_subject_search_text]";
      context += "\n  Example: [DELETE_EVENT: Lunch with Fabio]";
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

    // Email folder management: create folder, move emails to folder, spam cleanup
    if (msg.match(/\b(folder|pasta|spam|junk|move|mover|organiz|clean.?up|limp)/i) && msg.match(/\b(email|e-?mail|mail|inbox|caixa|message|mensag)/i)) {
      // Always fetch emails with IDs for folder operations (replace any prior ID-less listing)
      const emails = await listEmails(20);
      if (emails.length) {
        // Remove prior email listing that lacks IDs
        context = context.replace(/\nRECENT EMAILS:[\s\S]*?(?=\n[A-Z]|\n\nACTION|$)/, "");
        context += "\nRECENT EMAILS (with IDs for move operations):\n" + emails.map((e, i) => {
          const date = new Date(e.receivedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          return `- [${i}] ID: ${e.id}\n  ${date} — From: ${e.from} <${e.fromEmail}> — Subject: ${e.subject}\n  Preview: ${e.preview.substring(0, 100)}`;
        }).join("\n");
      }
      context += "\n\nACTION AVAILABLE: You can create mail folders and move emails into them.";
      context += "\n[CREATE_MAIL_FOLDER: folder_name]";
      context += "\n  Creates a subfolder under Inbox. Example: [CREATE_MAIL_FOLDER: Potential Spam]";
      context += "\n[MOVE_EMAILS: folder_name | email_id_1, email_id_2, ...]";
      context += "\n  Moves one or more emails to a folder (creates the folder if it doesn't exist).";
      context += "\n  Use the email IDs from the email data above.";
      context += "\n  Example: [MOVE_EMAILS: Potential Spam | AAMkAGQ..., AAMkAGR...]";
      context += "\n  You can include multiple MOVE_EMAILS tags if needed.";
      context += "\n  Analyze the emails and identify which ones are spam/marketing before moving.";
      context += "\n  IMPORTANT: You MUST use the actual email IDs shown above in the MOVE_EMAILS tag. Do NOT say you don't have them — they are listed above.";

      // Load whitelist — these senders should NEVER be moved to spam
      const whitelist = await loadEmailWhitelist();
      if (whitelist.length) {
        context += `\n\n  EMAIL WHITELIST — NEVER move emails from these senders to Potential Spam or any spam folder:`;
        context += `\n  ${whitelist.join(", ")}`;
        context += `\n  These are trusted senders confirmed by the user. Always keep their emails in the Inbox.`;
      }
    }

    // If no specific data was fetched but this is a confirmation message,
    // return a hint so the action tags still get injected
    if (!context) {
      const isConfirmation = /^(sim|s|ok|pode|manda|envia|send|yes|go|sure|do it|send it|confirmed|approved|please|👍|✅)/i.test(msg.trim());
      if (isConfirmation) {
        return "USER CONFIRMATION: The user is confirming a previous action. Check recent conversation history for the pending email, calendar, or task action and execute it using the appropriate action tag.";
      }
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
