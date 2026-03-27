/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { spawn as nodeSpawn } from "node:child_process";
import { writeFile, mkdir, readFile, readdir, unlink, stat } from "fs/promises";
import { join, dirname, basename } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import { synthesize } from "./tts.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
} from "./memory.ts";
import {
  handleMs365Request,
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  acceptCalendarEvent,
  declineCalendarEvent,
  sendEmail,
  createDraft,
  createTask,
  findTaskList,
  searchEmails,
  readEmail,
  getOrCreateMailFolder,
  moveEmail,
} from "./ms365.ts";
import {
  handleHospitableRequest,
  sendMessage as sendGuestMessage,
  sendInquiryMessage,
  syncTransactionsToSupabase,
} from "./hospitable.ts";
import { needsSearch, searchWeb, isFlightSearch, isHotelSearch, searchFlights, searchHotels } from "./search.ts";
import { processFileActions } from "./file-gen.ts";
import { makeCall, isCallConfigured } from "./call.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");
const ONA_DIR = process.env.ONA_FOLDER || "";
const FILES_DIR = ONA_DIR || join(PROJECT_ROOT, "files");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(FILES_DIR, { recursive: true });

// ============================================================
// FILE OUTPUT DETECTION
// ============================================================

/** Get a snapshot of files in the output directory */
async function snapshotFiles(): Promise<Map<string, number>> {
  const snapshot = new Map<string, number>();
  try {
    const entries = await readdir(FILES_DIR);
    for (const entry of entries) {
      const filePath = join(FILES_DIR, entry);
      const s = await stat(filePath);
      if (s.isFile()) snapshot.set(filePath, s.mtimeMs);
    }
  } catch {}
  return snapshot;
}

/** Find files created or modified since the snapshot */
async function getNewFiles(before: Map<string, number>): Promise<string[]> {
  const newFiles: string[] = [];
  try {
    const entries = await readdir(FILES_DIR);
    for (const entry of entries) {
      const filePath = join(FILES_DIR, entry);
      const s = await stat(filePath);
      if (!s.isFile()) continue;
      const prevMtime = before.get(filePath);
      if (prevMtime === undefined || s.mtimeMs > prevMtime) {
        newFiles.push(filePath);
      }
    }
  } catch {}
  return newFiles;
}

/** Send files as Telegram documents */
async function sendFiles(ctx: Context, files: string[]): Promise<void> {
  for (const filePath of files) {
    try {
      const content = await readFile(filePath);
      const name = basename(filePath);
      console.log(`Sending file: ${name} (${content.length} bytes)`);
      await ctx.replyWithDocument(new InputFile(content, name));
    } catch (error) {
      console.error(`Failed to send file ${filePath}:`, error);
    }
  }
}

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  channel: string = "telegram"
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel,
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { imagePath?: string; userMessage?: string }
): Promise<string> {
  // Build CLI args WITHOUT the prompt (prompt goes via stdin to avoid Windows arg length issues)
  // Claude CLI detects piped stdin and runs in non-interactive mode automatically.
  const claudeArgs = ["--no-session-persistence", "--output-format", "text"];

  // Allow WebFetch for URL access, Write for file creation,
  // and Chrome MCP tools for browser automation.
  // Web search is handled directly by the relay via Brave Search API
  // (MCP approach crashes Bun on Windows ARM64).
  claudeArgs.push(
    "--allowedTools",
    [
      "Read",
      "WebFetch",
      "Write",
      "mcp__Claude_in_Chrome__tabs_context_mcp",
      "mcp__Claude_in_Chrome__navigate",
      "mcp__Claude_in_Chrome__read_page",
      "mcp__Claude_in_Chrome__find",
      "mcp__Claude_in_Chrome__get_page_text",
      "mcp__Claude_in_Chrome__computer",
      "mcp__Claude_in_Chrome__form_input",
    ].join(",")
  );

  console.log(`Calling Claude (${prompt.length} chars): ${prompt.substring(0, 50)}...`);

  try {
    // Strip Claude Code env vars to avoid nesting detection
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    // Write prompt to temp file, then pipe it via stdin.
    // This avoids passing 17K+ as a command line argument which crashes Bun.spawn on Windows.
    const promptFile = join(TEMP_DIR, `prompt_${Date.now()}.txt`);
    await writeFile(promptFile, prompt);

    return await new Promise<string>((resolve) => {
      let resolved = false;
      const safeResolve = (value: string) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const child = nodeSpawn(CLAUDE_PATH, claudeArgs, {
        cwd: PROJECT_DIR || undefined,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let output = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      // Kill after 5 minutes to prevent indefinite hanging
      // (browser automation via Chrome MCP may need extra time)
      const timeout = setTimeout(() => {
        console.error("Claude CLI timed out after 5 minutes");
        child.kill("SIGTERM");
        unlink(promptFile).catch(() => {});
        safeResolve("Claude took too long to respond. Try a simpler question or try again.");
      }, 300_000);

      // Pipe the prompt file to stdin
      const fs = require("fs");
      const readStream = fs.createReadStream(promptFile);
      readStream.pipe(child.stdin!);

      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});

        if (code !== 0) {
          console.error(`Claude exit code: ${code}`);
          console.error(`Claude stderr: ${stderr.substring(0, 500)}`);
          safeResolve(`Error: ${stderr || "Claude exited with code " + code}`);
          return;
        }

        const result = output.trim();
        if (!result) {
          console.error("Claude returned empty output");
          console.error(`stderr: ${stderr}`);
          safeResolve("Something went wrong — Claude returned no response. Try again in a moment.");
          return;
        }
        safeResolve(result);
      });

      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        console.error("Spawn error:", err);
        safeResolve("Error: Could not run Claude CLI");
      });
    });
  } catch (error) {
    console.error("callClaude error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// MS365 DETECTION & ACTION PROCESSING
// ============================================================

/**
 * Check if a user message requires MS365 (email/calendar) data.
 * Uses action-oriented patterns to avoid false positives when
 * the user merely *mentions* email/calendar in conversation.
 */
function needsMs365(message: string, recentHistory?: string): boolean {
  if (process.env.MS365_ENABLED !== "true") return false;

  const ms365ActionPatterns = [
    // Email actions: fetch, read, check, show, open, list, send, delete, forward
    /\b(show|read|check|fetch|list|open|get|find|search|send|forward|reply|delete|move|compose|draft|write)\b.{0,20}\b(emails?|e-mails?|mails?|inbox|messages?)\b/i,
    /\b(emails?|e-mails?|mails?|inbox)\b.{0,20}\b(from|to|today|this week|unread|latest|recent|new)\b/i,
    /\b(enviar|ler|busca[r]?|mostra[r]?|abri[r]?|verifica[r]?|checa[r]?|manda[r]?|procura[r]?|pesquisa[r]?|acha[r]?|pega[r]?)\b.{0,20}\b(emails?|e-mails?)\b/i,
    /\b(busca|procura|pesquisa|acha|pega)\b.{0,30}\b(emails?|e-mails?|mail|inbox)\b/i,
    /\b(emails?|e-mails?)\b.{0,30}\b(do|da|de)\s+\w/i,
    // Conversational Portuguese: "tenho email?", "algum email", "meus emails", "chegou email", "tem email"
    /\b(tenho|tem|chegou|recebi|recebeu|algum|alguma|meus|minhas|novo|nova|importantes?)\b.{0,20}\b(emails?|e-mails?)\b/i,
    /\b(emails?|e-mails?)\b.{0,20}\b(novo|nova|novos|novas|importantes?|pendentes?|hoje|recentes?|pra mim|para mim)\b/i,
    // Calendar actions: check, show, what's on, schedule, add, create, cancel
    /\b(show|check|what'?s on|list|open|get|add|create|schedule|cancel|remove|move|reschedule|book)\b.{0,20}\b(calendars?|schedule|agenda|meetings?|events?|appointments?|lunch|dinner|call)\b/i,
    /\b(add|create|schedule|book|set up|cancel|reschedule)\b.{0,30}\b(at|for|on|today|tomorrow|noon|morning|afternoon)\b/i,
    /\b(next|upcoming|today'?s?|this week'?s?)\b.{0,20}\b(meetings?|events?|appointments?|calls?)\b/i,
    /\b(meetings?|events?|appointments?)\b.{0,20}\b(today|this week|tomorrow|scheduled)\b/i,
    /\b(calend[aá]rios?|agendas?|reuni[aãõ]o|reuni[oõ]es|eventos?)\b.{0,20}\b(hoje|semana|próxim|agendar|criar|adicionar|cancelar)\b/i,
    /\b(agendar|marcar|criar|adicionar)\b.{0,30}\b(reuni|almoço|jantar|chamada|evento)\b/i,
    // Draft actions
    /\b(add|save|put|move).{0,15}(to\s+)?drafts?\b/i,
    /\b(create|write|compose)\b.{0,15}\bdrafts?\b/i,
    // Direct commands
    /\b(my (latest|recent|unread|new) (emails?|mails?))\b/i,
    /\b(my (calendar|schedule|agenda|meetings?))\b/i,
    /\bwhen is my next\b/i,
    /\binbox\b/i,
    /\boutlook\b/i,
    /\b(add|put).{0,15}(calendar|my cal)\b/i,
    // Confirm/accept meetings
    /\b(accept|confirm|rsvp|decline)\b.{0,20}\b(meeting|event|invite|calendar)\b/i,
    // Tasks / To Do
    /\b(show|check|list|get|fetch|what are)\b.{0,20}\b(tasks?|to.?dos?|action.?items?)\b/i,
    /\b(my|work|pending|open)\b.{0,10}\b(tasks?|to.?dos?)\b/i,
    /\b(tarefas?|pendentes?|pendências)\b/i,
    /\b(complete|finish|done with|mark.{0,10}done)\b.{0,20}\b(task|to.?do)\b/i,
    // Add/create tasks: "add X to list Y", "adiciona X na lista Y"
    /\b(add|create|adiciona|coloca|bota|põe|inclui)\b.{0,40}\b(list|lista|to.?do|grocer)/i,
    /\b(adiciona|coloca|bota|põe|inclui)\b/i,
  ];

  if (ms365ActionPatterns.some(p => p.test(message))) return true;

  // History-aware: confirmation of a pending MS365 action (send email, calendar change, etc.)
  if (recentHistory && isConfirmationWithMs365History(message, recentHistory)) return true;

  return false;
}

/**
 * Check if a short confirmation message follows a recent MS365 interaction.
 * This catches "send it", "yes", "manda" etc. when the bot just proposed sending an email
 * or making a calendar change.
 */
function isConfirmationWithMs365History(message: string, recentHistory: string): boolean {
  const msg = message.toLowerCase().trim();

  const confirmationPatterns = [
    /^(sim|s|ok|pode|manda|envia|envie|confirma|isso|perfeito|vai|bora|beleza|boa|mande|pode mandar|pode enviar|confirmo|aprovado|tá bom|manda bala|solta|dispara)$/i,
    /^(sim|pode|manda|envia|confirma).{0,40}$/i,
    /^(yes|y|ok|sure|send|go ahead|do it|confirmed|approved|perfect|sounds good|send it|yep|yeah|please|please send|go for it)$/i,
    /^(yes|send|go).{0,30}$/i,
    /^(👍|✅|💪|🚀)$/,
  ];

  const isShortConfirmation = confirmationPatterns.some(p => p.test(msg));

  // Check if recent history involves MS365 actions (email drafts, calendar proposals, etc.)
  const historySignals = [
    /\b(draft|rascunho)\b.{0,30}\b(email|e-mail|reply|resposta)\b/i,
    /\b(send|enviar|mandar)\b.{0,20}\b(email|e-mail|reply|resposta)\b/i,
    /should I send|want me to send|quer que eu (envie|mande)/i,
    /\b(To:|Para:|Subject:|Assunto:|Re:)\b/i,
    /SEND_EMAIL|CREATE_DRAFT|CREATE_EVENT|UPDATE_EVENT|DELETE_EVENT|ACCEPT_EVENT/i,
    /\b(reply|respond|draft|message)\b.{0,30}\b(to|para)\b/i,
    /here'?s.{0,20}(draft|email|reply|message)/i,
    /adjust.{0,20}(tone|before you send|antes de enviar)/i,
    /Mail\.Send|read.only|can't send|cannot send/i,
  ];

  const historyHasMs365 = historySignals.some(p => p.test(recentHistory));

  // Short confirmations ("send it", "yes", "manda") with MS365 history
  if (isShortConfirmation && historyHasMs365) return true;

  // Follow-up messages in an active MS365 conversation:
  // - Message contains an email address
  // - Message references email/sending in context of recent MS365 history
  if (historyHasMs365) {
    // Contains an email address
    if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(message)) return true;
    // References email-related actions or provides info for pending action
    if (/\b(his|her|their|the|ricardo'?s?|that)\b.{0,15}\b(email|e-mail|address)\b/i.test(msg)) return true;
    // User is providing info or correction for a pending MS365 action
    if (/\b(next time|from now on|going forward|it'?s?\s|it is|here'?s?|aqui|é\s)\b/i.test(msg)) return true;
  }

  return false;
}

// ============================================================
// HOSPITABLE DETECTION & ACTION PROCESSING
// ============================================================

/**
 * Check if a user message requires Hospitable (vacation rental) data.
 */
function needsHospitable(message: string, recentHistory?: string): boolean {
  if (process.env.HOSPITABLE_ENABLED !== "true") return false;

  const hospitablePatterns = [
    // Reservation / booking queries
    /\b(reservat|booking|bookings|reserva[sç])\b/i,
    // Guest-related
    /\b(guests?|hóspede|hóspedes|check.?in|check.?out|arrivals?|departures?)\b/i,
    // Property management
    /\b(propert|listings?|my (apartment|house|villa|cabin|unit|place|rental))/i,
    /\b(imóve[ils]|propriedad)/i,
    // Platform references
    /\b(airbnb|vrbo|booking\.com|hospitable)\b/i,
    // Guest messaging & inbox
    /\b(guest.?messag|write.?to.?guest|reply.?to.?guest|contact.?guest|message.?guest)\b/i,
    /\b(mensagem.{0,10}hóspede|responder.{0,10}hóspede)\b/i,
    /\b(hospitable.?inbox|inbox.?messages?|latest.?messages)\b/i,
    /\b(caixa.?de.?entrada|mensagens?.?(recentes|novas|últimas))\b/i,
    // Occupancy / availability
    /\b(occupancy|availability|calendar.{0,10}(rental|property|listing)|vacant|blocked)\b/i,
    /\b(ocupação|disponibilidade)\b/i,
    // Reviews
    /\b(reviews?|ratings?|avaliaç)/i,
    // Stay types
    /\b(stays?|night.?stay|upcoming.?stay)\b/i,
    // Direct rental commands
    /\b(rental|short.?term|vacation.?rental|aluguel)\b/i,
    // Financial / earnings
    /\b(earn|revenue|payout|transaction|financ|income|billing)\b/i,
    /\b(fatur|ganhos?|receita|quanto.?(fiz|ganhei|faturei|recebi))\b/i,
    /\b(how.?much.?(did|do|have|has|am|are|is|was|will|would|earn|made?|get|owe|pay|charg|receiv|spend|spent|cost))\b/i,
    /\b(soma|sum|total).{0,15}(reserv|booking|month|mês|mes)/i,
    /\b(relatório|report).{0,15}(financ|reserv|booking|mensal|monthly)/i,
  ];

  if (hospitablePatterns.some(p => p.test(message))) return true;

  // History-aware: confirmation of a pending Hospitable action
  if (recentHistory && isConfirmationWithHospitableHistory(message, recentHistory)) return true;

  return false;
}

/**
 * Check if a short confirmation message follows a recent Hospitable interaction.
 * This catches "sim", "yes", "manda" etc. when the bot just proposed sending a guest message.
 */
function isConfirmationWithHospitableHistory(message: string, recentHistory: string): boolean {
  const msg = message.toLowerCase().trim();

  const confirmationPatterns = [
    /^(sim|s|ok|pode|manda|envia|envie|confirma|isso|perfeito|vai|bora|beleza|boa|mande|pode mandar|pode enviar|confirmo|aprovado|tá bom|manda bala|solta|dispara)$/i,
    /^(sim|pode|manda|envia|confirma).{0,40}$/i,
    /^(yes|y|ok|sure|send|go ahead|do it|confirmed|approved|perfect|sounds good|send it|yep|yeah|please|please send|go for it)$/i,
    /^(yes|send|go).{0,30}$/i,
    /^(👍|✅|💪|🚀)$/,
  ];

  if (!confirmationPatterns.some(p => p.test(msg))) return false;

  const historySignals = [
    /uuid:\s*[0-9a-f]{8}-[0-9a-f]{4}/i,
    /HOSPITABLE/i,
    /mensagem.{0,20}(hóspede|guest)/i,
    /message.{0,20}guest/i,
    /should I send|quer que eu (envie|mande)|posso (enviar|mandar)/i,
    /enviar.{0,15}(pelo|via|no).{0,15}(airbnb|hospitable)/i,
  ];

  return historySignals.some(p => p.test(recentHistory));
}

/**
 * Process Hospitable action tags in Claude's response.
 * Claude can include these tags to trigger real actions:
 *   [SEND_GUEST_MESSAGE: reservation_uuid | message body]
 *   [SEND_INQUIRY_MESSAGE: inquiry_uuid | message body]
 */
async function processHospitableActions(response: string): Promise<string> {
  let clean = response;

  // [SEND_GUEST_MESSAGE: uuid | message] — for reservations
  for (const match of response.matchAll(/\[SEND_GUEST_MESSAGE:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    try {
      const result = await sendGuestMessage(match[1].trim(), match[2].trim());
      console.log(`Sent guest message: ${result.sentReferenceId}`);
      clean = clean.replace(match[0], `✅ Message sent to guest`);
    } catch (error: any) {
      console.error("Send guest message error:", error.message);
      clean = clean.replace(match[0], `❌ Could not send message: ${error.message}`);
    }
  }

  // [SEND_INQUIRY_MESSAGE: uuid | message] — for inquiries (no reservation yet)
  for (const match of response.matchAll(/\[SEND_INQUIRY_MESSAGE:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    try {
      const result = await sendInquiryMessage(match[1].trim(), match[2].trim());
      console.log(`Sent inquiry message: ${result.sentReferenceId}`);
      clean = clean.replace(match[0], `✅ Message sent to inquiry guest`);
    } catch (error: any) {
      console.error("Send inquiry message error:", error.message);
      clean = clean.replace(match[0], `❌ Could not send inquiry message: ${error.message}`);
    }
  }

  return clean;
}

/**
 * Process phone call action tags in Claude's response.
 * Claude includes: [MAKE_CALL: phone_number | message]
 */
async function processCallActions(response: string): Promise<string> {
  let clean = response;

  for (const match of response.matchAll(/\[MAKE_CALL:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    try {
      const phone = match[1].trim();
      const message = match[2].trim();
      const sid = await makeCall(phone, message);
      console.log(`Call initiated: ${phone} (SID: ${sid})`);
      clean = clean.replace(match[0], `✅ Calling ${phone} now...`);
    } catch (error: any) {
      console.error("Make call error:", error.message);
      clean = clean.replace(match[0], `❌ Could not make call: ${error.message}`);
    }
  }

  return clean;
}

/**
 * Process MS365 action tags in Claude's response.
 * Claude can include these tags to trigger real actions:
 *   [CREATE_EVENT: subject | start_datetime | end_datetime | timezone]
 *   [UPDATE_EVENT: event_subject_search_text | start_datetime | end_datetime | timezone]
 *   [DELETE_EVENT: event_subject_search_text]
 *   [ACCEPT_EVENT: event_subject_search_text]
 *   [DECLINE_EVENT: event_subject_search_text]
 *   [SEND_EMAIL: to@addr | subject | body]
 */
async function processMs365Actions(response: string): Promise<string> {
  let clean = response;

  // [CREATE_EVENT: subject | start | end | timezone]
  for (const match of response.matchAll(/\[CREATE_EVENT:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*(?:\|\s*(.+?))?\]/gi)) {
    try {
      const result = await createCalendarEvent({
        subject: match[1].trim(),
        startDateTime: match[2].trim(),
        endDateTime: match[3].trim(),
        timeZone: match[4]?.trim(),
      });
      console.log(`Created calendar event: ${result.subject} (${result.id})`);
      clean = clean.replace(match[0], `✅ Event created: ${result.subject}`);
    } catch (error: any) {
      console.error("Create event error:", error.message);
      clean = clean.replace(match[0], `❌ Could not create event: ${error.message}`);
    }
  }

  // [UPDATE_EVENT: search text | start | end | timezone]
  for (const match of response.matchAll(/\[UPDATE_EVENT:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*(?:\|\s*(.+?))?\]/gi)) {
    try {
      const searchText = match[1].trim().toLowerCase();
      // Search today and tomorrow to find the event
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();
      const events = await listCalendarEvents(start, end);
      const event = events.find(e => e.subject.toLowerCase().includes(searchText));
      if (event) {
        const result = await updateCalendarEvent(event.id, {
          startDateTime: match[2].trim(),
          endDateTime: match[3].trim(),
          timeZone: match[4]?.trim(),
        });
        console.log(`Updated calendar event: ${result.subject} (${result.id})`);
        clean = clean.replace(match[0], `✅ Event updated: ${result.subject}`);
      } else {
        clean = clean.replace(match[0], `❌ Could not find event matching "${match[1].trim()}"`);
      }
    } catch (error: any) {
      console.error("Update event error:", error.message);
      clean = clean.replace(match[0], `❌ Could not update event: ${error.message}`);
    }
  }

  // [DELETE_EVENT: search text]
  for (const match of response.matchAll(/\[DELETE_EVENT:\s*(.+?)\]/gi)) {
    try {
      const searchText = match[1].trim().toLowerCase();
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();
      const events = await listCalendarEvents(start, end);
      const event = events.find(e => e.subject.toLowerCase().includes(searchText));
      if (event) {
        await deleteCalendarEvent(event.id);
        console.log(`Deleted calendar event: ${event.subject} (${event.id})`);
        clean = clean.replace(match[0], `✅ Event deleted: ${event.subject}`);
      } else {
        clean = clean.replace(match[0], `❌ Could not find event matching "${match[1].trim()}"`);
      }
    } catch (error: any) {
      console.error("Delete event error:", error.message);
      clean = clean.replace(match[0], `❌ Could not delete event: ${error.message}`);
    }
  }

  // [ACCEPT_EVENT: search text]
  for (const match of response.matchAll(/\[ACCEPT_EVENT:\s*(.+?)\]/gi)) {
    try {
      const events = await listCalendarEvents();
      const searchText = match[1].trim().toLowerCase();
      const event = events.find(e => e.subject.toLowerCase().includes(searchText));
      if (event) {
        await acceptCalendarEvent(event.id);
        console.log(`Accepted event: ${event.subject}`);
        clean = clean.replace(match[0], `✅ Accepted: ${event.subject}`);
      } else {
        clean = clean.replace(match[0], `❌ Could not find event matching "${match[1].trim()}"`);
      }
    } catch (error: any) {
      console.error("Accept event error:", error.message);
      clean = clean.replace(match[0], `❌ Could not accept event: ${error.message}`);
    }
  }

  // [DECLINE_EVENT: search text]
  for (const match of response.matchAll(/\[DECLINE_EVENT:\s*(.+?)\]/gi)) {
    try {
      const events = await listCalendarEvents();
      const searchText = match[1].trim().toLowerCase();
      const event = events.find(e => e.subject.toLowerCase().includes(searchText));
      if (event) {
        await declineCalendarEvent(event.id);
        console.log(`Declined event: ${event.subject}`);
        clean = clean.replace(match[0], `✅ Declined: ${event.subject}`);
      } else {
        clean = clean.replace(match[0], `❌ Could not find event matching "${match[1].trim()}"`);
      }
    } catch (error: any) {
      console.error("Decline event error:", error.message);
      clean = clean.replace(match[0], `❌ Could not decline event: ${error.message}`);
    }
  }

  // [SEND_EMAIL: to | subject | body]  ([\s\S]+? to match multiline bodies)
  for (const match of response.matchAll(/\[SEND_EMAIL:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi)) {
    try {
      await sendEmail({
        to: [match[1].trim()],
        subject: match[2].trim(),
        body: match[3].trim(),
      });
      console.log(`Sent email to: ${match[1].trim()}`);
      clean = clean.replace(match[0], `✅ Email sent to ${match[1].trim()}`);
    } catch (error: any) {
      console.error("Send email error:", error.message);
      clean = clean.replace(match[0], `❌ Could not send email: ${error.message}`);
    }
  }

  // [CREATE_TASK: list_name | task title]
  for (const match of response.matchAll(/\[CREATE_TASK:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    try {
      const listName = match[1].trim();
      const taskTitle = match[2].trim();
      const list = await findTaskList(listName);
      if (list) {
        const result = await createTask(list.id, taskTitle);
        console.log(`Created task "${result.title}" in list "${list.displayName}" (${result.id})`);
        clean = clean.replace(match[0], `✅ Added "${result.title}" to ${list.displayName}`);
      } else {
        clean = clean.replace(match[0], `❌ Could not find list "${listName}"`);
      }
    } catch (error: any) {
      console.error("Create task error:", error.message);
      clean = clean.replace(match[0], `❌ Could not create task: ${error.message}`);
    }
  }

  // [CREATE_DRAFT: to | subject | body]  ([\s\S]+? to match multiline bodies)
  for (const match of response.matchAll(/\[CREATE_DRAFT:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi)) {
    try {
      const result = await createDraft({
        to: [match[1].trim()],
        subject: match[2].trim(),
        body: match[3].trim(),
      });
      console.log(`Created draft: ${result.subject} (${result.id})`);
      clean = clean.replace(match[0], `✅ Draft saved: "${result.subject}" — check your Outlook Drafts folder`);
    } catch (error: any) {
      console.error("Create draft error:", error.message);
      clean = clean.replace(match[0], `❌ Could not create draft: ${error.message}`);
    }
  }

  // [CREATE_MAIL_FOLDER: folder_name]
  for (const match of response.matchAll(/\[CREATE_MAIL_FOLDER:\s*(.+?)\]/gi)) {
    try {
      const folderName = match[1].trim();
      const result = await getOrCreateMailFolder(folderName);
      if (result.created) {
        console.log(`Created mail folder: ${result.displayName} (${result.id})`);
        clean = clean.replace(match[0], `✅ Folder created: "${result.displayName}"`);
      } else {
        console.log(`Mail folder already exists: ${result.displayName} (${result.id})`);
        clean = clean.replace(match[0], `✅ Folder already exists: "${result.displayName}"`);
      }
    } catch (error: any) {
      console.error("Create folder error:", error.message);
      clean = clean.replace(match[0], `❌ Could not create folder: ${error.message}`);
    }
  }

  // [MOVE_EMAILS: folder_name | email_id_1, email_id_2, ...]
  for (const match of response.matchAll(/\[MOVE_EMAILS:\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi)) {
    try {
      const folderName = match[1].trim();
      const emailIds = match[2].split(",").map(id => id.trim()).filter(Boolean);

      // Get or create the destination folder
      const folder = await getOrCreateMailFolder(folderName);
      if (folder.created) {
        console.log(`Created folder "${folder.displayName}" for email move`);
      }

      let moved = 0;
      let failed = 0;
      for (const emailId of emailIds) {
        try {
          await moveEmail(emailId, folder.id);
          moved++;
        } catch (e: any) {
          console.error(`Failed to move email ${emailId.substring(0, 20)}...: ${e.message}`);
          failed++;
        }
      }

      console.log(`Moved ${moved}/${emailIds.length} emails to "${folder.displayName}"`);
      const status = failed > 0
        ? `✅ Moved ${moved} email${moved !== 1 ? "s" : ""} to "${folder.displayName}" (${failed} failed)`
        : `✅ Moved ${moved} email${moved !== 1 ? "s" : ""} to "${folder.displayName}"`;
      clean = clean.replace(match[0], status);
    } catch (error: any) {
      console.error("Move emails error:", error.message);
      clean = clean.replace(match[0], `❌ Could not move emails: ${error.message}`);
    }
  }

  return clean;
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  try {
    await ctx.replyWithChatAction("typing");

    await saveMessage("user", text);

    // Gather context: recent history + semantic search + facts/goals
    const [recentHistory, relevantContext, memoryContext] = await Promise.all([
      getRecentHistory(supabase, 50),
      getRelevantContext(supabase, text),
      getMemoryContext(supabase),
    ]);

    // Check if we need MS365 data (email/calendar)
    let ms365Context = "";
    if (needsMs365(text, recentHistory)) {
      console.log("MS365 request detected, fetching data via Graph API...");
      ms365Context = await handleMs365Request(text, recentHistory);
      console.log(`MS365 context: ${ms365Context.substring(0, 100)}...`);
    }

    // Check if we need Hospitable data (vacation rentals)
    let hospitableContext = "";
    if (needsHospitable(text, recentHistory)) {
      console.log("Hospitable request detected, fetching data...");
      hospitableContext = await handleHospitableRequest(text, recentHistory);
      console.log(`Hospitable context: ${hospitableContext.substring(0, 100)}...`);
    }

    // Check if we need web search results
    let searchContext = "";
    if (needsSearch(text)) {
      console.log("Web search detected, querying Brave...");
      searchContext = await searchWeb(text);
      if (searchContext) console.log(`Search context: ${searchContext.substring(0, 100)}...`);
    }

    // Check for /flights or /hotels commands
    let travelContext = "";
    if (isFlightSearch(text)) {
      console.log("Flight search command detected, running multi-search...");
      travelContext = await searchFlights(text);
      if (travelContext) console.log(`Flight context: ${travelContext.substring(0, 100)}...`);
    } else if (isHotelSearch(text)) {
      console.log("Hotel search command detected, running multi-search...");
      travelContext = await searchHotels(text);
      if (travelContext) console.log(`Hotel context: ${travelContext.substring(0, 100)}...`);
    }

    const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext, recentHistory, ms365Context, hospitableContext, searchContext, travelContext);

    // Snapshot files directory before Claude call
    const filesBefore = await snapshotFiles();

    const rawResponse = await callClaude(enrichedPrompt, { userMessage: text });

    // Process action tags (always run — Claude may emit tags from conversation history context)
    let afterActions = rawResponse;
    afterActions = await processMs365Actions(afterActions);
    afterActions = await processHospitableActions(afterActions);
    if (isCallConfigured()) afterActions = await processCallActions(afterActions);

    // Process file creation action tags (Excel, PDF, PowerPoint)
    const { clean: afterFiles, files: generatedFiles } = await processFileActions(afterActions);

    // Parse and save any memory intents, strip tags from response
    const response = await processMemoryIntents(supabase, afterFiles);

    await saveMessage("assistant", response);
    await sendResponse(ctx, response);

    // Send files: generated via action tags + any files Claude wrote directly
    const newFiles = await getNewFiles(filesBefore);
    const allFiles = [...new Set([...generatedFiles, ...newFiles])];
    if (allFiles.length > 0) {
      await sendFiles(ctx, allFiles);
    }
  } catch (error) {
    console.error("Message handler error:", error);
    await ctx.reply("Deu ruim processando sua mensagem. Tenta de novo.").catch(() => {});
  }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const result = await transcribe(buffer);
    if (!result.text) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    const { text: transcription, language: detectedLang } = result;

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    const [recentHistory, relevantContext, memoryContext] = await Promise.all([
      getRecentHistory(supabase, 50),
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
    ]);

    // Check if we need MS365 data (email/calendar)
    let ms365Context = "";
    if (needsMs365(transcription, recentHistory)) {
      console.log("MS365 request detected in voice, fetching data via Graph API...");
      ms365Context = await handleMs365Request(transcription, recentHistory);
    }

    // Check if we need Hospitable data (vacation rentals)
    let hospitableContext = "";
    if (needsHospitable(transcription, recentHistory)) {
      console.log("Hospitable request detected in voice, fetching data...");
      hospitableContext = await handleHospitableRequest(transcription, recentHistory);
    }

    // Check if we need web search results
    let searchContext = "";
    if (needsSearch(transcription)) {
      console.log("Web search detected in voice, querying Brave...");
      searchContext = await searchWeb(transcription);
    }

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext,
      recentHistory,
      ms365Context,
      hospitableContext,
      searchContext
    );
    const rawResponse = await callClaude(enrichedPrompt, { userMessage: transcription });
    let afterActions = rawResponse;
    afterActions = await processMs365Actions(afterActions);
    afterActions = await processHospitableActions(afterActions);
    const claudeResponse = await processMemoryIntents(supabase, afterActions);

    await saveMessage("assistant", claudeResponse);

    // TTS: reply with voice, matching the user's spoken language
    console.log(`TTS: attempting synthesis, lang=${detectedLang}, response length=${claudeResponse.length}`);
    await ctx.replyWithChatAction("upload_voice");
    const audio = await synthesize(claudeResponse, detectedLang);
    console.log(`TTS: result=${audio ? audio.length + ' bytes' : 'null'}`);
    if (audio) {
      await ctx.replyWithVoice(new InputFile(audio, "response.ogg"));
      console.log("TTS: voice sent successfully");
    } else {
      console.log("TTS: falling back to text");
      // Fallback to text if TTS fails
      await sendResponse(ctx, claudeResponse);
    }
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can read images via the Read tool
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `The user sent an image. Use the Read tool to view this image file: ${filePath}\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { userMessage: caption });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { userMessage: caption });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  recentHistory?: string,
  ms365Context?: string,
  hospitableContext?: string,
  searchContext?: string,
  travelContext?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
    "IMPORTANT: Always reply in the same language the user is writing or speaking in. Match their language exactly.",
    "VOICE: When you receive a voice message transcription, just respond to the content naturally with text. " +
      "The system automatically converts your text response to a voice message via TTS — do NOT mention voice capabilities or limitations.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);
  if (recentHistory) parts.push(`\n${recentHistory}`);

  // MS365 data (emails, calendar) fetched directly from Microsoft Graph API
  if (ms365Context) {
    parts.push(`\nMICROSOFT 365 DATA:\n${ms365Context}`);
    parts.push(
      "\nMS365 ACTIONS:" +
        "\nWhen the user asks you to take actions on their email or calendar, include these tags:" +
        "\n[CREATE_EVENT: subject | start_datetime (ISO) | end_datetime (ISO) | timezone]" +
        "\n  Example: [CREATE_EVENT: Lunch with Niki | 2026-02-18T12:00:00 | 2026-02-18T13:00:00 | America/New_York]" +
        "\n[UPDATE_EVENT: event_subject_search_text | new_start_datetime (ISO) | new_end_datetime (ISO) | timezone]" +
        "\n  Use UPDATE_EVENT when the user wants to move, reschedule, or change the time of an existing event." +
        "\n  Example: [UPDATE_EVENT: Lunch with Fabio | 2026-02-26T12:30:00 | 2026-02-26T13:30:00 | America/Sao_Paulo]" +
        "\n  Keep the same duration unless the user specifies otherwise." +
        "\n[DELETE_EVENT: event_subject_search_text]" +
        "\n  Use DELETE_EVENT when the user wants to cancel or remove an event." +
        "\n[ACCEPT_EVENT: event subject text to search]" +
        "\n[DECLINE_EVENT: event subject text to search]" +
        "\n[SEND_EMAIL: recipient@email.com | Subject line | Email body text]" +
        "\n[CREATE_TASK: list_name | task title]" +
        "\n  Example: [CREATE_TASK: Groceries | Nespresso coffee]" +
        "\n  Match the list name from the TASK LISTS shown in the MS365 data. Use the closest match." +
        "\n[CREATE_DRAFT: recipient@email.com | Subject line | Email body text]" +
        "\n  Use CREATE_DRAFT when the user asks to save a draft, add to drafts, or write an email without sending it." +
        "\n[CREATE_MAIL_FOLDER: folder_name]" +
        "\n  Creates a subfolder under Inbox. Example: [CREATE_MAIL_FOLDER: Potential Spam]" +
        "\n[MOVE_EMAILS: folder_name | email_id_1, email_id_2, ...]" +
        "\n  Moves emails to a folder (auto-creates folder if needed). Use actual email IDs from the data above." +
        "\n  Example: [MOVE_EMAILS: Potential Spam | AAMkAGQ..., AAMkAGR...]" +
        "\nThese tags are processed automatically — include them in your response along with a human-friendly confirmation." +
        "\nIMPORTANT: When the user asks to MOVE or RESCHEDULE an event, use UPDATE_EVENT (not CREATE_EVENT + manual delete)." +
        "\nAlways CONFIRM with the user before sending emails or making calendar changes." +
        "\nFor drafts, you can save directly when the user asks — no confirmation needed since it doesn't send anything." +
        "\nSummarize emails concisely rather than showing raw data."
    );
  }

  // Hospitable data (vacation rentals, reservations, guest messaging)
  if (hospitableContext) {
    parts.push(`\nHOSPITABLE DATA (Vacation Rentals):\n${hospitableContext}`);
    parts.push(
      "\nHOSPITABLE ACTIONS:" +
        "\nWhen the user asks you to send a message to a guest, use the correct tag based on the type:" +
        "\nFor RESERVATIONS: [SEND_GUEST_MESSAGE: reservation_uuid | message body text]" +
        "\nFor INQUIRIES (no reservation yet): [SEND_INQUIRY_MESSAGE: inquiry_uuid | message body text]" +
        "\n  Example: [SEND_GUEST_MESSAGE: 6f58fd0a-a9cb-3746-9219-384a156ff7bb | Hi! Your check-in is at 3pm.]" +
        "\n  Example: [SEND_INQUIRY_MESSAGE: 90683af9-9dbd-4583-9a12-4f0b8dea3124 | Hi! Yes, those dates work perfectly.]" +
        "\nThe UUID and type (reservation vs inquiry) are provided in the data above." +
        "\nAlways CONFIRM with the user before sending messages to guests." +
        "\nWhen the user CONFIRMS a previously proposed message (e.g., 'sim', 'yes', 'manda', 'send it')," +
        "\nimmediately emit the action tag with the correct UUID and the message body from your previous response." +
        "\nDo NOT ask the user to copy/paste — you CAN send messages directly through Hospitable." +
        "\n\nINBOX PRESENTATION STYLE:" +
        "\nWhen the user asks for 'messages' or 'inbox', present the data as a clear summary:" +
        "\n- Group by urgency: NEEDS YOUR ATTENTION first, then WAITING ON GUEST, then DEAD THREADS" +
        "\n- For each conversation, show: guest name, property, status, dates, and the last few messages" +
        "\n- Highlight who needs to respond (you or the guest)" +
        "\n- Exclude currently-staying guests by default (unless the user asks about them)" +
        "\n- Offer quick wins: suggest drafting replies for conversations waiting on a response from the host" +
        "\nSummarize reservation data concisely. Group by property if multiple properties."
    );
  }

  // Web search results (fetched directly by the relay)
  if (searchContext) {
    parts.push(`\n${searchContext}`);
    parts.push(
      "\nUse the search results above to answer the user's question with current information. " +
        "Cite specific facts from the results. If the results don't fully answer the question, say so."
    );
  }

  // Travel skills: /flights and /hotels
  if (travelContext) {
    parts.push(`\n${travelContext}`);

    if (userMessage.trim().toLowerCase().startsWith("/flights")) {
      parts.push(
        "\nFLIGHT SEARCH EXPERT MODE:" +
          "\nYou have real-time flight data above (from Kiwi.com API or web search fallback)." +
          "\nPresent the results clearly and concisely:" +
          "\n1. List the top flights: price, airline, duration, stops, departure times" +
          "\n2. Highlight the BEST VALUE — cheapest, shortest, or best airline" +
          "\n3. Include the booking link (🔗) for each flight so the user can book with one tap" +
          "\n4. If checked bag prices are shown, mention total cost with 1 checked bag" +
          "\n5. If seats are limited, flag urgency (e.g. '⚠️ only 3 seats left')" +
          "\n6. Suggest trying nearby dates or alternate airports for even cheaper options" +
          "\n7. If the data came from web search (not API), note that prices are approximate" +
          "\nBe specific, actionable, and concise. Use $USD prices." +
          "\nIf the user only said '/flights' without details, ask them: origin city, destination, approximate dates, and if they're flexible."
      );
    } else if (userMessage.trim().toLowerCase().startsWith("/hotels")) {
      parts.push(
        "\nHOTEL & DINING EXPERT MODE:" +
          "\nYou are a budget travel expert. Using the search results above, provide:" +
          "\n1. Three hotel or Airbnb options near central locations or popular attractions — with name, price per night, location, and why it's a good pick" +
          "\n2. Three local restaurant recommendations where meals are affordable and loved by locals — with name, cuisine, price range, and what to order" +
          "\nPrioritize value: good location + good price + good food, not luxury." +
          "\nBe specific with prices, neighborhoods, and booking links when available." +
          "\nIf the user only said '/hotels' without details, ask them: destination, number of days, budget per night, and food budget per meal."
      );
    }
  }

  parts.push(
    "\nFILE CREATION:" +
      "\nWhen the user asks you to create a file, you have two methods:" +
      "\n" +
      "\nUse action tags to create files (processed automatically, never use the Write tool for files):" +
      "\n" +
      "\nEXCEL: [CREATE_EXCEL: filename.xlsx | Sheet Name | Header1 \\t Header2 \\n Row1Col1 \\t Row1Col2]" +
      "\nPPTX:  [CREATE_PPTX: filename.pptx | Slide 1 Title | Slide 1 body ||| Slide 2 Title | Slide 2 body]" +
      "\n" +
      "\nHTML, DOCX, and PDF use BLOCK tags with closing markers (content can contain any characters):" +
      "\n" +
      "\n  [CREATE_HTML: filename.html]" +
      "\n  <html>...full HTML content...</html>" +
      "\n  [/CREATE_HTML]" +
      "\n" +
      "\n  [CREATE_DOCX: filename.docx]" +
      "\n  # Title" +
      "\n  ## Section" +
      "\n  Paragraph text" +
      "\n  - Bullet point" +
      "\n  [/CREATE_DOCX]" +
      "\n" +
      "\n  [CREATE_PDF: filename.pdf]" +
      "\n  # Title" +
      "\n  Paragraph text" +
      "\n  - Bullet point" +
      "\n  [/CREATE_PDF]" +
      "\n" +
      "\nFor Excel: separate columns with \\t (tab), rows with \\n (newline). First row = headers." +
      "\nFor HTML: write complete, well-styled HTML with inline CSS. Make it visually polished." +
      "\nFor Word (.docx): use markdown formatting (# headings, ## subheadings, **bold**, *italic*, - bullets, numbered lists, | pipe tables |)." +
      "\nFor PDF: use markdown-like formatting (# headings, - bullets, numbered lists)." +
      "\nFor PowerPoint: separate slides with |||, separate title from body with |." +
      "\nIMPORTANT: When the user asks for 'Word', 'documento', 'Word document', or 'docx' → use CREATE_DOCX (not PDF)." +
      "\nIMPORTANT: HTML, DOCX, and PDF MUST use block format with [/CREATE_HTML], [/CREATE_DOCX], or [/CREATE_PDF] closing tags." +
      "\n" +
      "\nAll files are automatically sent to the user via Telegram AND saved to the Ona folder." +
      "\nCRITICAL: When creating files, the document content must ONLY appear inside the action tag. Do NOT repeat or preview the content as plain text in your response. Your response should contain ONLY the action tag plus a SHORT confirmation (1-3 sentences) of what you created. The user will receive the file directly — they do not need to see the content in chat." +
      "\nPrefer the format the user requests (e.g., 'em Word' → DOCX, 'documento' → DOCX, 'planilha' → Excel, 'apresentação' → PPTX)."
  );

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  // Phone calling via Twilio
  if (isCallConfigured()) {
    const phoneUS = process.env.USER_PHONE_US || "";
    const phoneBR = process.env.USER_PHONE_BR || "";
    parts.push(
      "\nPHONE CALLS:" +
        "\nYou can call the user via Twilio. Use this action tag:" +
        "\n[MAKE_CALL: phone_number | greeting message]" +
        "\n" +
        `\n${USER_NAME}'s phone numbers:` +
        `\n  US mobile: ${phoneUS}` +
        `\n  Brazil mobile: ${phoneBR}` +
        "\n" +
        "\nRules:" +
        "\n- \"Call me\", \"call me\" → call US number, greet in English" +
        "\n- \"Me liga\", \"me chama\" → call US number, greet in Portuguese" +
        "\n- \"Call me in Brazil\", \"me chama no Brasil\", \"me liga no Brasil\" → call Brazil number, greet in corresponding language" +
        "\n- The greeting message should be brief and natural (e.g., \"Hey Gil, you asked me to call!\")" +
        "\n- Match the greeting language to the user's request language" +
        "\n- Do NOT ask for confirmation — just make the call immediately when requested"
    );
  }

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Guard against empty responses (Telegram rejects empty messages)
  if (!response || !response.trim()) {
    response = "Something went wrong on my end. Try again in a sec!";
  }

  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

// Global error handlers
bot.catch((err) => {
  console.error("Grammy error:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  drop_pending_updates: true,
  onStart: () => {
    console.log("Bot is running!");
    // Sync Hospitable financial data to Supabase on startup
    if (process.env.HOSPITABLE_ENABLED === "true") {
      syncTransactionsToSupabase()
        .then((n) => n > 0 && console.log(`Synced ${n} Hospitable transactions to Supabase`))
        .catch((e) => console.error("Hospitable sync failed:", e.message));
      // Re-sync every 6 hours
      setInterval(() => {
        syncTransactionsToSupabase().catch((e) =>
          console.error("Periodic Hospitable sync failed:", e.message)
        );
      }, 6 * 60 * 60 * 1000);
    }
  },
});
