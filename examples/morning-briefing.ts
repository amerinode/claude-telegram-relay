/**
 * Morning Briefing — Ona's Daily Summary
 *
 * Sends a personalized daily briefing via Telegram every morning.
 * Pulls REAL data from:
 *   - Microsoft 365 (emails + calendar) via Graph API
 *   - Supabase (active goals + facts from memory)
 *   - Claude CLI (composes the briefing with Ona's personality)
 *
 * Schedule: PM2 cron at 8am (America/Sao_Paulo)
 * Manual run: bun run examples/morning-briefing.ts
 */

import { spawn } from "bun";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { listEmails, listCalendarEvents, listTasks, type Email, type CalendarEvent, type TodoTask } from "../src/ms365.ts";
import { getMemoryContext } from "../src/memory.ts";

const PROJECT_ROOT = dirname(import.meta.dir);

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE =
  process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// SUPABASE (for memory context)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// PROFILE LOADING
// ============================================================

let profileContext = "";
try {
  profileContext = await readFile(
    join(PROJECT_ROOT, "config", "profile.md"),
    "utf-8"
  );
} catch {
  // No profile yet
}

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
          parse_mode: "Markdown",
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("Telegram API error:", err);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// DATA FETCHERS (real data!)
// ============================================================

async function fetchEmails(): Promise<string> {
  if (process.env.MS365_ENABLED !== "true") return "";

  try {
    const emails = await listEmails(15);
    if (!emails.length) return "No recent emails.";

    const unread = emails.filter(e => !e.isRead);
    const lines = emails.slice(0, 10).map(e => {
      const date = new Date(e.receivedAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      const flag = e.isRead ? "" : " [UNREAD]";
      return `- ${date} — ${e.from}: ${e.subject}${flag}`;
    });

    const summary = unread.length > 0
      ? `${unread.length} unread of ${emails.length} recent`
      : `${emails.length} recent emails (all read)`;

    return `${summary}\n${lines.join("\n")}`;
  } catch (error: any) {
    console.error("Email fetch failed:", error.message);
    if (error.message.includes("Token refresh failed")) {
      return "MS365 token expired — run: npx @softeria/ms-365-mcp-server --login";
    }
    return "";
  }
}

async function fetchCalendar(): Promise<string> {
  if (process.env.MS365_ENABLED !== "true") return "";

  try {
    const events = await listCalendarEvents();
    if (!events.length) return "No meetings today.";

    const lines = events.map(e => {
      const start = new Date(e.start).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      const end = new Date(e.end).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      const location = e.isOnline ? "Teams" : (e.location || "");
      const locStr = location ? ` (${location})` : "";
      return `- ${start}–${end}: ${e.subject}${locStr}`;
    });

    return `${events.length} event${events.length > 1 ? "s" : ""} today\n${lines.join("\n")}`;
  } catch (error: any) {
    console.error("Calendar fetch failed:", error.message);
    return "";
  }
}

async function fetchTasks(): Promise<string> {
  if (process.env.MS365_ENABLED !== "true") return "";

  try {
    const tasks = await listTasks();
    if (!tasks.length) return "No pending tasks.";

    const lines = tasks.map(t => {
      const due = t.dueDateTime
        ? ` (due: ${new Date(t.dueDateTime).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
        : "";
      const imp = t.importance === "high" ? " ⚠️" : "";
      return `- ${t.title}${due}${imp}`;
    });

    return `${tasks.length} pending task${tasks.length > 1 ? "s" : ""}\n${lines.join("\n")}`;
  } catch (error: any) {
    console.error("Tasks fetch failed:", error.message);
    return "";
  }
}

async function fetchGoals(): Promise<string> {
  if (!supabase) return "";

  try {
    const memoryContext = await getMemoryContext(supabase);
    // Extract just the GOALS section if it exists
    const goalsMatch = memoryContext.match(/GOALS:\n([\s\S]*?)(?=\n\n|$)/);
    return goalsMatch ? goalsMatch[1].trim() : "";
  } catch (error: any) {
    console.error("Goals fetch failed:", error.message);
    return "";
  }
}

// ============================================================
// COMPOSE WITH CLAUDE (Ona's personality)
// ============================================================

async function composeBriefing(rawData: {
  emails: string;
  calendar: string;
  tasks: string;
  goals: string;
  dateStr: string;
  dayOfWeek: string;
}): Promise<string> {
  const prompt = `You are Ona, ${USER_NAME ? USER_NAME + "'s" : "a"} personal AI assistant.
You're composing a morning briefing message for Telegram.

YOUR PERSONALITY:
- Lively, warm, and witty — like a sharp, fun friend
- In Portuguese: naturally Brazilian — use "tranquilo", "show", "beleza"
- Keep it punchy and scannable — this is a Telegram message, not an essay
- Match ${USER_NAME || "the user"}'s primary language (Portuguese/Brazilian)

TODAY: ${rawData.dateStr} (${rawData.dayOfWeek})
Timezone: ${USER_TIMEZONE}

${profileContext ? `ABOUT ${USER_NAME || "THE USER"}:\n${profileContext}\n` : ""}

RAW DATA TO INCLUDE:

📅 CALENDAR:
${rawData.calendar || "No events today"}

📧 EMAILS:
${rawData.emails || "Email not available"}

✅ TO DO TASKS:
${rawData.tasks || "No pending tasks"}

🎯 GOALS:
${rawData.goals || "No active goals tracked"}

INSTRUCTIONS:
- Write a morning briefing message for Telegram using Markdown formatting
- Start with a warm, personality-filled greeting (vary it — don't always say the same thing)
- Include ALL the raw data sections above, formatted nicely with emojis
- For emails: highlight unread ones, mention who they're from
- For calendar: make it clear what's coming up and when
- For tasks: list pending to-do items, highlight any overdue or high-importance ones
- For goals: give a quick motivational nudge
- End with a short, fun sign-off
- Keep the TOTAL message under 2000 characters
- Use Markdown: *bold*, _italic_, etc.
- Language: ${USER_NAME === "Gil" ? "Portuguese (Brazilian)" : "match the user's language"}
- Do NOT include any [REMEMBER:], [GOAL:], or action tags
- Do NOT include \`\`\` code blocks`;

  try {
    // Strip Claude Code env vars to avoid nesting detection
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(
      [CLAUDE_PATH, "-p", prompt, "--no-session-persistence", "--output-format", "text"],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: PROJECT_DIR || undefined,
        env: cleanEnv,
      }
    );

    const TIMEOUT_MS = 30_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error("Claude timed out"));
      }, TIMEOUT_MS)
    );

    const result = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const [output, stderr, exitCode] = await Promise.race([result, timeout]);

    if (exitCode !== 0) {
      console.error(`Claude exit ${exitCode}: ${stderr.substring(0, 200)}`);
      return ""; // Fall back to raw format
    }

    return output.trim();
  } catch (error: any) {
    console.error("Claude compose error:", error.message);
    return ""; // Fall back to raw format
  }
}

// ============================================================
// BUILD BRIEFING
// ============================================================

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("pt-BR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: USER_TIMEZONE,
  });
  const dayOfWeek = now.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: USER_TIMEZONE,
  });

  console.log(`Fetching data for ${dateStr}...`);

  // Fetch all data in parallel
  const [emails, calendar, tasks, goals] = await Promise.all([
    fetchEmails(),
    fetchCalendar(),
    fetchTasks(),
    fetchGoals(),
  ]);

  console.log(`  Emails: ${emails ? "OK" : "empty"}`);
  console.log(`  Calendar: ${calendar ? "OK" : "empty"}`);
  console.log(`  Tasks: ${tasks ? "OK" : "empty"}`);
  console.log(`  Goals: ${goals ? "OK" : "empty"}`);

  // Let Claude compose it with personality
  const composed = await composeBriefing({
    emails,
    calendar,
    tasks,
    goals,
    dateStr,
    dayOfWeek,
  });

  if (composed) {
    return composed;
  }

  // Fallback: raw format if Claude fails
  console.log("Claude compose failed — using raw format");
  const sections: string[] = [];
  const greeting = USER_NAME
    ? `☀️ *Bom dia, ${USER_NAME}!*`
    : "☀️ *Bom dia!*";
  sections.push(`${greeting}\n${dateStr}\n`);

  if (calendar) sections.push(`📅 *Agenda*\n${calendar}\n`);
  if (emails) sections.push(`📧 *Emails*\n${emails}\n`);
  if (tasks) sections.push(`✅ *Tarefas*\n${tasks}\n`);
  if (goals) sections.push(`🎯 *Metas*\n${goals}\n`);

  if (!calendar && !emails && !tasks && !goals) {
    sections.push("Nenhum dado disponível ainda. Me pergunta qualquer coisa!");
  }

  sections.push("---\n_Responde aqui ou diz \"me liga\" pra conversar por voz_ 📞");

  return sections.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("=== Ona Morning Briefing ===");
  console.log(`Time: ${new Date().toLocaleString("pt-BR", { timeZone: USER_TIMEZONE })}`);

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const briefing = await buildBriefing();

  console.log("\nSending briefing...");
  console.log(`Length: ${briefing.length} chars`);

  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent successfully!");
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main();
