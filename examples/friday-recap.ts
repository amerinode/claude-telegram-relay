/**
 * Friday Recap — Weekly Reflection Coach
 *
 * Runs every Friday at 4:30 PM. Gathers the week's context (tasks completed,
 * meetings held, emails sent, goals progress) and kicks off a reflective
 * conversation with Gil via Telegram.
 *
 * This is a CONVERSATION STARTER, not a one-shot report. Ona asks the first
 * question, Gil responds through the relay, and the reflection unfolds naturally
 * using the Weekly Reflection Coach role defined in profile.md.
 *
 * Schedule this with:
 * - Windows/Linux: PM2 cron — "30 16 * * 5" (Friday 4:30 PM)
 * - macOS: launchd plist
 *
 * Run manually: bun run examples/friday-recap.ts
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  listCalendarEvents,
  listTaskLists,
  listTasks,
  listEmails,
  type TodoTask,
  type CalendarEvent,
  type Email,
} from "../src/ms365";
import { getMemoryContext, getRecentHistory } from "../src/memory";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const USER_NAME = process.env.USER_NAME || "Gil";

const supabase: SupabaseClient | null =
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
      // Retry without Markdown if formatting fails
      const retry = await fetch(
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
      return retry.ok;
    }

    return true;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

async function saveToMessages(content: string, metadata?: Record<string, unknown>): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role: "assistant",
      content,
      channel: "telegram",
      metadata: { source: "friday-recap", ...metadata },
    });
  } catch (e: any) {
    console.error("Failed to save to messages:", e.message);
  }
}

// ============================================================
// WEEK DATA FETCHERS
// ============================================================

function getWeekRange(): { start: string; end: string; startDate: Date; endDate: Date } {
  const tz = process.env.USER_TIMEZONE || "America/Sao_Paulo";
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });

  // Go back to Monday of this week
  const today = new Date(`${todayStr}T00:00:00`);
  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);

  const friday = new Date(today);
  friday.setDate(today.getDate());
  friday.setHours(23, 59, 59);

  return {
    start: monday.toISOString(),
    end: friday.toISOString(),
    startDate: monday,
    endDate: friday,
  };
}

async function getWeekCalendar(): Promise<string> {
  const { start, end } = getWeekRange();
  const tz = process.env.USER_TIMEZONE || "America/Sao_Paulo";

  const events = await listCalendarEvents(start, end);
  if (!events.length) return "No meetings this week.";

  // Group by day
  const byDay: Record<string, CalendarEvent[]> = {};
  for (const e of events) {
    const day = new Date(e.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(e);
  }

  const lines: string[] = [`${events.length} meetings this week:`];
  for (const [day, dayEvents] of Object.entries(byDay)) {
    lines.push(`  ${day}: ${dayEvents.map(e => e.subject).join(", ")}`);
  }

  return lines.join("\n");
}

async function getWeekTasks(): Promise<{ completed: string; open: string }> {
  const allLists = await listTaskLists();
  const completedLines: string[] = [];
  const openLines: string[] = [];

  for (const list of allLists) {
    // Get completed tasks (for the wins section)
    const allTasks = await listTasks(list.id, list.displayName);
    const completed = allTasks.filter(t => t.status === "completed");
    const open = allTasks.filter(t => t.status !== "completed");

    // Only show recently completed (this week)
    const { startDate } = getWeekRange();
    // Tasks API doesn't expose completedDate reliably, so include all completed
    if (completed.length) {
      completedLines.push(`*${list.displayName}:* ${completed.map(t => t.title).join(", ")}`);
    }

    if (open.length) {
      for (const task of open) {
        const duePart = task.dueDateTime ? ` (due ${task.dueDateTime.split("T")[0]})` : "";
        const impPart = task.importance === "high" ? " ⚡" : "";
        openLines.push(`- ${task.title}${duePart}${impPart} [${list.displayName}]`);
      }
    }
  }

  return {
    completed: completedLines.length ? completedLines.join("\n") : "No completed tasks found",
    open: openLines.length ? openLines.join("\n") : "No open tasks",
  };
}

async function getWeekEmails(): Promise<string> {
  const emails = await listEmails(30);
  if (!emails.length) return "No emails this week.";

  const { startDate } = getWeekRange();
  const weekEmails = emails.filter(e => new Date(e.receivedAt) >= startDate);

  const unread = weekEmails.filter(e => !e.isRead).length;
  const total = weekEmails.length;

  // Top senders
  const senderCounts: Record<string, number> = {};
  for (const e of weekEmails) {
    senderCounts[e.from] = (senderCounts[e.from] || 0) + 1;
  }
  const topSenders = Object.entries(senderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sender, count]) => `${sender} (${count})`)
    .join(", ");

  return `${total} emails this week (${unread} unread). Top senders: ${topSenders}`;
}

// ============================================================
// CLAUDE — GENERATE OPENING MESSAGE
// ============================================================

async function generateRecapOpener(weekContext: string): Promise<string> {
  let profileContext = "";
  try {
    profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
  } catch {}

  let memoryContext = "";
  try {
    memoryContext = await getMemoryContext(supabase);
  } catch {}

  let recentHistory = "";
  try {
    recentHistory = await getRecentHistory(supabase, 15);
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

  const prompt = `You are Ona, ${USER_NAME}'s personal AI assistant. It's Friday afternoon and you're starting the weekly reflection ritual.

CURRENT TIME: ${timeStr}

${profileContext ? `ABOUT ${USER_NAME}:\n${profileContext}\n` : ""}
${memoryContext ? `MEMORY (facts, goals, context):\n${memoryContext}\n` : ""}
${recentHistory ? `RECENT CONVERSATIONS:\n${recentHistory}\n` : ""}

--- THIS WEEK'S DATA ---
${weekContext}

--- YOUR MISSION ---
Kick off the Friday weekly reflection. You're the Weekly Reflection Coach from the profile.

Write an opening message that:
1. Acknowledges it's Friday — bring that wind-down energy
2. Gives a BRIEF (2-3 sentences) snapshot of the week based on the data above (meetings attended, tasks completed, email volume — just the highlights, not a dump)
3. Asks the FIRST question: "What went well this week?" — in Ona's warm, conversational style
4. Make it feel like sitting down with a friend for a quick end-of-week chat, not a corporate review

--- RULES ---
- Keep it under 800 characters (Telegram-friendly)
- Use Ona's personality: warm, witty, direct
- Match the language ${USER_NAME} used in recent conversations (English or Portuguese)
- Do NOT ask all three questions at once — just the first one
- Do NOT use action tags
- The conversation will continue naturally through the relay when ${USER_NAME} replies`;

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const claudeArgs = ["--no-session-persistence", "--output-format", "text"];
    const promptFile = join(PROJECT_ROOT, `temp_recap_${Date.now()}.txt`);
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
      child.stderr?.on("data", () => {});

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        unlink(promptFile).catch(() => {});
        resolve("");
      }, 300_000);

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
  } catch (error: any) {
    console.error("Claude recap error:", error.message);
    return "";
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building Friday recap...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  // Gather week context in parallel
  console.log("Gathering this week's data...");
  const [calendar, tasks, emails] = await Promise.all([
    getWeekCalendar().catch(e => { console.error("Calendar error:", e.message); return "Calendar unavailable"; }),
    getWeekTasks().catch(e => { console.error("Tasks error:", e.message); return { completed: "Tasks unavailable", open: "Tasks unavailable" }; }),
    getWeekEmails().catch(e => { console.error("Email error:", e.message); return "Emails unavailable"; }),
  ]);

  const weekContext = [
    `📅 MEETINGS THIS WEEK:\n${calendar}`,
    `\n✅ TASKS COMPLETED:\n${tasks.completed}`,
    `\n📋 STILL OPEN:\n${tasks.open}`,
    `\n📧 EMAILS:\n${emails}`,
  ].join("\n");

  // Generate personalized opener via Claude
  console.log("Generating recap opener with Claude...");
  let message = await generateRecapOpener(weekContext);

  // Fallback if Claude is unavailable
  if (!message) {
    message = `🗓 *Friday Recap*\n\nHey ${USER_NAME}! It's that time of the week. Let's reflect before you head into the weekend.\n\nFirst up — what went well this week? Any wins, big or small?`;
  }

  // Send and save
  console.log("Sending Friday recap...");
  const sent = await sendTelegram(message);

  if (sent) {
    await saveToMessages(message, { type: "friday-recap" });
    console.log("Friday recap sent! Conversation will continue through the relay.");
  } else {
    console.error("Failed to send Friday recap");
    process.exit(1);
  }
}

main();

// ============================================================
// SCHEDULING
// ============================================================
/*
PM2 (Windows/Linux):
npx pm2 start examples/friday-recap.ts --interpreter bun --name friday-recap --cron "30 16 * * 5" --no-autorestart

macOS launchd — save as ~/Library/LaunchAgents/com.claude.friday-recap.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.friday-recap</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/friday-recap.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-telegram-relay</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>5</integer>
        <key>Hour</key>
        <integer>16</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/friday-recap.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/friday-recap.error.log</string>
</dict>
</plist>

Linux cron:
30 16 * * 5 cd /path/to/claude-telegram-relay && bun run examples/friday-recap.ts >> /tmp/friday-recap.log 2>&1
*/
