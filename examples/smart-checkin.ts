/**
 * Smart Check-in — Hospitable Guest Message Alerts
 *
 * Runs every 15 minutes (via PM2 or cron). Pulls real conversations
 * from Hospitable, identifies unanswered guest messages, has Claude
 * draft replies, and sends alerts to Telegram for Gil's approval.
 *
 * Approval flow: Gil sees the alert, opens the bot, and types
 * "reply to [guest]'s inquiry: [message]" — the relay handles it.
 *
 * Run: bun run examples/smart-checkin.ts
 */

import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import {
  listProperties,
  getReservations,
  getInquiries,
  getMessages,
  getInquiryMessages,
  type Reservation,
  type Inquiry,
  type GuestMessage,
} from "../src/hospitable.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
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

interface CheckinState {
  lastRunTime: string;
  alertedConversations: Record<string, AlertedEntry>;
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

// ============================================================
// STATE MANAGEMENT
// ============================================================

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastRunTime: "",
      alertedConversations: {},
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Remove alerted entries older than 7 days */
function pruneState(state: CheckinState): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(state.alertedConversations)) {
    if (new Date(entry.alertedAt).getTime() < cutoff) {
      delete state.alertedConversations[id];
    }
  }
}

// ============================================================
// URGENCY CLASSIFICATION
// ============================================================

function classifyUrgency(
  type: "reservation" | "inquiry",
  status: string,
  ageMinutes: number
): { tier: UrgencyTier; label: string } {
  if (type === "inquiry" && ageMinutes < 120) {
    return { tier: "critical", label: "Inquiry (pre-booking)" };
  }
  if (type === "inquiry" && ageMinutes < 720) {
    return { tier: "high", label: "Inquiry" };
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
    return response.ok;
  } catch {
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

// ============================================================
// DRAFT REPLY VIA CLAUDE
// ============================================================

async function draftReply(conv: UnansweredConversation): Promise<string> {
  // Load profile for style context
  let profileContext = "";
  try {
    profileContext = await readFile(
      join(PROJECT_ROOT, "config", "profile.md"),
      "utf-8"
    );
  } catch {}

  // Build conversation transcript
  const transcript = conv.messages
    .map((m) => {
      const sender = m.senderType === "host" ? "Host (Gil)" : `Guest (${m.senderName})`;
      return `${sender}: ${m.body}`;
    })
    .join("\n");

  // Detect likely language from guest messages
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

    const proc = spawn([CLAUDE_PATH, "-p", prompt, "--output-format", "text"], {
      stdout: "pipe",
      stderr: "pipe",
      env: cleanEnv,
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    return output.trim() || "(Could not generate draft)";
  } catch (error) {
    console.error("Claude draft error:", error);
    return "(Could not generate draft)";
  }
}

// ============================================================
// FORMAT ALERT
// ============================================================

function formatAlert(conv: UnansweredConversation, draft: string): string {
  const emoji = URGENCY_EMOJI[conv.urgency];
  const tierLabel = conv.urgency.toUpperCase();
  const dates = `${fmtDate(conv.arrivalDate)}\u2013${fmtDate(conv.departureDate)}`;

  // Recent messages (last 3)
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
  ].join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running smart check-in (Hospitable guest alerts)...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  if (!process.env.HOSPITABLE_API_TOKEN) {
    console.error("Missing HOSPITABLE_API_TOKEN — cannot check guest messages");
    process.exit(1);
  }

  const state = await loadState();
  pruneState(state);

  // Step 1: Fetch properties
  let properties;
  try {
    properties = await listProperties();
  } catch (error: any) {
    console.error("Failed to list properties:", error.message);
    process.exit(1);
  }

  if (!properties.length) {
    console.log("No properties found. Exiting.");
    process.exit(0);
  }

  const propertyIds = properties.map((p) => p.id);
  console.log(`Found ${properties.length} properties: ${properties.map((p) => p.name).join(", ")}`);

  // Step 2: Fetch reservations + inquiries
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

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
    process.exit(1);
  }

  console.log(`Found ${reservations.length} reservations, ${inquiries.length} inquiries`);

  // Step 3: Filter to recent conversations and check messages
  const now = Date.now();
  const unanswered: UnansweredConversation[] = [];

  // Process reservations
  for (const res of reservations) {
    // Skip if no recent messages
    if (!res.lastMessageAt) continue;
    const lastMsgAge = (now - new Date(res.lastMessageAt).getTime()) / 60000;
    if (lastMsgAge > 2880) continue; // Skip if last message > 48h ago

    // Skip departed guests unless message < 24h
    const departed = new Date(res.departureDate).getTime() < now;
    if (departed && lastMsgAge > 1440) continue;

    try {
      const messages = await getMessages(res.id);
      if (!messages.length) continue;

      const lastMsg = messages[messages.length - 1];
      // Only alert if last message is from guest (host needs to reply)
      if (lastMsg.senderType === "host") continue;

      const lastGuestMsgTime = lastMsg.createdAt;
      const ageMinutes = (now - new Date(lastGuestMsgTime).getTime()) / 60000;

      // Skip if already alerted for this exact message
      const alerted = state.alertedConversations[res.id];
      if (alerted && alerted.lastGuestMessageAt === lastGuestMsgTime) continue;

      const { tier, label } = classifyUrgency("reservation", res.status, ageMinutes);
      // Skip low urgency by default
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
    if (lastMsgAge > 2880) continue; // Skip if > 48h ago

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

  // Step 4: Sort by urgency, take top 5
  unanswered.sort((a, b) => {
    const tierDiff = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (tierDiff !== 0) return tierDiff;
    return a.ageMinutes - b.ageMinutes; // within same tier, oldest first
  });

  const toAlert = unanswered.slice(0, 5);

  if (!toAlert.length) {
    console.log("No new unanswered guest messages. All clear!");
    state.lastRunTime = new Date().toISOString();
    await saveState(state);
    return;
  }

  console.log(`Found ${unanswered.length} unanswered conversations, alerting on top ${toAlert.length}`);

  // Step 5: Draft replies and send alerts
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
        alertsSent++;
        // Record that we alerted for this message
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

      // Small delay between alerts to avoid Telegram rate limits
      if (toAlert.indexOf(conv) < toAlert.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e: any) {
      console.error(`Error alerting for ${conv.guestName}:`, e.message);
    }
  }

  // Save state
  state.lastRunTime = new Date().toISOString();
  await saveState(state);

  console.log(`Done! Sent ${alertsSent}/${toAlert.length} alerts.`);
}

main().catch((error) => {
  console.error("Smart check-in failed:", error);
  process.exit(1);
});
