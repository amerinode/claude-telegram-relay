/**
 * Morning Briefing — 7-Section Daily Briefing
 *
 * Sections:
 * 1. Header — "Good Morning!" + date
 * 2. Weather — São Paulo (or user location)
 * 3. Today's Schedule — calendar events
 * 4. Inbox — unread emails summary
 * 5. Active Goals — from Supabase memory
 * 6. Telecom, AI & Financial News — Brave Search
 * 7. Airbnb/Hospitable — MTD earnings, payouts, next 7 days
 *
 * Run manually: bun run examples/morning-briefing.ts
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient } from "@supabase/supabase-js";
import {
  getFinancialsFromSupabase,
  getReservations,
  getMessages,
  getInquiries,
  getInquiryMessages,
  listProperties,
} from "../src/hospitable";
import {
  listCalendarEvents,
  listEmails,
  type CalendarEvent,
  type Email,
} from "../src/ms365";
import { getMemoryContext } from "../src/memory";
import { searchWeb } from "../src/search";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const USER_NAME = process.env.USER_NAME || "Gil";
const USER_TIMEZONE = process.env.USER_TIMEZONE || "America/Sao_Paulo";

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// TELEGRAM HELPER
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
          parse_mode: "Markdown",
        }),
      }
    );

    if (!response.ok) {
      const retry = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: CHAT_ID, text: message }),
        }
      );
      return retry.ok;
    }

    return true;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// SECTION 2: WEATHER
// ============================================================

async function getWeather(): Promise<string> {
  try {
    const location = "São Paulo, Vila Leopoldina";
    const result = await searchWeb(`weather ${location} today forecast temperature`, 3);
    if (!result) return "Weather unavailable";
    // Extract just the descriptions for brevity
    const lines = result
      .split("\n")
      .filter(l => l.trim() && !l.startsWith("WEB SEARCH") && !l.startsWith("   http"))
      .slice(0, 6)
      .map(l => l.replace(/^\d+\.\s+\*\*.*?\*\*\s*/, "").replace(/^   /, "").trim())
      .filter(Boolean)
      .join(" | ");
    return lines || "Weather unavailable";
  } catch {
    return "Weather unavailable";
  }
}

// ============================================================
// SECTION 3: TODAY'S SCHEDULE
// ============================================================

async function getCalendarData(): Promise<{ today: CalendarEvent[]; tomorrow: CalendarEvent[] }> {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
  const todayStart = new Date(`${todayStr}T00:00:00`).toISOString();
  const todayEnd = new Date(`${todayStr}T23:59:59`).toISOString();

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
  const tomorrowStart = new Date(`${tomorrowStr}T00:00:00`).toISOString();
  const tomorrowEnd = new Date(`${tomorrowStr}T23:59:59`).toISOString();

  const [todayEvents, tomorrowEvents] = await Promise.all([
    listCalendarEvents(todayStart, todayEnd),
    listCalendarEvents(tomorrowStart, tomorrowEnd),
  ]);

  return { today: todayEvents, tomorrow: tomorrowEvents };
}

function formatCalendarSection(today: CalendarEvent[], tomorrow: CalendarEvent[]): string {
  const fmt = (events: CalendarEvent[], label: string): string => {
    if (!events.length) return `*${label}:* Nothing scheduled`;
    const lines = events.map(e => {
      const start = new Date(e.start).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: USER_TIMEZONE,
      });
      const end = new Date(e.end).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: USER_TIMEZONE,
      });
      const online = e.isOnline ? " [Teams]" : "";
      const rsvp = e.status !== "accepted" && e.status !== "organizer" ? ` ⚠️ ${e.status}` : "";
      return `- ${start}–${end}: ${e.subject}${online}${rsvp}`;
    });
    return `*${label}:*\n${lines.join("\n")}`;
  };

  const parts = [fmt(today, "Today")];
  if (tomorrow.length) parts.push(fmt(tomorrow, "Tomorrow"));
  return parts.join("\n\n");
}

// ============================================================
// SECTION 4: INBOX
// ============================================================

async function getUnreadEmails(): Promise<{ emails: Email[]; summary: string }> {
  const emails = await listEmails(15);
  const unread = emails.filter(e => !e.isRead);

  if (!unread.length) return { emails: [], summary: "Inbox clear ✅" };

  const lines = unread.slice(0, 8).map(e => {
    const age = Math.round((Date.now() - new Date(e.receivedAt).getTime()) / 3600000);
    const ageStr = age < 1 ? "< 1h" : `${age}h ago`;
    const preview = e.preview.substring(0, 55).replace(/\n/g, " ");
    return `- *${e.from}*: ${e.subject} (${ageStr})\n  ${preview}...`;
  });

  const more = unread.length > 8 ? `\n_…and ${unread.length - 8} more_` : "";
  return {
    emails: unread,
    summary: `${unread.length} unread:\n${lines.join("\n")}${more}`,
  };
}

// ============================================================
// SECTION 5: ACTIVE GOALS
// ============================================================

async function getActiveGoals(): Promise<string> {
  if (!supabase) return "Goals unavailable (Supabase not configured)";

  try {
    const { data } = await supabase.rpc("get_active_goals");
    if (!data?.length) return "No active goals set.";

    return data
      .map((g: any) => {
        const deadline = g.deadline
          ? ` _(by ${new Date(g.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" })})_`
          : "";
        return `- ${g.content}${deadline}`;
      })
      .join("\n");
  } catch (err: any) {
    console.error("Goals fetch error:", err.message);
    return "Goals unavailable";
  }
}

// ============================================================
// SECTION 6: TELECOM, AI & FINANCIAL NEWS
// ============================================================

async function getNews(): Promise<string> {
  try {
    const year = new Date().getFullYear();
    const [telecom, ai, finance] = await Promise.all([
      searchWeb(`telecom industry news ${year} latest`, 3),
      searchWeb(`AI artificial intelligence news today ${year}`, 3),
      searchWeb(`Brazil financial markets BRL USD today ${year}`, 2),
    ]);

    const sections: string[] = [];

    const extractHeadlines = (raw: string, label: string): string => {
      if (!raw) return "";
      const lines = raw
        .split("\n")
        .filter(l => l.match(/^\d+\.\s+\*\*/))
        .slice(0, 3)
        .map(l => l.replace(/^\d+\.\s+/, "").replace(/\*\*/g, "").trim());
      return lines.length ? `*${label}:*\n${lines.map(l => `- ${l}`).join("\n")}` : "";
    };

    if (telecom) sections.push(extractHeadlines(telecom, "Telecom"));
    if (ai) sections.push(extractHeadlines(ai, "AI"));
    if (finance) sections.push(extractHeadlines(finance, "Markets"));

    return sections.filter(Boolean).join("\n\n") || "News unavailable";
  } catch {
    return "News unavailable";
  }
}

// ============================================================
// SECTION 7: AIRBNB / HOSPITABLE
// ============================================================

async function getAirbnbSection(): Promise<string> {
  if (process.env.HOSPITABLE_ENABLED !== "true") return "";

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const startDate = new Date(year, month, 1).toISOString().split("T")[0];
  const endDate = new Date(year, month + 1, 0).toISOString().split("T")[0];
  const today = now.toISOString().split("T")[0];
  const in7days = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
  const monthLabel = now.toLocaleDateString("en-US", { month: "long" });

  const properties = await listProperties();
  const propertyIds = properties.map(p => p.id);

  const [financials, upcoming] = await Promise.all([
    getFinancialsFromSupabase(startDate, endDate),
    getReservations({ propertyIds, startDate: today, endDate: in7days, status: ["accepted"], perPage: 20 }),
  ]);

  const lines: string[] = [];

  // MTD Earnings by property
  if (financials.reservations.length) {
    const byProp: Record<string, { totalCents: number; currency: string; count: number }> = {};
    for (const tx of financials.reservations) {
      const prop = tx.property_name || "Unknown";
      if (!byProp[prop]) byProp[prop] = { totalCents: 0, currency: tx.currency, count: 0 };
      byProp[prop].totalCents += tx.amount_cents;
      byProp[prop].count++;
    }
    lines.push(`*${monthLabel} MTD Earnings:*`);
    let grandTotal = 0;
    for (const [prop, data] of Object.entries(byProp)) {
      const fmt = data.currency === "BRL"
        ? `R$${(data.totalCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
        : `$${(data.totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
      lines.push(`  ${prop}: ${fmt} (${data.count} reservations)`);
      grandTotal += data.totalCents;
    }
    if (Object.keys(byProp).length > 1) {
      const currency = financials.reservations[0]?.currency || "USD";
      const fmtGrand = currency === "BRL"
        ? `R$${(grandTotal / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
        : `$${(grandTotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
      lines.push(`  *Total: ${fmtGrand}*`);
    }
  }

  // Payouts
  if (financials.payouts.length) {
    let payoutTotal = 0;
    for (const p of financials.payouts) payoutTotal += p.amount_cents;
    const currency = financials.payouts[0]?.currency || "USD";
    const fmtPayout = currency === "BRL"
      ? `R$${(payoutTotal / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
      : `$${(payoutTotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    lines.push(`*Payouts received:* ${fmtPayout} (${financials.payouts.length} transfers)`);
  }

  // Next 7 days
  if (upcoming.length) {
    lines.push("\n*Next 7 days:*");
    for (const r of upcoming.sort((a, b) => new Date(a.arrivalDate).getTime() - new Date(b.arrivalDate).getTime())) {
      const arrival = new Date(r.arrivalDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const departure = new Date(r.departureDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const isCheckInToday = r.arrivalDate.split("T")[0] === today;
      const isCheckOutToday = r.departureDate.split("T")[0] === today;
      let tag = "";
      if (isCheckInToday) tag = " ⬅ CHECK-IN TODAY";
      else if (isCheckOutToday) tag = " ➡ CHECKOUT TODAY";
      lines.push(`  ${arrival}–${departure}: ${r.guestName} @ ${r.propertyName} (${r.nights}n)${tag}`);
    }
  }

  // Guest inbox — messages needing reply
  try {
    const needsReply: string[] = [];
    const activeReservations = await getReservations({
      propertyIds,
      startDate: new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
      endDate: in7days,
      status: ["accepted"],
      perPage: 20,
    });

    for (const r of activeReservations) {
      try {
        const msgs = await getMessages(r.id);
        if (msgs.length) {
          const last = msgs[msgs.length - 1];
          if (last.senderType === "guest") {
            const age = Math.round((Date.now() - new Date(last.createdAt).getTime()) / 3600000);
            needsReply.push(`  ${r.guestName} @ ${r.propertyName} (${age < 1 ? "< 1h" : `${age}h`} ago)`);
          }
        }
      } catch {}
    }

    const inquiries = await getInquiries({ propertyIds, perPage: 10, sort: "-last_message_at" });
    for (const inq of inquiries) {
      try {
        const msgs = await getInquiryMessages(inq.id);
        if (msgs.length) {
          const last = msgs[msgs.length - 1];
          if (last.senderType === "guest") {
            const age = Math.round((Date.now() - new Date(last.createdAt).getTime()) / 3600000);
            needsReply.push(`  ${inq.guestName} @ ${inq.propertyName} (${age < 1 ? "< 1h" : `${age}h`} ago)`);
          }
        }
      } catch {}
    }

    if (needsReply.length) {
      lines.push(`\n*Guest inbox (${needsReply.length} awaiting reply):*`);
      lines.push(...needsReply);
    }
  } catch (e: any) {
    console.error("Guest inbox error:", e.message);
  }

  return lines.join("\n");
}

// ============================================================
// CLAUDE INSIGHT (optional strategic layer)
// ============================================================

async function runClaudeInsight(rawData: string): Promise<string> {
  let memoryContext = "";
  try {
    memoryContext = await getMemoryContext(supabase);
  } catch {}

  const tz = USER_TIMEZONE;
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: tz, weekday: "long", year: "numeric",
    month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const prompt = `You are Ona, ${USER_NAME}'s executive AI assistant. Based on today's data below, write a SHORT strategic insight (max 400 characters) for the end of the morning briefing. Think: what's the ONE thing that matters most today? Any risk or opportunity worth flagging? Be warm, direct, CEO-level. No bullet points — just 2-3 punchy sentences.

CURRENT TIME: ${timeStr}
${memoryContext ? `\nCONTEXT:\n${memoryContext}\n` : ""}
TODAY'S DATA:
${rawData}

Write only the insight text. No headers. No action tags. Match the user's language (English or Portuguese based on recent context).`;

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const promptFile = join(PROJECT_ROOT, `temp_briefing_${Date.now()}.txt`);
    await writeFile(promptFile, prompt);

    const result = await new Promise<string>((resolve) => {
      const child = nodeSpawn(CLAUDE_PATH, ["--no-session-persistence", "--output-format", "text"], {
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
      }, 120_000);

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

    return result || "";
  } catch {
    return "";
  }
}

// ============================================================
// BUILD & SEND BRIEFING
// ============================================================

async function buildAndSendBriefing() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: USER_TIMEZONE,
  });

  console.log("Gathering data for morning briefing...");

  // Fetch all sections in parallel
  const [
    weatherData,
    calendarData,
    emailData,
    goalsData,
    newsData,
    airbnbData,
  ] = await Promise.all([
    getWeather().catch(e => { console.error("Weather error:", e.message); return "Unavailable"; }),
    getCalendarData().catch(e => { console.error("Calendar error:", e.message); return { today: [], tomorrow: [] }; }),
    getUnreadEmails().catch(e => { console.error("Email error:", e.message); return { emails: [], summary: "Unavailable" }; }),
    getActiveGoals().catch(e => { console.error("Goals error:", e.message); return "Unavailable"; }),
    getNews().catch(e => { console.error("News error:", e.message); return "Unavailable"; }),
    getAirbnbSection().catch(e => { console.error("Airbnb error:", e.message); return ""; }),
  ]);

  // Build the 7-section briefing
  const sections: string[] = [];

  // 1. Header
  sections.push(`🌅 *Good Morning, ${USER_NAME}!*\n📅 ${dateStr}`);

  // 2. Weather
  sections.push(`☀️ *Weather*\n${weatherData}`);

  // 3. Today's Schedule
  sections.push(`📅 *Schedule*\n${formatCalendarSection(calendarData.today, calendarData.tomorrow)}`);

  // 4. Inbox
  sections.push(`📧 *Inbox*\n${emailData.summary}`);

  // 5. Active Goals
  sections.push(`🎯 *Active Goals*\n${goalsData}`);

  // 6. News
  sections.push(`📰 *Telecom, AI & Markets*\n${newsData}`);

  // 7. Airbnb
  if (airbnbData) {
    sections.push(`🏠 *Airbnb / Hospitable*\n${airbnbData}`);
  }

  // Build raw data summary for Claude insight
  const rawSummary = [
    `Calendar: ${calendarData.today.length} events today`,
    `Emails: ${emailData.emails.length} unread`,
    `Goals: ${goalsData}`,
    airbnbData ? `Airbnb: ${airbnbData.substring(0, 200)}` : "",
  ].filter(Boolean).join("\n");

  // Get Claude's strategic insight
  console.log("Getting Claude's strategic insight...");
  const insight = await runClaudeInsight(rawSummary).catch(() => "");

  if (insight) {
    sections.push(`💡 *Ona's Take*\n${insight}`);
  }

  // Send in one message (or split if too long)
  const fullBriefing = sections.join("\n\n---\n\n");

  if (fullBriefing.length <= 4096) {
    await sendTelegram(fullBriefing);
  } else {
    // Split into multiple messages
    let current = "";
    for (const section of sections) {
      if ((current + "\n\n---\n\n" + section).length > 4000) {
        if (current) await sendTelegram(current);
        current = section;
      } else {
        current = current ? current + "\n\n---\n\n" + section : section;
      }
    }
    if (current) await sendTelegram(current);
  }

  console.log("Morning briefing sent!");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  await buildAndSendBriefing();
}

main();

// ============================================================
// SCHEDULING (PM2 — Windows/Linux)
// ============================================================
/*
npx pm2 start examples/morning-briefing.ts --interpreter bun --name morning-briefing --cron "0 8 * * 1-5" --no-autorestart
*/
