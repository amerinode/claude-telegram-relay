/**
 * Smart Check-in — Proactive Assistant Pipeline
 *
 * Runs every 30 minutes (via PM2 or cron). Seven sections + meta-layer:
 *   1. Hospitable (Airbnb) — unread guest messages, urgency classification, draft replies
 *   2. Ona Task List — autonomous task execution from "Ona" list
 *   3. My Task List — Gil's tasks: overdue, due today, high importance
 *   4. My Emails — new unread emails from the last 6 hours
 *   5. My Calendar — today's & tomorrow's events, upcoming meetings, RSVP needed
 *   6. WhatsApp — unread messages with draft replies
 *   7. Proactive — Claude analyzes all context and suggests actions if warranted
 *
 * Meta-layer: gathers recent messages, memory, and calendar before running sections,
 * feeds all results to Section 7 for holistic analysis. Only reaches out if something
 * is worth flagging.
 *
 * Run: bun run examples/smart-checkin.ts
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile, unlink } from "fs/promises";
import { join, dirname, basename } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  listTaskLists,
  listTasks,
  updateTask,
  findTaskList,
  sendEmail,
  createCalendarEvent,
  createDraft,
  listEmails,
  listCalendarEvents,
  type TodoTask,
  type Email,
  type CalendarEvent,
} from "../src/ms365.ts";
import { processFileActions } from "../src/file-gen.ts";
import { createMeetingPage, isNotionEnabled } from "../src/notion.ts";
import { getMeetingTranscript } from "../src/ms365.ts";
import { needsSearch, searchWeb } from "../src/search.ts";
import { getMemoryContext, getRecentHistory } from "../src/memory.ts";
import { isWhatsAppEnabled, isWhatsAppConnected } from "../src/whatsapp.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";

// Supabase client for storing alerts in messages table
const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveAlertToMessages(content: string, metadata?: Record<string, unknown>): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role: "assistant",
      content,
      channel: "telegram",
      metadata: { source: "smart-checkin", ...metadata },
    });
  } catch (e: any) {
    console.error("Failed to save alert to messages:", e.message);
  }
}
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const USER_NAME = process.env.USER_NAME || "Gil";
const WA_BRIDGE_PORT = process.env.WHATSAPP_BRIDGE_PORT || "7150";
const STATE_FILE =
  process.env.CHECKIN_STATE_FILE ||
  join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-relay",
    "checkin-state.json"
  );

// ============================================================
// TYPES
// ============================================================

type UrgencyTier = "critical" | "high" | "medium" | "low";

interface AlertedEntry {
  /** ISO timestamp of the last guest message we alerted about */
  lastGuestMessageAt: string;
  /** When we sent the alert */
  alertedAt: string;
}

interface TaskAlertedEntry {
  /** Task status when we last alerted */
  status: string;
  /** When we sent the alert */
  alertedAt: string;
}

interface OnaExecutionEntry {
  /** When Ona processed this task */
  executedAt: string;
  /** Whether it was completed or skipped */
  result: "completed" | "skipped" | "failed";
}

interface EmailAlertedEntry {
  /** When we alerted about this email */
  alertedAt: string;
}

interface CalendarAlertedEntry {
  /** When we alerted about this calendar event */
  alertedAt: string;
}

interface NotionSyncedEntry {
  /** When we synced this meeting to Notion */
  syncedAt: string;
  /** Notion page ID */
  pageId: string;
}

/** Accumulates section results for the Proactive analysis layer */
interface SectionResults {
  hospitable: { alertsSent: number; summary: string };
  onaTasks: { tasksProcessed: number; summary: string };
  myTasks: { alertsSent: number; summary: string };
  myEmails: { alertsSent: number; summary: string };
  myCalendar: { alertsSent: number; summary: string; events: CalendarEvent[] };
  notionSync: { syncedCount: number; summary: string };
  whatsapp: { alertsSent: number; summary: string };
}

interface CheckinState {
  lastRunTime: string;
  alertedConversations: Record<string, AlertedEntry>;
  alertedTasks: Record<string, TaskAlertedEntry>;
  alertedEmails: Record<string, EmailAlertedEntry>;
  onaExecutedTasks: Record<string, OnaExecutionEntry>;
  alertedCalendarEvents: Record<string, CalendarAlertedEntry>;
  notionSyncedMeetings: Record<string, NotionSyncedEntry>;
  lastProactiveAt: string;
}

interface UnansweredConversation {
  id: string;
  type: "reservation" | "inquiry";
  guestName: string;
  propertyName: string;
  platform: string;
  arrivalDate: string;
  departureDate: string;
  status: string;
  guestCount: number;
  lastMessageAt: string;
  messages: GuestMessage[];
  urgency: UrgencyTier;
  urgencyLabel: string;
  ageMinutes: number;
}

// Hospitable types (conditionally imported)
type GuestMessage = {
  id: string;
  body: string;
  senderType: string;
  senderName: string;
  createdAt: string;
};
type Reservation = {
  id: string;
  guestName: string;
  propertyName: string;
  platform: string;
  arrivalDate: string;
  departureDate: string;
  status: string;
  guestCount: number;
  lastMessageAt: string;
};
type Inquiry = {
  id: string;
  guestName: string;
  propertyName: string;
  platform: string;
  arrivalDate: string;
  departureDate: string;
  guestCount: number;
  lastMessageAt: string;
};

// WhatsApp bridge message type
interface WABridgeMessage {
  id: string;
  from: string;
  fromName: string;
  text: string;
  timestamp: number;
  isRead: boolean;
  isGroup?: boolean;
  groupName?: string;
  participant?: string;
  participantName?: string;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(content);
    return {
      lastRunTime: parsed.lastRunTime || "",
      alertedConversations: parsed.alertedConversations || {},
      alertedTasks: parsed.alertedTasks || {},
      alertedEmails: parsed.alertedEmails || {},
      onaExecutedTasks: parsed.onaExecutedTasks || {},
      alertedCalendarEvents: parsed.alertedCalendarEvents || {},
      notionSyncedMeetings: parsed.notionSyncedMeetings || {},
      lastProactiveAt: parsed.lastProactiveAt || "",
    };
  } catch {
    return {
      lastRunTime: "",
      alertedConversations: {},
      alertedTasks: {},
      alertedEmails: {},
      onaExecutedTasks: {},
      alertedCalendarEvents: {},
      notionSyncedMeetings: {},
      lastProactiveAt: "",
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Remove old entries: conversations >7d, tasks >7d, Ona executions >30d */
function pruneState(state: CheckinState): void {
  const convCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state.alertedConversations)) {
    if (new Date(entry.alertedAt).getTime() < convCutoff) {
      delete state.alertedConversations[id];
    }
  }

  const taskCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state.alertedTasks)) {
    if (new Date(entry.alertedAt).getTime() < taskCutoff) {
      delete state.alertedTasks[id];
    }
  }

  const emailCutoff = Date.now() - 48 * 60 * 60 * 1000; // 48h
  for (const [id, entry] of Object.entries(state.alertedEmails)) {
    if (new Date(entry.alertedAt).getTime() < emailCutoff) {
      delete state.alertedEmails[id];
    }
  }

  const onaCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state.onaExecutedTasks)) {
    if (new Date(entry.executedAt).getTime() < onaCutoff) {
      delete state.onaExecutedTasks[id];
    }
  }

  const calCutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h
  for (const [id, entry] of Object.entries(state.alertedCalendarEvents)) {
    if (new Date(entry.alertedAt).getTime() < calCutoff) {
      delete state.alertedCalendarEvents[id];
    }
  }
}

// ============================================================
// URGENCY CLASSIFICATION (Hospitable)
// ============================================================

function classifyUrgency(
  type: "reservation" | "inquiry",
  status: string,
  ageMinutes: number
): { tier: UrgencyTier; label: string } {
  if (type === "inquiry" && ageMinutes < 120) {
    return { tier: "critical", label: "New inquiry (pre-booking)" };
  }
  if (type === "inquiry" && ageMinutes < 720) {
    return { tier: "high", label: "Inquiry (pre-booking)" };
  }
  if (type === "inquiry" && ageMinutes <= 2880) {
    return { tier: "medium", label: "Inquiry (pre-booking)" };
  }
  if (status === "request" && ageMinutes < 240) {
    return { tier: "high", label: "Reservation request" };
  }
  if (ageMinutes <= 1440) {
    return { tier: "medium", label: type === "inquiry" ? "Inquiry" : "Reservation" };
  }
  return { tier: "low", label: type === "inquiry" ? "Old inquiry" : "Old reservation" };
}

const URGENCY_ORDER: Record<UrgencyTier, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const URGENCY_EMOJI: Record<UrgencyTier, string> = {
  critical: "\u{1F534}",  // red circle
  high: "\u{1F7E0}",      // orange circle
  medium: "\u{1F7E1}",    // yellow circle
  low: "\u{26AA}",         // white circle
};

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
        }),
      }
    );
    if (!response.ok) {
      const err = await response.text().catch(() => "");
      console.error(`Telegram API error (${response.status}): ${err.substring(0, 200)}`);
    }
    return response.ok;
  } catch (error: any) {
    console.error(`Telegram send failed: ${error.message}`);
    return false;
  }
}

async function sendTelegramFile(filePath: string, caption?: string): Promise<boolean> {
  try {
    const content = await readFile(filePath);
    const name = basename(filePath);
    const formData = new FormData();
    formData.append("chat_id", CHAT_ID);
    formData.append("document", new Blob([content]), name);
    if (caption) formData.append("caption", caption);

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`,
      { method: "POST", body: formData }
    );
    return response.ok;
  } catch (error: any) {
    console.error(`Failed to send file ${filePath}:`, error.message);
    return false;
  }
}

// ============================================================
// HELPERS
// ============================================================

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function timeAgo(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function todayDateStr(): string {
  const tz = process.env.USER_TIMEZONE || "America/Sao_Paulo";
  return new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}

// ============================================================
// DRAFT REPLY VIA CLAUDE (Hospitable)
// ============================================================

async function draftReply(conv: UnansweredConversation): Promise<string> {
  let profileContext = "";
  try {
    profileContext = await readFile(
      join(PROJECT_ROOT, "config", "profile.md"),
      "utf-8"
    );
  } catch {}

  const transcript = conv.messages
    .map((m) => {
      const sender = m.senderType === "host" ? `Host (${USER_NAME})` : `Guest (${m.senderName})`;
      return `${sender}: ${m.body}`;
    })
    .join("\n");

  const guestMessages = conv.messages
    .filter((m) => m.senderType !== "host")
    .map((m) => m.body)
    .join(" ");
  const likelyPortuguese = /[àáâãçéêíóôõúü]|ção|ões|olá|obrigad|bom dia|boa tarde/i.test(
    guestMessages
  );

  const prompt = `You are drafting a reply to a vacation rental guest on behalf of the host.

CONTEXT:
- Property: ${conv.propertyName}
- Guest: ${conv.guestName} (${conv.guestCount} guests)
- Dates: ${fmtDate(conv.arrivalDate)} to ${fmtDate(conv.departureDate)}
- Type: ${conv.type} (${conv.status})
- Platform: ${conv.platform}

${profileContext ? `HOST PROFILE:\n${profileContext}\n` : ""}
CONVERSATION SO FAR:
${transcript}

INSTRUCTIONS:
- Write a brief, friendly reply as the host
- Match the guest's language (${likelyPortuguese ? "write in Portuguese" : "write in the same language they used"})
- Be helpful and warm, answer their question directly
- Keep it concise — 1-3 sentences max
- Do NOT include greetings like "Dear guest" — use their first name
- Do NOT add any formatting, tags, or explanations
- Just output the message text, nothing else`;

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const claudeArgs = ["--no-session-persistence", "--output-format", "text"];
    const promptFile = join(PROJECT_ROOT, `temp_draft_${Date.now()}.txt`);
    await writeFile(promptFile, prompt);

    return await new Promise<string>((resolve) => {
      const child = nodeSpawn(CLAUDE_PATH, claudeArgs, {
        cwd: PROJECT_ROOT,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let output = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => {}); // discard stderr

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        unlink(promptFile).catch(() => {});
        resolve("(Claude timed out)");
      }, 180_000);

      const fs = require("fs");
      fs.createReadStream(promptFile).pipe(child.stdin!);

      child.on("close", () => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        resolve(output.trim() || "(Could not generate draft)");
      });

      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        resolve("(Could not generate draft)");
      });
    });
  } catch (error) {
    console.error("Claude draft error:", error);
    return "(Could not generate draft)";
  }
}

// ============================================================
// FORMAT ALERT (Hospitable)
// ============================================================

function formatAlert(conv: UnansweredConversation, draft: string): string {
  const emoji = URGENCY_EMOJI[conv.urgency];
  const tierLabel = conv.urgency.toUpperCase();
  const dates = `${fmtDate(conv.arrivalDate)}\u2013${fmtDate(conv.departureDate)}`;

  const recentMessages = conv.messages
    .slice(-3)
    .map((m) => {
      const sender = m.senderType === "host" ? "[You]" : `[Guest] ${m.senderName}`;
      return `${sender}: ${m.body.substring(0, 200)}`;
    })
    .join("\n");

  const replyCmd =
    conv.type === "inquiry"
      ? `reply to ${conv.guestName.split(" ")[0]}'s inquiry: [your message]`
      : `reply to ${conv.guestName.split(" ")[0]}: [your message]`;

  return [
    `\u{1F3E0} Guest Message Alert`,
    ``,
    `${emoji} ${tierLabel} \u2014 ${conv.urgencyLabel}`,
    ``,
    `${conv.guestName} \u2192 ${conv.propertyName}`,
    `\u{1F4C5} ${dates} (${conv.platform}, ${conv.type})`,
    conv.guestCount ? `\u{1F465} ${conv.guestCount} guests` : "",
    `\u23F0 Last message: ${timeAgo(conv.ageMinutes)}`,
    ``,
    `\u{1F4AC} Recent conversation:`,
    recentMessages,
    ``,
    `\u270F\uFE0F Suggested reply:`,
    draft,
    ``,
    `\u27A1 To send, tell the bot:`,
    `"${replyCmd}"`,
  ].filter(Boolean).join("\n");
}

// ============================================================
// SECTION 1: HOSPITABLE GUEST ALERTS
// ============================================================

async function checkHospitableGuests(state: CheckinState): Promise<{ count: number; summary: string }> {
  // Dynamically import hospitable (only if configured)
  const {
    listProperties,
    getReservations,
    getInquiries,
    getMessages,
    getInquiryMessages,
  } = await import("../src/hospitable.ts");

  let properties;
  try {
    properties = await listProperties();
  } catch (error: any) {
    console.error("Failed to list properties:", error.message);
    return { count: 0, summary: "Failed to list properties." };
  }

  if (!properties.length) {
    console.log("No properties found.");
    return { count: 0, summary: "No properties found." };
  }

  const propertyIds = properties.map((p: any) => p.id);
  console.log(`Found ${properties.length} properties: ${properties.map((p: any) => p.name).join(", ")}`);

  let reservations: Reservation[] = [];
  let inquiries: Inquiry[] = [];

  try {
    [reservations, inquiries] = await Promise.all([
      getReservations({
        propertyIds,
        perPage: 30,
        status: ["accepted", "request"],
      }).catch((e: any) => {
        console.error("Failed to fetch reservations:", e.message);
        return [] as Reservation[];
      }),
      getInquiries({
        propertyIds,
        perPage: 20,
      }).catch((e: any) => {
        console.error("Failed to fetch inquiries:", e.message);
        return [] as Inquiry[];
      }),
    ]);
  } catch (error: any) {
    console.error("Failed to fetch conversations:", error.message);
    return { count: 0, summary: "Failed to fetch conversations." };
  }

  console.log(`Found ${reservations.length} reservations, ${inquiries.length} inquiries`);

  const now = Date.now();
  const unanswered: UnansweredConversation[] = [];

  // Process reservations
  for (const res of reservations) {
    if (!res.lastMessageAt) continue;
    const lastMsgAge = (now - new Date(res.lastMessageAt).getTime()) / 60000;
    if (lastMsgAge > 2880) continue;

    const departed = new Date(res.departureDate).getTime() < now;
    if (departed && lastMsgAge > 1440) continue;

    try {
      const messages = await getMessages(res.id);
      if (!messages.length) continue;

      const lastMsg = messages[messages.length - 1];
      if (lastMsg.senderType === "host") continue;

      const lastGuestMsgTime = lastMsg.createdAt;
      const ageMinutes = (now - new Date(lastGuestMsgTime).getTime()) / 60000;

      const alerted = state.alertedConversations[res.id];
      if (alerted && alerted.lastGuestMessageAt === lastGuestMsgTime) continue;

      const { tier, label } = classifyUrgency("reservation", res.status, ageMinutes);
      if (tier === "low") continue;

      unanswered.push({
        id: res.id,
        type: "reservation",
        guestName: res.guestName,
        propertyName: res.propertyName,
        platform: res.platform,
        arrivalDate: res.arrivalDate,
        departureDate: res.departureDate,
        status: res.status,
        guestCount: res.guestCount,
        lastMessageAt: res.lastMessageAt,
        messages: messages.slice(-5),
        urgency: tier,
        urgencyLabel: label,
        ageMinutes,
      });
    } catch (e: any) {
      console.error(`Error processing reservation ${res.id}:`, e.message);
    }
  }

  // Process inquiries
  for (const inq of inquiries) {
    if (!inq.lastMessageAt) continue;
    const lastMsgAge = (now - new Date(inq.lastMessageAt).getTime()) / 60000;
    if (lastMsgAge > 2880) continue;

    try {
      const messages = await getInquiryMessages(inq.id);
      if (!messages.length) continue;

      const lastMsg = messages[messages.length - 1];
      if (lastMsg.senderType === "host") continue;

      const lastGuestMsgTime = lastMsg.createdAt;
      const ageMinutes = (now - new Date(lastGuestMsgTime).getTime()) / 60000;

      const alerted = state.alertedConversations[inq.id];
      if (alerted && alerted.lastGuestMessageAt === lastGuestMsgTime) continue;

      const { tier, label } = classifyUrgency("inquiry", "inquiry", ageMinutes);
      if (tier === "low") continue;

      unanswered.push({
        id: inq.id,
        type: "inquiry",
        guestName: inq.guestName,
        propertyName: inq.propertyName,
        platform: inq.platform,
        arrivalDate: inq.arrivalDate,
        departureDate: inq.departureDate,
        status: "inquiry",
        guestCount: inq.guestCount,
        lastMessageAt: inq.lastMessageAt,
        messages: messages.slice(-5),
        urgency: tier,
        urgencyLabel: label,
        ageMinutes,
      });
    } catch (e: any) {
      console.error(`Error processing inquiry ${inq.id}:`, e.message);
    }
  }

  // Sort by urgency, take top 5
  unanswered.sort((a, b) => {
    const tierDiff = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (tierDiff !== 0) return tierDiff;
    return a.ageMinutes - b.ageMinutes;
  });

  const toAlert = unanswered.slice(0, 5);

  if (!toAlert.length) {
    console.log("No new unanswered guest messages.");
    return { count: 0, summary: "No unanswered guest messages." };
  }

  console.log(`Found ${unanswered.length} unanswered conversations, alerting on top ${toAlert.length}`);

  let alertsSent = 0;

  for (const conv of toAlert) {
    try {
      console.log(
        `Drafting reply for ${conv.guestName} (${conv.type}, ${conv.urgency})...`
      );
      const draft = await draftReply(conv);

      const alert = formatAlert(conv, draft);
      const sent = await sendTelegram(alert);

      if (sent) {
        await saveAlertToMessages(alert, { type: "guest-alert", guestName: conv.guestName, property: conv.propertyName, conversationType: conv.type });
        alertsSent++;
        const lastGuestMsg = conv.messages
          .filter((m) => m.senderType !== "host")
          .pop();
        state.alertedConversations[conv.id] = {
          lastGuestMessageAt: lastGuestMsg?.createdAt || conv.lastMessageAt,
          alertedAt: new Date().toISOString(),
        };
        console.log(`  Alert sent for ${conv.guestName}`);
      } else {
        console.error(`  Failed to send alert for ${conv.guestName}`);
      }

      if (toAlert.indexOf(conv) < toAlert.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e: any) {
      console.error(`Error alerting for ${conv.guestName}:`, e.message);
    }
  }

  const summary = unanswered.length
    ? `${unanswered.length} unanswered guest messages: ` +
      unanswered.map(c => `${c.guestName} at ${c.propertyName} (${c.urgencyLabel}, ${timeAgo(c.ageMinutes)})`).join("; ")
    : "No unanswered guest messages.";

  return { count: alertsSent, summary };
}

// ============================================================
// SECTION 2: EMAIL ALERTS
// ============================================================

async function checkNewEmails(state: CheckinState): Promise<{ count: number; summary: string }> {
  // Fetch recent emails (last 15)
  const emails = await listEmails(15);
  if (!emails.length) {
    console.log("No emails found.");
    return { count: 0, summary: "No emails found." };
  }

  // Filter: only unread, received in the last 6 hours, not already alerted
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const newUnread = emails.filter((e) => {
    if (e.isRead) return false;
    if (new Date(e.receivedAt).getTime() < sixHoursAgo) return false;
    if (state.alertedEmails[e.id]) return false;
    return true;
  });

  if (!newUnread.length) {
    console.log("No new unread emails to alert about.");
    return { count: 0, summary: "No new unread emails." };
  }

  // Cap at 8 to avoid spammy alerts
  const toShow = newUnread.slice(0, 8);

  // Format the alert
  const lines: string[] = [
    `\u{1F4E7} Email Update \u2014 ${newUnread.length} new unread`,
    ``,
  ];

  for (const email of toShow) {
    const receivedDate = new Date(email.receivedAt);
    const minutesAgo = Math.round((Date.now() - receivedDate.getTime()) / 60000);
    const age = timeAgo(minutesAgo);
    const preview = email.preview.substring(0, 80).replace(/\n/g, " ");

    lines.push(`\u2022 ${email.from} \u2014 ${email.subject}`);
    lines.push(`  ${preview}${email.preview.length > 80 ? "..." : ""}`);
    lines.push(`  \u23F0 ${age}`);
    lines.push(``);
  }

  if (newUnread.length > 8) {
    lines.push(`\u2026 and ${newUnread.length - 8} more`);
    lines.push(``);
  }

  lines.push(`\u27A1 Ask me to read any of these or check your full inbox.`);

  const message = lines.join("\n");
  const sent = await sendTelegram(message);

  if (sent) {
    await saveAlertToMessages(message, { type: "email-alert" });
    const now = new Date().toISOString();
    for (const email of newUnread) {
      state.alertedEmails[email.id] = { alertedAt: now };
    }
    console.log(`Email alert sent: ${toShow.length} emails shown.`);
  }

  const summary = `${newUnread.length} new unread emails: ` +
    newUnread.slice(0, 5).map(e => `"${e.subject}" from ${e.from}`).join("; ");

  return { count: sent ? toShow.length : 0, summary };
}

// ============================================================
// SECTION 3: GIL'S TASK ALERTS
// ============================================================

async function checkGilTasks(state: CheckinState): Promise<{ count: number; summary: string }> {
  const today = todayDateStr();
  const allLists = await listTaskLists();

  // Collect all tasks that need alerting
  const overdueItems: string[] = [];
  const dueTodayItems: string[] = [];
  const highPriorityItems: string[] = [];
  const taskKeysToUpdate: Array<{ key: string; status: string }> = [];

  for (const list of allLists) {
    // Skip the Ona list — those are for autonomous execution
    if (list.displayName.toLowerCase() === "ona") continue;

    const tasks = await listTasks(
      list.id,
      list.displayName,
      "status ne 'completed'"
    );

    for (const task of tasks) {
      const taskKey = `${list.id}:${task.id}`;

      // Determine if this task needs alerting
      let alertReason: string | null = null;

      if (task.dueDateTime) {
        const dueDate = task.dueDateTime.split("T")[0];
        if (dueDate < today) {
          alertReason = "Overdue";
        } else if (dueDate === today) {
          alertReason = "Due today";
        }
      }

      if (!alertReason && task.importance === "high") {
        alertReason = "High priority";
      }

      if (!alertReason) continue;

      // Skip if recently alerted and status unchanged
      // Due-today/overdue: re-alert every 6h so they surface morning + afternoon
      // High-priority (no due date): re-alert every 24h
      const existing = state.alertedTasks[taskKey];
      if (existing) {
        const hoursSince = (Date.now() - new Date(existing.alertedAt).getTime()) / 3600000;
        const suppressHours = (alertReason === "Due today" || alertReason === "Overdue") ? 6 : 24;
        if (hoursSince < suppressHours && existing.status === task.status) continue;
      }

      // Format task line for consolidated report
      const duePart = task.dueDateTime ? ` (due ${fmtDate(task.dueDateTime)})` : "";
      const impPart = task.importance === "high" ? " \u26A1" : "";
      const line = `\u2022 ${task.title}${duePart}${impPart}\n  \u{1F4CB} ${list.displayName}`;

      if (alertReason === "Overdue") {
        overdueItems.push(line);
      } else if (alertReason === "Due today") {
        dueTodayItems.push(line);
      } else {
        highPriorityItems.push(line);
      }

      taskKeysToUpdate.push({ key: taskKey, status: task.status });
      console.log(`  Task alert: "${task.title}" (${alertReason})`);
    }
  }

  const totalTasks = overdueItems.length + dueTodayItems.length + highPriorityItems.length;
  if (totalTasks === 0) {
    console.log("No tasks needing alerts.");
    return { count: 0, summary: "No tasks needing attention." };
  }

  // Build consolidated report
  const sections: string[] = [];

  if (overdueItems.length) {
    sections.push(`\u{1F534} Overdue (${overdueItems.length})\n${overdueItems.join("\n\n")}`);
  }
  if (dueTodayItems.length) {
    sections.push(`\u{1F7E0} Due Today (${dueTodayItems.length})\n${dueTodayItems.join("\n\n")}`);
  }
  if (highPriorityItems.length) {
    sections.push(`\u{1F7E1} High Priority (${highPriorityItems.length})\n${highPriorityItems.join("\n\n")}`);
  }

  const message = [
    `\u2705 Task Report \u2014 ${totalTasks} item${totalTasks > 1 ? "s" : ""} need attention`,
    ``,
    sections.join("\n\n"),
  ].join("\n");

  const sent = await sendTelegram(message);
  if (sent) {
    await saveAlertToMessages(message, { type: "task-alert" });
    const now = new Date().toISOString();
    for (const { key, status } of taskKeysToUpdate) {
      state.alertedTasks[key] = { status, alertedAt: now };
    }
  }

  const summary = `${overdueItems.length} overdue, ${dueTodayItems.length} due today, ${highPriorityItems.length} high priority`;
  return { count: sent ? totalTasks : 0, summary };
}

// ============================================================
// SECTION 4: ONA'S AUTONOMOUS TASK EXECUTION
// ============================================================

/**
 * Process action tags in Claude's response — same pattern as relay.ts.
 * Returns the cleaned response text.
 */
async function processActionTags(response: string): Promise<{ clean: string; actionsExecuted: string[] }> {
  let clean = response;
  const actionsExecuted: string[] = [];

  // [SEND_EMAIL: to | subject | body]
  for (const match of response.matchAll(/\[SEND_EMAIL:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi)) {
    try {
      await sendEmail({
        to: [match[1].trim()],
        subject: match[2].trim(),
        body: match[3].trim(),
      });
      actionsExecuted.push(`Sent email to ${match[1].trim()}`);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      actionsExecuted.push(`Failed to send email: ${error.message}`);
      clean = clean.replace(match[0], "");
    }
  }

  // [CREATE_EVENT: subject | start | end | timezone]
  for (const match of response.matchAll(/\[CREATE_EVENT:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*(?:\|\s*(.+?))?\]/gi)) {
    try {
      const result = await createCalendarEvent({
        subject: match[1].trim(),
        startDateTime: match[2].trim(),
        endDateTime: match[3].trim(),
        timeZone: match[4]?.trim(),
      });
      actionsExecuted.push(`Created event: ${result.subject}`);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      actionsExecuted.push(`Failed to create event: ${error.message}`);
      clean = clean.replace(match[0], "");
    }
  }

  // [CREATE_DRAFT: to | subject | body]
  for (const match of response.matchAll(/\[CREATE_DRAFT:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi)) {
    try {
      const result = await createDraft({
        to: [match[1].trim()],
        subject: match[2].trim(),
        body: match[3].trim(),
      });
      actionsExecuted.push(`Created draft: ${result.subject}`);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      actionsExecuted.push(`Failed to create draft: ${error.message}`);
      clean = clean.replace(match[0], "");
    }
  }

  // File generation — delegate to the same module used by the relay
  const { clean: afterFiles, files: generatedFiles } = await processFileActions(clean);
  clean = afterFiles;
  for (const filePath of generatedFiles) {
    const name = basename(filePath);
    const sent = await sendTelegramFile(filePath, `📎 ${name}`);
    actionsExecuted.push(sent ? `Created and sent file: ${name}` : `Created file but failed to send: ${name}`);
  }

  return { clean: clean.trim(), actionsExecuted };
}

/**
 * Execute a single Ona task via Claude CLI.
 * Returns { completed, report } — completed means the task is done and should be marked complete.
 */
async function executeOnaTask(task: TodoTask): Promise<{ completed: boolean; report: string; exitCode?: number }> {
  let profileContext = "";
  try {
    profileContext = await readFile(
      join(PROJECT_ROOT, "config", "profile.md"),
      "utf-8"
    );
  } catch {}

  const tz = process.env.USER_TIMEZONE || "America/Sao_Paulo";
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Pre-search with Brave if the task looks like it needs web info
  const taskText = `${task.title} ${task.body || ""}`;
  let searchContext = "";
  if (needsSearch(taskText)) {
    console.log(`  Pre-searching Brave for: "${task.title}"`);
    searchContext = await searchWeb(taskText, 8);
    if (searchContext) {
      console.log(`  Got ${searchContext.length} chars of search results`);
    }
  }

  const prompt = `You are Ona, ${USER_NAME}'s personal AI assistant. You have been assigned a task to complete autonomously.

CURRENT TIME: ${timeStr}

${profileContext ? `ABOUT ${USER_NAME.toUpperCase()}:\n${profileContext}\n` : ""}
TASK DETAILS:
- Title: ${task.title}
- Body: ${task.body || "(no additional details)"}
- Importance: ${task.importance}
- Due: ${task.dueDateTime ? fmtDate(task.dueDateTime) : "no deadline"}
- List: ${task.listName}
${searchContext ? `\n${searchContext}\n` : ""}
AVAILABLE ACTIONS:
You can include these tags to take actions:
[SEND_EMAIL: recipient@email.com | Subject line | Email body text]
[CREATE_EVENT: subject | start_datetime (ISO) | end_datetime (ISO) | timezone]
[CREATE_DRAFT: recipient@email.com | Subject line | Email body text]

FILE CREATION (files are automatically sent to ${USER_NAME} via Telegram):
[CREATE_EXCEL: filename.xlsx | Sheet Name | Header1 \\t Header2 \\n Row1Col1 \\t Row1Col2]
  For Excel: separate columns with \\t (tab), rows with \\n (newline). First row = headers.
[CREATE_DOCX: filename.docx]markdown content here[/CREATE_DOCX]
[CREATE_PDF: filename.pdf]content here[/CREATE_PDF]
[CREATE_HTML: filename.html]<html>content</html>[/CREATE_HTML]
[CREATE_PPTX: filename.pptx | Slide 1 Title | Slide 1 body ||| Slide 2 Title | Slide 2 body]

WEB RESEARCH:
You have access to the WebFetch tool to fetch web pages for deeper research beyond the search results above.
If you need detailed information from a specific URL found in the search results, use WebFetch to read that page.

INSTRUCTIONS:
1. Analyze the task and determine if you can complete it with the available actions, tools, and search results provided.
2. If you CAN complete it: take the action(s) and respond with "TASK_COMPLETED" on the VERY FIRST LINE, followed by a brief summary of what you did. The action tags can appear before or after TASK_COMPLETED — they will be processed either way.
3. If you CANNOT complete it (physical task, truly impossible without human intervention): respond with "TASK_SKIPPED" on the first line, followed by a brief explanation.
4. IMPORTANT: Prefer completing tasks over skipping. If a task asks for a list, recommendations, or a document — use your knowledge and the search results to create it. Use WebFetch only if you need deeper detail from a specific URL.
5. Be concise. No pleasantries. Just execute and report.`;

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    // Match the relay's proven approach: Node spawn + shell on Windows + stdin piping
    const claudeArgs = [
      "--no-session-persistence",
      "--output-format", "text",
      "--allowedTools", "WebFetch",
    ];

    const promptFile = join(PROJECT_ROOT, `temp_ona_${Date.now()}.txt`);
    await writeFile(promptFile, prompt);

    return await new Promise<{ completed: boolean; report: string; exitCode?: number }>((resolve) => {
      let resolved = false;
      const safeResolve = (value: { completed: boolean; report: string; exitCode?: number }) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const child = nodeSpawn(CLAUDE_PATH, claudeArgs, {
        cwd: PROJECT_ROOT,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let output = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      // Kill after 8 minutes — research tasks with WebFetch need time
      const timeout = setTimeout(() => {
        console.error("  Ona task timed out after 8 minutes");
        child.kill("SIGTERM");
        unlink(promptFile).catch(() => {});
        safeResolve({ completed: false, report: "Claude timed out after 8 minutes" });
      }, 480_000);

      // Pipe the prompt via stdin (avoids Windows arg length limits)
      const fs = require("fs");
      fs.createReadStream(promptFile).pipe(child.stdin!);

      child.on("close", async (code: number | null) => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});

        const trimmed = output.trim();
        console.log(`  Claude response (${trimmed.length} chars, exit ${code}): ${trimmed.substring(0, 300)}`);

        if (code !== 0) {
          console.error(`  Claude exit ${code}, stderr: ${stderr.substring(0, 300)}`);
          safeResolve({ completed: false, report: `Claude error (exit ${code})`, exitCode: code ?? undefined });
          return;
        }

        if (!trimmed) {
          safeResolve({ completed: false, report: "No response from Claude" });
          return;
        }

        try {
          // Process any action tags Claude included
          const { clean, actionsExecuted } = await processActionTags(trimmed);

          // Check anywhere in text — Claude may put preamble before the marker
          const completed = /TASK_COMPLETED/i.test(clean);
          const reportBody = clean
            .replace(/TASK_(COMPLETED|SKIPPED)/gi, "")
            .trim();

          const actionsSummary = actionsExecuted.length
            ? `\nActions: ${actionsExecuted.join(", ")}`
            : "";

          console.log(`  Task result: ${completed ? "COMPLETED" : "SKIPPED"}, actions: ${actionsExecuted.length}`);

          safeResolve({
            completed,
            report: reportBody + actionsSummary,
          });
        } catch (actionError: any) {
          console.error(`  Action processing error: ${actionError.message}`);
          safeResolve({ completed: false, report: `Action error: ${actionError.message}` });
        }
      });

      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        console.error("  Spawn error:", err.message);
        safeResolve({ completed: false, report: `Spawn error: ${err.message}` });
      });
    });
  } catch (error: any) {
    console.error("Ona task execution error:", error);
    return { completed: false, report: `Error: ${error.message}` };
  }
}

async function processOnaTasks(state: CheckinState): Promise<{ count: number; summary: string }> {
  const onaList = await findTaskList("Ona");
  if (!onaList) {
    console.log("No 'Ona' task list found in MS To Do. Skipping autonomous execution.");
    return { count: 0, summary: "No 'Ona' task list found." };
  }

  const tasks = await listTasks(
    onaList.id,
    onaList.displayName,
    "status ne 'completed'"
  );

  if (!tasks.length) {
    console.log("No pending Ona tasks.");
    return { count: 0, summary: "No pending Ona tasks." };
  }

  // Filter out already-executed tasks (retry skipped/failed after 24h)
  const pending = tasks.filter((t) => {
    const entry = state.onaExecutedTasks[`${onaList.id}:${t.id}`];
    if (!entry) return true;
    if (entry.result === "completed") return false;
    // Retry skipped/failed tasks after 24h
    const hoursSince = (Date.now() - new Date(entry.executedAt).getTime()) / 3600000;
    return hoursSince >= 24;
  });

  if (!pending.length) {
    console.log("All Ona tasks already processed.");
    return { count: 0, summary: "All Ona tasks already processed." };
  }

  // Sort: due-today first, then no-due-date, both by importance (high first)
  const today = todayDateStr();
  const importanceOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };

  pending.sort((a, b) => {
    const aDueToday = a.dueDateTime?.startsWith(today) ? 0 : 1;
    const bDueToday = b.dueDateTime?.startsWith(today) ? 0 : 1;
    if (aDueToday !== bDueToday) return aDueToday - bDueToday;
    return (importanceOrder[a.importance] || 1) - (importanceOrder[b.importance] || 1);
  });

  // Cap at 3 tasks per run
  const batch = pending.slice(0, 3);
  console.log(`Processing ${batch.length} Ona task(s) (${pending.length} total pending)...`);

  let tasksProcessed = 0;
  const summaryParts: string[] = [];

  for (const task of batch) {
    const taskKey = `${onaList.id}:${task.id}`;
    console.log(`  Executing: "${task.title}"...`);

    let result = await executeOnaTask(task);

    // Retry once on non-zero exit codes (rate limits, transient API errors)
    if (!result.completed && result.exitCode) {
      console.log(`  Retrying after exit ${result.exitCode} (waiting 15s)...`);
      await new Promise((r) => setTimeout(r, 15_000));
      result = await executeOnaTask(task);
    }

    const { completed, report } = result;

    let markedComplete = false;
    if (completed) {
      // Mark task as completed in MS To Do
      try {
        await updateTask(onaList.id, task.id, { status: "completed" });
        markedComplete = true;
        console.log(`  Completed: "${task.title}"`);
      } catch (error: any) {
        console.error(`  Failed to mark complete in MS To Do: ${error.message}`);
        // Don't record as "completed" if we couldn't update MS To Do
      }
    }

    // Record execution — only mark "completed" if MS To Do was actually updated
    state.onaExecutedTasks[taskKey] = {
      executedAt: new Date().toISOString(),
      result: markedComplete ? "completed" : completed ? "failed" : "skipped",
    };

    // Send report to Telegram
    const statusEmoji = completed ? "\u2705" : "\u{1F4AD}";
    const statusLabel = completed ? "Completed" : "Needs you";

    const message = [
      `\u{1F916} Ona Task Report`,
      ``,
      `${statusEmoji} ${statusLabel}: ${task.title}`,
      task.dueDateTime ? `\u{1F4C5} Due: ${fmtDate(task.dueDateTime)}` : "",
      ``,
      report,
    ].filter(Boolean).join("\n");

    await sendTelegram(message);
    await saveAlertToMessages(message, { type: "ona-task-report", taskTitle: task.title });
    tasksProcessed++;
    summaryParts.push(`${statusLabel}: "${task.title}"`);

    // Delay between tasks to avoid rate limits
    if (batch.indexOf(task) < batch.length - 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const summary = summaryParts.length
    ? `Processed ${summaryParts.length} Ona tasks: ${summaryParts.join("; ")}`
    : "No Ona tasks processed.";
  return { count: tasksProcessed, summary };
}

// ============================================================
// SECTION 5: MY CALENDAR
// ============================================================

async function checkCalendar(state: CheckinState): Promise<{ count: number; summary: string; events: CalendarEvent[] }> {
  const tz = process.env.USER_TIMEZONE || "America/Sao_Paulo";
  const now = new Date();

  // Build today and tomorrow date ranges in user's timezone
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const todayStart = new Date(`${todayStr}T00:00:00`).toISOString();
  const todayEnd = new Date(`${todayStr}T23:59:59`).toISOString();

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: tz });
  const tomorrowStart = new Date(`${tomorrowStr}T00:00:00`).toISOString();
  const tomorrowEnd = new Date(`${tomorrowStr}T23:59:59`).toISOString();

  const [todayEvents, tomorrowEvents] = await Promise.all([
    listCalendarEvents(todayStart, todayEnd),
    listCalendarEvents(tomorrowStart, tomorrowEnd),
  ]);

  const allEvents = [...todayEvents, ...tomorrowEvents];
  const nowMs = now.getTime();
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const thirtyMinMs = 30 * 60 * 1000;

  const alertLines: string[] = [];
  const alertedIds: string[] = [];

  // Events starting within 30 min (urgent)
  const startingSoon = todayEvents.filter(e => {
    const diff = new Date(e.start).getTime() - nowMs;
    return diff > 0 && diff <= thirtyMinMs;
  });

  // Events starting within 2 hours
  const upcoming = todayEvents.filter(e => {
    const diff = new Date(e.start).getTime() - nowMs;
    return diff > 0 && diff <= twoHoursMs;
  });

  // Events needing RSVP (not accepted, not organizer, not "none")
  const needsRsvp = allEvents.filter(e =>
    e.status !== "accepted" && e.status !== "organizer" && e.status !== "none"
  );

  // Build alert lines — only for items not already alerted
  for (const event of startingSoon) {
    if (!state.alertedCalendarEvents[event.id]) {
      const startTime = new Date(event.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      const minutesAway = Math.round((new Date(event.start).getTime() - nowMs) / 60000);
      const link = event.isOnline && event.onlineUrl ? ` \u2014 ${event.onlineUrl}` : event.isOnline ? " [Online]" : "";
      const loc = event.location ? ` @ ${event.location}` : "";
      alertLines.push(`\u{1F6A8} STARTING IN ${minutesAway}min: ${event.subject} at ${startTime}${loc}${link}`);
      alertedIds.push(event.id);
    }
  }

  for (const event of upcoming) {
    if (!startingSoon.includes(event) && !state.alertedCalendarEvents[event.id]) {
      const startTime = new Date(event.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      const minutesAway = Math.round((new Date(event.start).getTime() - nowMs) / 60000);
      const link = event.isOnline && event.onlineUrl ? ` \u2014 ${event.onlineUrl}` : event.isOnline ? " [Online]" : "";
      alertLines.push(`\u23F0 In ${minutesAway}min: ${event.subject} at ${startTime}${link}`);
      alertedIds.push(event.id);
    }
  }

  for (const event of needsRsvp) {
    if (!state.alertedCalendarEvents[`rsvp:${event.id}`]) {
      const day = todayEvents.includes(event) ? "Today" : "Tomorrow";
      const startTime = new Date(event.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      alertLines.push(`\u2753 Needs RSVP (${day}): ${event.subject} at ${startTime} (${event.status})`);
      alertedIds.push(`rsvp:${event.id}`);
    }
  }

  // Send alert if there are items
  let alertsSent = 0;
  if (alertLines.length > 0) {
    const message = [`\u{1F4C5} Calendar Alert`, ``, ...alertLines].join("\n");
    const sent = await sendTelegram(message);
    if (sent) {
      await saveAlertToMessages(message, { type: "calendar-alert" });
      const nowIso = new Date().toISOString();
      for (const id of alertedIds) {
        state.alertedCalendarEvents[id] = { alertedAt: nowIso };
      }
      alertsSent = alertLines.length;
    }
  }

  // Build summary for proactive layer (always, regardless of alerts sent)
  const restOfDay = todayEvents.filter(e => new Date(e.start).getTime() > nowMs);
  const summaryParts: string[] = [];

  if (restOfDay.length) {
    summaryParts.push(`Rest of today: ${restOfDay.map(e => {
      const t = new Date(e.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      return `${t} ${e.subject}`;
    }).join(", ")}`);
  } else {
    summaryParts.push("No more events today.");
  }

  if (tomorrowEvents.length) {
    summaryParts.push(`Tomorrow: ${tomorrowEvents.length} events \u2014 ${tomorrowEvents.map(e => e.subject).join(", ")}`);
  } else {
    summaryParts.push("No events tomorrow.");
  }

  if (needsRsvp.length) {
    summaryParts.push(`${needsRsvp.length} events need RSVP.`);
  }

  return { count: alertsSent, summary: summaryParts.join(" "), events: allEvents };
}

// ============================================================
// SECTION 5.5: POST-MEETING NOTION SYNC
// ============================================================

/**
 * After Teams meetings end, fetch transcripts and push summaries to Notion.
 * Only processes meetings that:
 *   - Are Teams meetings (online with join URL)
 *   - Ended more than 10 minutes ago (transcript needs processing time)
 *   - Haven't been synced to Notion yet (tracked in state)
 */
async function syncMeetingsToNotion(
  state: CheckinState,
  calendarEvents: CalendarEvent[],
): Promise<{ count: number; summary: string }> {
  if (!isNotionEnabled()) {
    return { count: 0, summary: "Notion not configured." };
  }

  const tz = process.env.USER_TIMEZONE || "America/Sao_Paulo";
  const now = Date.now();
  const TEN_MIN = 10 * 60 * 1000;

  // Filter: Teams meetings that ended 10+ min ago and not yet synced
  const endedMeetings = calendarEvents.filter(e => {
    if (!e.isOnline || !e.onlineUrl) return false;
    const endMs = new Date(e.end).getTime();
    if (endMs > now - TEN_MIN) return false; // too recent, transcript may not be ready
    if (state.notionSyncedMeetings[e.id]) return false; // already synced
    return true;
  });

  if (!endedMeetings.length) {
    return { count: 0, summary: "No new ended meetings to sync." };
  }

  let synced = 0;
  const summaryParts: string[] = [];

  for (const event of endedMeetings) {
    try {
      console.log(`Fetching transcript for: ${event.subject}`);
      const transcript = await getMeetingTranscript(event.onlineUrl!, event.subject);

      if (!transcript) {
        console.log(`No transcript available for: ${event.subject}`);
        summaryParts.push(`${event.subject}: no transcript`);
        continue;
      }

      // Use Claude to summarize the transcript
      const summaryPrompt = [
        "Summarize this Teams meeting transcript concisely. Return EXACTLY this format (no markdown, no extra text):",
        "",
        "SUMMARY:",
        "(2-4 sentences covering key topics discussed)",
        "",
        "ACTION ITEMS:",
        "(bulleted list of tasks assigned, with names if mentioned)",
        "",
        "DECISIONS:",
        "(bulleted list of decisions made)",
        "",
        "If any section has nothing, write 'None'.",
        "",
        `Meeting: ${event.subject}`,
        `Organizer: ${event.organizer}`,
        "",
        "TRANSCRIPT:",
        transcript,
      ].join("\n");

      const claudeSummary = await callClaudeForSummary(summaryPrompt);

      // Parse Claude's response
      const summaryMatch = claudeSummary.match(/SUMMARY:\s*([\s\S]*?)(?=ACTION ITEMS:|$)/i);
      const actionsMatch = claudeSummary.match(/ACTION ITEMS:\s*([\s\S]*?)(?=DECISIONS:|$)/i);
      const decisionsMatch = claudeSummary.match(/DECISIONS:\s*([\s\S]*?)$/i);

      // Calculate duration
      const startMs = new Date(event.start).getTime();
      const endMs = new Date(event.end).getTime();
      const durationMin = Math.round((endMs - startMs) / 60000);
      const durationStr = durationMin >= 60
        ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}min`
        : `${durationMin} min`;

      // Push to Notion
      const page = await createMeetingPage({
        subject: event.subject,
        date: event.start,
        endDate: event.end,
        organizer: event.organizer,
        duration: durationStr,
        summary: summaryMatch?.[1]?.trim() || "Meeting transcript processed.",
        actionItems: actionsMatch?.[1]?.trim() || "None",
        decisions: decisionsMatch?.[1]?.trim() || "None",
        fullTranscript: transcript,
      });

      // Mark as synced
      state.notionSyncedMeetings[event.id] = {
        syncedAt: new Date().toISOString(),
        pageId: page.id,
      };

      // Notify user
      const timeStr = new Date(event.start).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", timeZone: tz,
      });
      const msg = `📝 Meeting notes synced to Notion\n\n${event.subject} (${timeStr})\nDuration: ${durationStr}\n\n${summaryMatch?.[1]?.trim().substring(0, 200) || "Summary available in Notion."}`;
      await sendTelegram(msg);
      await saveAlertToMessages(msg, { type: "notion-sync", meetingSubject: event.subject });

      synced++;
      summaryParts.push(`${event.subject}: synced ✅`);
      console.log(`Synced to Notion: ${event.subject} → ${page.id}`);
    } catch (error: any) {
      console.error(`Notion sync failed for "${event.subject}":`, error.message);
      summaryParts.push(`${event.subject}: error — ${error.message}`);
    }
  }

  return {
    count: synced,
    summary: summaryParts.length ? summaryParts.join("; ") : "No meetings synced.",
  };
}

/**
 * Call Claude CLI to summarize a transcript.
 * Lightweight call — no MCP, no tools, just text in/out.
 */
async function callClaudeForSummary(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(CLAUDE_PATH, [
      "--print",
      "--max-turns", "1",
      "--model", "sonnet",
      "-p", prompt,
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`Claude exited ${code}: ${stderr.substring(0, 200)}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.on("error", reject);
  });
}

// ============================================================
// SECTION 6: WHATSAPP UNREAD MESSAGES
// ============================================================

/** Fetch unread WhatsApp messages from the bridge and draft replies via Claude */
async function checkWhatsApp(state: CheckinState): Promise<{ count: number; summary: string }> {
  // Check if WhatsApp is enabled and connected
  if (!isWhatsAppEnabled()) {
    return { count: 0, summary: "WhatsApp not enabled." };
  }

  const connected = await isWhatsAppConnected().catch(() => false);
  if (!connected) {
    console.log("WhatsApp bridge not connected.");
    return { count: 0, summary: "WhatsApp bridge not connected." };
  }

  // Fetch unread messages from the bridge
  let unreadMessages: WABridgeMessage[] = [];
  try {
    const resp = await fetch(`http://127.0.0.1:${WA_BRIDGE_PORT}/messages`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      console.log(`WhatsApp bridge returned ${resp.status}`);
      return { count: 0, summary: "WhatsApp bridge error." };
    }
    const data = await resp.json() as { messages: WABridgeMessage[] };
    unreadMessages = (data.messages || []).filter(m => !m.isRead);
  } catch (error: any) {
    console.error("Failed to fetch WhatsApp messages:", error.message);
    return { count: 0, summary: `Error fetching WhatsApp: ${error.message}` };
  }

  if (!unreadMessages.length) {
    console.log("No unread WhatsApp messages.");
    return { count: 0, summary: "No unread WhatsApp messages." };
  }

  // Group messages by sender (JID)
  const grouped = new Map<string, { name: string; jid: string; isGroup: boolean; groupName?: string; messages: WABridgeMessage[] }>();
  for (const msg of unreadMessages) {
    const key = msg.from;
    if (!grouped.has(key)) {
      grouped.set(key, {
        name: msg.isGroup ? (msg.groupName || msg.fromName) : msg.fromName,
        jid: msg.from,
        isGroup: !!msg.isGroup,
        groupName: msg.groupName,
        messages: [],
      });
    }
    grouped.get(key)!.messages.push(msg);
  }

  console.log(`Found ${unreadMessages.length} unread WhatsApp messages from ${grouped.size} conversations.`);

  const tz = process.env.USER_TIMEZONE || "America/Sao_Paulo";

  // Format conversation context for Claude to draft replies
  const conversationBlocks: string[] = [];
  for (const [, conv] of grouped) {
    const label = conv.isGroup ? `Group: ${conv.groupName || conv.name}` : conv.name;
    const msgLines = conv.messages.map(m => {
      const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      const sender = conv.isGroup && m.participantName ? `${m.participantName}: ` : "";
      return `  [${time}] ${sender}${m.text}`;
    }).join("\n");
    conversationBlocks.push(`${label} [${conv.jid}]:\n${msgLines}`);
  }

  const allConversationsText = conversationBlocks.join("\n\n");

  // Spawn Claude to draft replies
  let drafts = "";
  try {
    let profileContext = "";
    try {
      profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
    } catch {}

    const now = new Date();
    const timeStr = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const draftPrompt = `You are Ona, ${USER_NAME}'s personal AI assistant. You need to summarize unread WhatsApp messages and suggest draft replies.

CURRENT TIME: ${timeStr}

${profileContext ? `ABOUT ${USER_NAME.toUpperCase()}:\n${profileContext}\n` : ""}
UNREAD WHATSAPP MESSAGES:
${allConversationsText}

INSTRUCTIONS:
1. For each conversation, write a brief summary of what the person/group is saying.
2. For each conversation that expects a reply, suggest a SHORT draft reply (1-3 sentences).
3. Match the language the person used (Portuguese or English).
4. Use ${USER_NAME}'s communication style — warm, direct, friendly.
5. For group chats, only suggest a reply if ${USER_NAME} was directly addressed or the topic is relevant.
6. Include the JID in your draft so the user can say "send it" and the relay knows where to send.
7. Format each conversation like:

📱 **Name** (N messages)
Summary of what they said.
💬 Draft: "Your suggested reply"
(JID: the_jid_here)

8. Be concise. No preamble.`;

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const claudeArgs = ["--no-session-persistence", "--output-format", "text"];
    const promptFile = join(PROJECT_ROOT, `temp_whatsapp_${Date.now()}.txt`);
    await writeFile(promptFile, draftPrompt);

    drafts = await new Promise<string>((resolve) => {
      const child = nodeSpawn(CLAUDE_PATH, claudeArgs, {
        cwd: PROJECT_ROOT,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let output = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", () => {});

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        unlink(promptFile).catch(() => {});
        resolve("");
      }, 180_000); // 3 min timeout

      const fs = require("fs");
      fs.createReadStream(promptFile).pipe(child.stdin!);

      child.on("close", () => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        resolve(output.trim());
      });

      child.on("error", () => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        resolve("");
      });
    });
  } catch (error: any) {
    console.error("WhatsApp draft generation failed:", error.message);
  }

  // Build Telegram alert
  const alertParts: string[] = [
    `📱 WhatsApp — ${unreadMessages.length} unread message${unreadMessages.length > 1 ? "s" : ""} from ${grouped.size} conversation${grouped.size > 1 ? "s" : ""}`,
    ``,
  ];

  if (drafts) {
    alertParts.push(drafts);
  } else {
    // Fallback: just list the conversations without drafts
    for (const [, conv] of grouped) {
      const label = conv.isGroup ? `Group: ${conv.groupName || conv.name}` : conv.name;
      const lastMsg = conv.messages[conv.messages.length - 1];
      const preview = lastMsg.text.substring(0, 100).replace(/\n/g, " ");
      alertParts.push(`• ${label}: "${preview}${lastMsg.text.length > 100 ? "..." : ""}"`);
    }
    alertParts.push(``);
    alertParts.push(`➡ Tell me to reply to any of these.`);
  }

  const message = alertParts.join("\n");
  const sent = await sendTelegram(message);
  if (sent) {
    await saveAlertToMessages(message, { type: "whatsapp-alert" });
  }

  // Build summary for proactive layer
  const summaryNames = Array.from(grouped.values()).map(c =>
    `${c.isGroup ? "Group:" : ""} ${c.name} (${c.messages.length} msgs)`
  ).join("; ");
  const summary = `${unreadMessages.length} unread WhatsApp messages from: ${summaryNames}`;

  return { count: sent ? grouped.size : 0, summary };
}

// ============================================================
// SECTION 7: PROACTIVE ANALYSIS
// ============================================================

async function runProactiveAnalysis(
  state: CheckinState,
  results: SectionResults,
  recentHistory: string,
  memoryContext: string,
): Promise<number> {
  // Rate limit: only run proactive analysis every 2 hours
  if (state.lastProactiveAt) {
    const hoursSince = (Date.now() - new Date(state.lastProactiveAt).getTime()) / 3600000;
    if (hoursSince < 2) {
      console.log(`Proactive analysis skipped \u2014 last run ${hoursSince.toFixed(1)}h ago (min 2h).`);
      return 0;
    }
  }

  let profileContext = "";
  try {
    profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
  } catch {}

  const tz = process.env.USER_TIMEZONE || "America/Sao_Paulo";
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Build context blob for Claude
  const contextSections: string[] = [];
  contextSections.push(`CURRENT TIME: ${timeStr}`);

  if (profileContext) {
    contextSections.push(`ABOUT ${USER_NAME.toUpperCase()}:\n${profileContext}`);
  }
  if (memoryContext) {
    contextSections.push(`MEMORY (facts & goals):\n${memoryContext}`);
  }
  if (recentHistory) {
    contextSections.push(`RECENT CONVERSATIONS (last 20 messages):\n${recentHistory}`);
  }

  // Section summaries
  contextSections.push(`--- CURRENT STATUS (gathered just now) ---`);
  contextSections.push(`HOSPITABLE (Airbnb): ${results.hospitable.summary}`);
  contextSections.push(`ONA TASKS (autonomous): ${results.onaTasks.summary}`);
  contextSections.push(`MY TASKS: ${results.myTasks.summary}`);
  contextSections.push(`MY EMAILS: ${results.myEmails.summary}`);
  contextSections.push(`MY CALENDAR: ${results.myCalendar.summary}`);
  contextSections.push(`WHATSAPP: ${results.whatsapp.summary}`);

  // Include calendar event details for richer analysis
  if (results.myCalendar.events.length) {
    const eventDetails = results.myCalendar.events.map(e => {
      const start = new Date(e.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      const end = new Date(e.end).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      return `- ${start}-${end}: ${e.subject} (${e.organizer}, status: ${e.status})${e.isOnline ? " [Online]" : ""}${e.location ? ` @ ${e.location}` : ""}`;
    }).join("\n");
    contextSections.push(`CALENDAR DETAILS:\n${eventDetails}`);
  }

  const prompt = `You are Ona, ${USER_NAME}'s proactive AI assistant. You have just gathered all of ${USER_NAME}'s current context. Your job: decide if there is anything worth reaching out about RIGHT NOW.

${contextSections.join("\n\n")}

INSTRUCTIONS:
1. Analyze ALL the context above holistically. Look for:
   - Connections between calendar events and tasks/emails (e.g., meeting prep needed)
   - Forgotten follow-ups (emails from days ago with no reply)
   - Goal alignment (is ${USER_NAME} making progress on stated goals?)
   - Time-sensitive opportunities or risks
   - Travel logistics that need attention
   - Guest check-ins that need a personal touch
   - Anything a thoughtful chief-of-staff would flag

2. If you find something worth sharing, respond with:
   PROACTIVE: YES
   Then write a brief, actionable message (3-8 sentences max) in Ona's personality \u2014 warm, witty, direct.

3. If nothing is worth flagging right now, respond with:
   PROACTIVE: NO

4. Rules:
   - Do NOT repeat information that was ALREADY sent as an alert (the sections above already handled urgent items)
   - Focus on CONNECTIONS and INSIGHTS that individual sections would miss
   - Be genuinely helpful, not annoying \u2014 if in doubt, stay silent
   - Keep it concise. ${USER_NAME} is busy.
   - No action tags. Just insights and suggestions in natural language.`;

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const claudeArgs = ["--no-session-persistence", "--output-format", "text"];
    const promptFile = join(PROJECT_ROOT, `temp_proactive_${Date.now()}.txt`);
    await writeFile(promptFile, prompt);

    const result = await new Promise<string>((resolve) => {
      const child = nodeSpawn(CLAUDE_PATH, claudeArgs, {
        cwd: PROJECT_ROOT,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let output = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", () => {}); // discard

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        unlink(promptFile).catch(() => {});
        resolve("");
      }, 300_000); // 5 minute timeout

      const fs = require("fs");
      fs.createReadStream(promptFile).pipe(child.stdin!);

      child.on("close", () => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        resolve(output.trim());
      });

      child.on("error", () => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        resolve("");
      });
    });

    if (!result) {
      console.log("Proactive analysis: no response from Claude.");
      return 0;
    }

    const isYes = /PROACTIVE:\s*YES/i.test(result);

    if (!isYes) {
      console.log("Proactive analysis: nothing worth flagging.");
      state.lastProactiveAt = new Date().toISOString();
      return 0;
    }

    // Extract the message (everything after "PROACTIVE: YES")
    const message = result.replace(/PROACTIVE:\s*YES\s*/i, "").trim();

    if (!message) {
      console.log("Proactive analysis: YES but empty message.");
      state.lastProactiveAt = new Date().toISOString();
      return 0;
    }

    const telegramMsg = `\u{1F4A1} Ona's Insight\n\n${message}`;
    const sent = await sendTelegram(telegramMsg);

    if (sent) {
      await saveAlertToMessages(telegramMsg, { type: "proactive-insight" });
      state.lastProactiveAt = new Date().toISOString();
      console.log("Proactive insight sent.");
      return 1;
    }

    return 0;
  } catch (error: any) {
    console.error("Proactive analysis failed:", error.message);
    return 0;
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running smart check-in...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const state = await loadState();
  pruneState(state);

  // ── Meta-layer: gather context before sections ──
  let recentHistory = "";
  let memoryContext = "";

  if (supabase) {
    console.log("\n--- Meta: Gathering context ---");
    try {
      [recentHistory, memoryContext] = await Promise.all([
        getRecentHistory(supabase, 20),
        getMemoryContext(supabase),
      ]);
      console.log(`Context loaded: ${recentHistory.length} chars history, ${memoryContext.length} chars memory.`);
    } catch (error: any) {
      console.error("Context gathering failed:", error.message);
    }
  }

  // Initialize results collector for proactive analysis
  const results: SectionResults = {
    hospitable: { alertsSent: 0, summary: "Skipped (not configured)." },
    onaTasks: { tasksProcessed: 0, summary: "Skipped (MS365 not enabled)." },
    myTasks: { alertsSent: 0, summary: "Skipped (MS365 not enabled)." },
    myEmails: { alertsSent: 0, summary: "Skipped (MS365 not enabled)." },
    myCalendar: { alertsSent: 0, summary: "Skipped (MS365 not enabled).", events: [] },
    notionSync: { syncedCount: 0, summary: "Skipped (not configured)." },
    whatsapp: { alertsSent: 0, summary: "Skipped (not enabled)." },
  };

  // ── Section 1: Hospitable (Airbnb) ──
  if (process.env.HOSPITABLE_API_TOKEN) {
    console.log("\n--- Section 1: Hospitable (Airbnb) ---");
    try {
      const { count, summary } = await checkHospitableGuests(state);
      results.hospitable = { alertsSent: count, summary };
      console.log(`Guest alerts sent: ${count}`);
    } catch (error: any) {
      console.error("Hospitable check failed:", error.message);
      results.hospitable.summary = `Error: ${error.message}`;
    }
  } else {
    console.log("Hospitable not configured, skipping.");
  }

  if (process.env.MS365_ENABLED === "true") {
    // ── Section 2: Ona Task List ──
    console.log("\n--- Section 2: Ona Task Execution ---");
    try {
      const { count, summary } = await processOnaTasks(state);
      results.onaTasks = { tasksProcessed: count, summary };
      console.log(`Ona tasks processed: ${count}`);
    } catch (error: any) {
      console.error("Ona task execution failed:", error.message);
      results.onaTasks.summary = `Error: ${error.message}`;
    }

    // ── Section 3: My Task List ──
    console.log("\n--- Section 3: My Tasks ---");
    try {
      const { count, summary } = await checkGilTasks(state);
      results.myTasks = { alertsSent: count, summary };
      console.log(`Task alerts sent: ${count}`);
    } catch (error: any) {
      console.error("Task check failed:", error.message);
      results.myTasks.summary = `Error: ${error.message}`;
    }

    // ── Section 4: My Emails ──
    console.log("\n--- Section 4: My Emails ---");
    try {
      const { count, summary } = await checkNewEmails(state);
      results.myEmails = { alertsSent: count, summary };
      console.log(`Email alerts sent: ${count}`);
    } catch (error: any) {
      console.error("Email check failed:", error.message);
      results.myEmails.summary = `Error: ${error.message}`;
    }

    // ── Section 5: My Calendar ──
    console.log("\n--- Section 5: My Calendar ---");
    try {
      const { count, summary, events } = await checkCalendar(state);
      results.myCalendar = { alertsSent: count, summary, events };
      console.log(`Calendar alerts sent: ${count}`);

      // ── Section 5.5: Notion Meeting Sync ──
      if (isNotionEnabled()) {
        console.log("\n--- Section 5.5: Notion Meeting Sync ---");
        try {
          const { count: syncCount, summary: syncSummary } = await syncMeetingsToNotion(state, events);
          results.notionSync = { syncedCount: syncCount, summary: syncSummary };
          console.log(`Meetings synced to Notion: ${syncCount}`);
        } catch (error: any) {
          console.error("Notion sync failed:", error.message);
          results.notionSync.summary = `Error: ${error.message}`;
        }
      }
    } catch (error: any) {
      console.error("Calendar check failed:", error.message);
      results.myCalendar.summary = `Error: ${error.message}`;
    }
  } else {
    console.log("MS365 not enabled, skipping sections 2-5.");
  }

  // ── Section 6: WhatsApp ──
  console.log("\n--- Section 6: WhatsApp ---");
  try {
    const { count, summary } = await checkWhatsApp(state);
    results.whatsapp = { alertsSent: count, summary };
    console.log(`WhatsApp alerts sent: ${count}`);
  } catch (error: any) {
    console.error("WhatsApp check failed:", error.message);
    results.whatsapp.summary = `Error: ${error.message}`;
  }

  // ── Section 7: Proactive Analysis ──
  console.log("\n--- Section 7: Proactive Analysis ---");
  try {
    const proactiveAlerts = await runProactiveAnalysis(state, results, recentHistory, memoryContext);
    console.log(`Proactive insights sent: ${proactiveAlerts}`);
  } catch (error: any) {
    console.error("Proactive analysis failed:", error.message);
  }

  // Save state
  state.lastRunTime = new Date().toISOString();
  await saveState(state);

  console.log("\nSmart check-in complete.");
}

main().catch((error) => {
  console.error("Smart check-in failed:", error);
  process.exit(1);
});
