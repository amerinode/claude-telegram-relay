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
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
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
  acceptCalendarEvent,
  declineCalendarEvent,
  sendEmail,
  createDraft,
} from "./ms365.ts";
import { generateDocx } from "./document.ts";
import { generateXlsx } from "./spreadsheet.ts";
import { generatePptx } from "./presentation.ts";

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
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
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
  // Build the base Claude CLI arguments
  const claudeArgs = ["-p", prompt, "--no-session-persistence", "--output-format", "text"];

  // Allow web access tools based on configured search provider
  const allowedTools = ["WebFetch", "WebSearch"];
  const searchProvider = process.env.SEARCH_PROVIDER || "brave";
  if (searchProvider === "brave") {
    allowedTools.push("mcp__brave-search__brave_web_search", "mcp__brave-search__brave_local_search");
  } else if (searchProvider === "perplexity") {
    allowedTools.push("mcp__perplexity__perplexity_search", "mcp__perplexity__perplexity_ask", "mcp__perplexity__perplexity_research", "mcp__perplexity__perplexity_reason");
  }

  claudeArgs.push("--allowedTools", ...allowedTools);

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);
  console.log(`Allowed tools: ${allowedTools.join(", ")}`);

  try {
    // Strip Claude Code env vars to avoid nesting detection
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const spawnArgs = [CLAUDE_PATH, ...claudeArgs];

    const proc = spawn(spawnArgs, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: cleanEnv,
    });

    // 2-minute timeout to prevent hanging
    const TIMEOUT_MS = 120_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error("Claude CLI timed out after 2 minutes"));
      }, TIMEOUT_MS)
    );

    const result = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const [output, stderr, exitCode] = await Promise.race([result, timeout]);

    if (exitCode !== 0) {
      console.error(`Claude exit code: ${exitCode}`);
      console.error(`Claude stderr: ${stderr.substring(0, 500)}`);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    return output.trim();
  } catch (error: any) {
    console.error("Spawn error:", error?.message || error);
    if (error?.message?.includes("timed out")) {
      return "Sorry, the request took too long. Please try again with a simpler message.";
    }
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
function needsMs365(message: string): boolean {
  if (process.env.MS365_ENABLED !== "true") return false;

  const ms365ActionPatterns = [
    // Email actions: fetch, read, check, show, open, list, send, delete, forward
    /\b(show|read|check|fetch|list|open|get|find|search|send|forward|reply|delete|move|compose|draft|write)\b.{0,20}\b(emails?|e-mails?|mails?|inbox|messages?)\b/i,
    /\b(emails?|e-mails?|mails?|inbox)\b.{0,20}\b(from|to|today|this week|unread|latest|recent|new)\b/i,
    /\b(enviar|ler|buscar|mostrar|abrir|verificar|checar|mandar)\b.{0,20}\b(emails?|e-mails?)\b/i,
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
  ];

  return ms365ActionPatterns.some(p => p.test(message));
}

/**
 * Process MS365 action tags in Claude's response.
 * Claude can include these tags to trigger real actions:
 *   [CREATE_EVENT: subject | start_datetime | end_datetime | timezone]
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

  // [SEND_EMAIL: to | subject | body] — body can span multiple lines
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

  // [CREATE_DRAFT: to | subject | body] — body can span multiple lines
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

  return clean;
}

// ============================================================
// DOCUMENT GENERATION & SENDING
// ============================================================

/**
 * Process [SEND_DOCUMENT: filename | title | content...] tags in Claude's response.
 * Generates a .docx file and sends it via Telegram, then strips the tag from the response.
 */
async function processDocumentActions(
  ctx: Context,
  response: string
): Promise<string> {
  let clean = response;

  // [SEND_DOCUMENT: filename.docx | Document Title | markdown content...]
  // Content can span multiple lines, so use [\s\S]+? (non-greedy)
  const docRegex = /\[SEND_DOCUMENT:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi;

  for (const match of response.matchAll(docRegex)) {
    const rawFilename = match[1].trim();
    const title = match[2].trim();
    const content = match[3].trim();

    // Ensure .docx extension
    const filename = rawFilename.endsWith(".docx") ? rawFilename : `${rawFilename}.docx`;

    try {
      console.log(`Generating document: ${filename} ("${title}")`);
      await ctx.replyWithChatAction("upload_document");

      const docBuffer = await generateDocx(content, title);
      await ctx.replyWithDocument(new InputFile(docBuffer, filename));

      console.log(`Sent document: ${filename} (${docBuffer.length} bytes)`);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      console.error("Document generation error:", error.message);
      clean = clean.replace(
        match[0],
        `(Could not generate document: ${error.message})`
      );
    }
  }

  return clean;
}

/**
 * Process [SEND_SPREADSHEET: filename.xlsx | content...] tags in Claude's response.
 * Generates a .xlsx file and sends it via Telegram, then strips the tag from the response.
 */
async function processSpreadsheetActions(
  ctx: Context,
  response: string
): Promise<string> {
  let clean = response;

  // [SEND_SPREADSHEET: filename.xlsx | sheet/table content...]
  // Content can span multiple lines, so use [\s\S]+? (non-greedy)
  const xlsxRegex = /\[SEND_SPREADSHEET:\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi;

  for (const match of response.matchAll(xlsxRegex)) {
    const rawFilename = match[1].trim();
    const content = match[2].trim();

    // Ensure .xlsx extension
    const filename = rawFilename.endsWith(".xlsx") ? rawFilename : `${rawFilename}.xlsx`;

    try {
      console.log(`Generating spreadsheet: ${filename}`);
      await ctx.replyWithChatAction("upload_document");

      const xlsxBuffer = await generateXlsx(content);
      await ctx.replyWithDocument(new InputFile(xlsxBuffer, filename));

      console.log(`Sent spreadsheet: ${filename} (${xlsxBuffer.length} bytes)`);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      console.error("Spreadsheet generation error:", error.message);
      clean = clean.replace(
        match[0],
        `(Could not generate spreadsheet: ${error.message})`
      );
    }
  }

  return clean;
}

/**
 * Process [SEND_PRESENTATION: filename.pptx | content...] tags in Claude's response.
 * Generates a .pptx file and sends it via Telegram, then strips the tag from the response.
 */
async function processPresentationActions(
  ctx: Context,
  response: string
): Promise<string> {
  let clean = response;

  // [SEND_PRESENTATION: filename.pptx | slide content...]
  // Content can span multiple lines, so use [\s\S]+? (non-greedy)
  const pptxRegex = /\[SEND_PRESENTATION:\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi;

  for (const match of response.matchAll(pptxRegex)) {
    const rawFilename = match[1].trim();
    const content = match[2].trim();

    // Ensure .pptx extension
    const filename = rawFilename.endsWith(".pptx") ? rawFilename : `${rawFilename}.pptx`;

    try {
      console.log(`Generating presentation: ${filename}`);
      await ctx.replyWithChatAction("upload_document");

      const pptxBuffer = await generatePptx(content);
      await ctx.replyWithDocument(new InputFile(pptxBuffer, filename));

      console.log(`Sent presentation: ${filename} (${pptxBuffer.length} bytes)`);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      console.error("Presentation generation error:", error.message);
      clean = clean.replace(
        match[0],
        `(Could not generate presentation: ${error.message})`
      );
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

  await ctx.replyWithChatAction("typing");

  await saveMessage("user", text);

  // Gather context: recent history + semantic search + facts/goals
  const [recentHistory, relevantContext, memoryContext] = await Promise.all([
    getRecentHistory(supabase, 20),
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
  ]);

  // Check if we need MS365 data (email/calendar)
  let ms365Context = "";
  if (needsMs365(text)) {
    console.log("MS365 request detected, fetching data via Graph API...");
    ms365Context = await handleMs365Request(text, recentHistory);
    console.log(`MS365 context: ${ms365Context.substring(0, 100)}...`);
  }

  const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext, recentHistory, ms365Context);
  const rawResponse = await callClaude(enrichedPrompt, { userMessage: text });

  // Process MS365 action tags (create event, accept, send email, draft, etc.)
  // Always check — Claude may emit action tags even without explicit ms365Context
  const afterActions = await processMs365Actions(rawResponse);

  // Process document generation tags — sends files via Telegram
  const afterDocs = await processDocumentActions(ctx, afterActions);

  // Process spreadsheet generation tags — sends .xlsx files via Telegram
  const afterSheets = await processSpreadsheetActions(ctx, afterDocs);

  // Process presentation generation tags — sends .pptx files via Telegram
  const afterSlides = await processPresentationActions(ctx, afterSheets);

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, afterSlides);

  await saveMessage("assistant", response);
  await sendResponse(ctx, response);
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
      getRecentHistory(supabase, 20),
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
    ]);

    // Check if we need MS365 data (email/calendar)
    let ms365Context = "";
    if (needsMs365(transcription)) {
      console.log("MS365 request detected in voice, fetching data via Graph API...");
      ms365Context = await handleMs365Request(transcription, recentHistory);
    }

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext,
      recentHistory,
      ms365Context
    );
    const rawResponse = await callClaude(enrichedPrompt, { userMessage: transcription });
    const afterActions = await processMs365Actions(rawResponse);
    const afterDocs = await processDocumentActions(ctx, afterActions);
    const afterSheets = await processSpreadsheetActions(ctx, afterDocs);
    const afterSlides = await processPresentationActions(ctx, afterSheets);
    const claudeResponse = await processMemoryIntents(supabase, afterSlides);

    await saveMessage("assistant", claudeResponse);

    // TTS: reply with voice, matching the user's spoken language
    await ctx.replyWithChatAction("upload_voice");
    const audio = await synthesize(claudeResponse, detectedLang);
    if (audio) {
      await ctx.replyWithVoice(new InputFile(audio, "response.ogg"));
    } else {
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

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { userMessage: caption });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const afterDocs = await processDocumentActions(ctx, claudeResponse);
    const afterSheets = await processSpreadsheetActions(ctx, afterDocs);
    const afterSlides = await processPresentationActions(ctx, afterSheets);
    const cleanResponse = await processMemoryIntents(supabase, afterSlides);
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

    const afterDocs = await processDocumentActions(ctx, claudeResponse);
    const afterSheets = await processSpreadsheetActions(ctx, afterDocs);
    const afterSlides = await processPresentationActions(ctx, afterSheets);
    const cleanResponse = await processMemoryIntents(supabase, afterSlides);
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
  ms365Context?: string
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
        "\n[ACCEPT_EVENT: event subject text to search]" +
        "\n[DECLINE_EVENT: event subject text to search]" +
        "\n[SEND_EMAIL: recipient@email.com | Subject line | Email body text]" +
        "\n[CREATE_DRAFT: recipient@email.com | Subject line | Email body text]" +
        "\n  Use CREATE_DRAFT when the user asks to save a draft, add to drafts, or write an email without sending it." +
        "\nThese tags are processed automatically — include them in your response along with a human-friendly confirmation." +
        "\nAlways CONFIRM with the user before sending emails or making calendar changes." +
        "\nFor drafts, you can save directly when the user asks — no confirmation needed since it doesn't send anything." +
        "\nSummarize emails concisely rather than showing raw data."
    );
  }

  parts.push(
    "\nDOCUMENT GENERATION:" +
      "\nYou CAN generate and send Word documents (.docx) directly in Telegram!" +
      "\nWhen the user asks you to create, write, or send a document/file/Word doc, include this tag:" +
      "\n[SEND_DOCUMENT: filename.docx | Document Title | full document content in markdown]" +
      "\nThe content supports: # headings, **bold**, *italic*, - bullet lists, 1. numbered lists, and | tables |." +
      "\nThe document is generated and sent as a .docx file attachment in Telegram automatically." +
      "\nWrite the full document content inside the tag — do NOT say you can't create files." +
      "\nExample: [SEND_DOCUMENT: proposal.docx | Business Proposal | # Introduction\\n\\nThis proposal outlines...\\n\\n## Key Points\\n\\n- Point one\\n- Point two]"
  );

  parts.push(
    "\nSPREADSHEET GENERATION:" +
      "\nYou CAN generate and send Excel spreadsheets (.xlsx) directly in Telegram!" +
      "\nWhen the user asks you to create a spreadsheet, Excel file, or tabular data, include this tag:" +
      "\n[SEND_SPREADSHEET: filename.xlsx |" +
      "\n## Sheet: SheetName" +
      "\n| Header1 | Header2 | Header3 |" +
      "\n| value1 | value2 | =A2+B2 |" +
      "\n---" +
      "\n## Sheet: AnotherSheet" +
      "\n| Col A | Col B |" +
      "\n| data | data |" +
      "\n]" +
      "\nFormat rules:" +
      "\n- Use ## Sheet: Name to start each sheet (separate multiple sheets with ---)" +
      "\n- Use standard markdown pipe tables for rows and columns" +
      "\n- First row of each table becomes the bold header row" +
      "\n- Cells starting with = are treated as Excel formulas (e.g., =SUM(A2:A10), =B2*C2)" +
      "\n- Cross-sheet references work (e.g., =Inputs!B2)" +
      "\n- Numeric values are auto-detected and stored as numbers" +
      "\n- You can create multiple sheets in one file" +
      "\n- Write the full spreadsheet content inside the tag — do NOT say you cannot create Excel files."
  );

  parts.push(
    "\nPRESENTATION GENERATION:" +
      "\nYou CAN generate and send PowerPoint presentations (.pptx) directly in Telegram!" +
      "\nWhen the user asks you to create a presentation, slides, or PowerPoint, include this tag:" +
      "\n[SEND_PRESENTATION: filename.pptx |" +
      "\n## Slide: Title Slide" +
      "\n# Main Title" +
      "\n## Subtitle" +
      "\n" +
      "\n## Slide: Key Points" +
      "\n- Bullet point one" +
      "\n- Bullet point two" +
      "\n" +
      "\n## Slide: Data Table" +
      "\n| Header1 | Header2 | Header3 |" +
      "\n| val1 | val2 | val3 |" +
      "\n]" +
      "\nFormat rules:" +
      "\n- Use ## Slide: Title to start each slide" +
      "\n- # Title for large headings, ## Subtitle for subtitles" +
      "\n- Use - for bullet points, 1. for numbered lists" +
      "\n- Use pipe tables for data tables on slides" +
      "\n- Plain text becomes body text" +
      "\n- Each slide gets a styled title bar automatically" +
      "\n- Write the full presentation content inside the tag — do NOT say you cannot create PowerPoint files."
  );

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
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

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
