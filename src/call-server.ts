/**
 * Phone Call WebSocket Server (Twilio ConversationRelay)
 *
 * Accepts WebSocket connections from Twilio ConversationRelay,
 * receives transcribed speech from the caller, sends it to Claude CLI,
 * and returns Claude's response as text for Twilio to speak.
 *
 * Runs alongside the Telegram relay as a separate PM2 service.
 *
 * Start: bun run src/call-server.ts
 * Requires ngrok: ngrok http 8080
 */

import { spawn } from "bun";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { detectLanguage } from "./tts.ts";
import { getNgrokUrl } from "./ngrok.ts";
import {
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
} from "./memory.ts";
import { handleMs365Request } from "./ms365.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = parseInt(process.env.CALL_SERVER_PORT || "8080", 10);
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE =
  process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// SUPABASE (optional — for memory context)
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
// MS365 DETECTION (same patterns as relay.ts)
// ============================================================

function needsMs365(message: string): boolean {
  if (process.env.MS365_ENABLED !== "true") return false;

  const ms365ActionPatterns = [
    /\b(show|read|check|fetch|list|open|get|find|search|send|forward|reply|delete|move|compose|draft|write)\b.{0,20}\b(emails?|e-mails?|mails?|inbox|messages?)\b/i,
    /\b(emails?|e-mails?|mails?|inbox)\b.{0,20}\b(from|to|today|this week|unread|latest|recent|new)\b/i,
    // Reverse order: "new emails", "any new emails", "latest emails"
    /\b(any |)(new|latest|recent|unread)\b.{0,10}\b(emails?|e-mails?|mails?)\b/i,
    /\b(enviar|ler|buscar|mostrar|abrir|verificar|checar|mandar)\b.{0,20}\b(emails?|e-mails?)\b/i,
    // Portuguese email patterns
    /\b(novos?|últimos?|recentes?)\b.{0,10}\b(emails?|e-mails?)\b/i,
    /\b(emails?|e-mails?)\b.{0,10}\b(novos?|recentes?|de hoje)\b/i,
    /\b(meus? emails?|meus? e-mails?)\b/i,
    // Calendar
    /\b(show|check|what'?s on|list|open|get|add|create|schedule|cancel|remove|move|reschedule|book)\b.{0,20}\b(calendars?|schedule|agenda|meetings?|events?|appointments?|lunch|dinner|call)\b/i,
    /\b(next|upcoming|today'?s?|this week'?s?)\b.{0,20}\b(meetings?|events?|appointments?|calls?)\b/i,
    /\b(meetings?|events?|appointments?)\b.{0,20}\b(today|this week|tomorrow|scheduled)\b/i,
    /\b(calend[aá]rios?|agendas?|reuni[aãõ]o|reuni[oõ]es|eventos?)\b.{0,20}\b(hoje|semana|próxim|agendar|criar|adicionar|cancelar)\b/i,
    /\b(agendar|marcar|criar|adicionar)\b.{0,30}\b(reuni|almoço|jantar|chamada|evento)\b/i,
    /\b(my (latest|recent|unread|new) (emails?|mails?))\b/i,
    /\b(my (calendar|schedule|agenda|meetings?))\b/i,
    /\bwhen is my next\b/i,
    /\binbox\b/i,
    /\boutlook\b/i,
    // To Do / Tasks
    /\b(show|list|check|get|read|add|create|complete|done|finish)\b.{0,20}\b(tasks?|to-?dos?)\b/i,
    /\b(tasks?|to-?dos?)\b.{0,20}\b(list|pending|today|overdue|due)\b/i,
    /\b(my (tasks?|to-?dos?|to do list))\b/i,
    /\b(tarefas?|lista de tarefas?|pendências|afazeres)\b/i,
    /\bwhat do i (need|have) to do\b/i,
    /\b(o que|que).{0,10}(preciso|tenho que) fazer\b/i,
  ];

  return ms365ActionPatterns.some(p => p.test(message));
}

// ============================================================
// PER-CALL SESSION
// ============================================================

interface CallSession {
  callSid: string;
  from: string;
  to: string;
  reason: string;
  lang: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  startedAt: Date;
}

const activeSessions = new Map<WebSocket, CallSession>();

// ============================================================
// CLAUDE CLI (phone-optimized)
// ============================================================

/**
 * Call Claude CLI with a phone-optimized prompt.
 * Includes web search tools, memory context, and MS365 data — same as Telegram relay.
 * Returns the text response (short, no markdown, conversational).
 */
async function callClaudeForPhone(
  userSpeech: string,
  session: CallSession
): Promise<string> {
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

  // Build conversation history context (in-call history)
  const historyLines = session.history
    .slice(-10) // Keep last 10 exchanges for context
    .map((msg) => `${msg.role === "user" ? USER_NAME || "User" : "Ona"}: ${msg.content}`)
    .join("\n");

  // Fetch memory & MS365 context in parallel (same as relay.ts)
  const [recentHistory, relevantContext, memoryContext] = await Promise.all([
    getRecentHistory(supabase, 10),
    getRelevantContext(supabase, userSpeech),
    getMemoryContext(supabase),
  ]);

  // Check if this question needs email/calendar data
  let ms365Context = "";
  if (needsMs365(userSpeech)) {
    console.log(`[${session.callSid}] MS365 request detected, fetching...`);
    try {
      ms365Context = await handleMs365Request(userSpeech, recentHistory || "");
      console.log(`[${session.callSid}] MS365 context: ${ms365Context.substring(0, 80)}...`);
    } catch (error: any) {
      console.error(`[${session.callSid}] MS365 error: ${error.message}`);
    }
  }

  const promptParts = [
    "You are Ona, a lively and warm personal AI assistant on a PHONE CALL.",
    "You are speaking, not typing. This is a live voice conversation.",
    "",
    "YOUR PERSONALITY ON THE PHONE:",
    "- You're like a sharp, fun, trusted friend who happens to know everything.",
    "- Be warm, upbeat, and genuinely engaging — smile through your words.",
    "- Drop light humor when natural: a witty observation, a playful remark, a little teasing.",
    "- Be expressive: react to what the caller says with real energy — laugh, empathize, get excited.",
    "- In Portuguese, be naturally Brazilian: use 'tranquilo', 'show', 'beleza', 'olha só'.",
    "- In English, be casual and approachable — contractions, natural phrasing, personality.",
    "",
    "PHONE CALL RULES:",
    "- NEVER introduce yourself or say your name. The caller already knows who you are. Just respond naturally.",
    "- NEVER say 'aqui é a Ona', 'soy Ona', 'this is Ona' or any variation. Skip straight to the point.",
    "- Keep responses SHORT: 1-3 sentences max. People can't absorb long spoken text.",
    "- NO markdown, no bullet points, no formatting. Just natural spoken language.",
    "- NO emojis, no special characters, no asterisks.",
    "- Match the caller's language EXACTLY (Portuguese, English, Spanish).",
    "- When sharing email or calendar info, summarize it conversationally — don't list raw data.",
    "- For search results, give a brief spoken answer — no URLs or links.",
    "- If you don't know something, be light about it: 'Hmm, that one's got me' or 'Essa me pegou'.",
    "",
    USER_NAME ? `You are speaking with ${USER_NAME}.` : "",
    `Current time: ${timeStr}`,
    profileContext ? `\nAbout ${USER_NAME || "the caller"}:\n${profileContext}` : "",
  ];

  // Add memory context (facts, goals, recent Telegram messages)
  if (memoryContext) promptParts.push(`\n${memoryContext}`);
  if (relevantContext) promptParts.push(`\n${relevantContext}`);
  if (recentHistory) promptParts.push(`\nRecent Telegram messages (for context):\n${recentHistory}`);

  // Add MS365 data
  if (ms365Context) {
    promptParts.push(`\nEMAIL & CALENDAR DATA:\n${ms365Context}`);
    promptParts.push(
      "Summarize email/calendar info conversationally in 1-2 spoken sentences. " +
      "Don't read out full email bodies or raw event data."
    );
  }

  // Add call-specific context
  if (session.reason) promptParts.push(`\nReason for this call: ${session.reason}`);
  if (historyLines) promptParts.push(`\nConversation so far:\n${historyLines}`);

  promptParts.push(`\n${USER_NAME || "Caller"}: ${userSpeech}`);
  promptParts.push("\nOna:");

  const systemPrompt = promptParts.filter(Boolean).join("\n");

  try {
    // Strip Claude Code env vars to avoid nesting detection
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    // Build CLI args with allowed tools (same as relay.ts)
    const claudeArgs = [
      "-p",
      systemPrompt,
      "--no-session-persistence",
      "--output-format",
      "text",
    ];

    // Enable web search tools
    const allowedTools = ["WebFetch", "WebSearch"];
    const searchProvider = process.env.SEARCH_PROVIDER || "brave";
    if (searchProvider === "brave") {
      allowedTools.push("mcp__brave-search__brave_web_search", "mcp__brave-search__brave_local_search");
    } else if (searchProvider === "perplexity") {
      allowedTools.push("mcp__perplexity__perplexity_search", "mcp__perplexity__perplexity_ask", "mcp__perplexity__perplexity_research", "mcp__perplexity__perplexity_reason");
    }
    claudeArgs.push("--allowedTools", ...allowedTools);

    const proc = spawn(
      [CLAUDE_PATH, ...claudeArgs],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: PROJECT_DIR || undefined,
        env: cleanEnv,
      }
    );

    // 45-second timeout for phone calls (longer than before to allow for search/MS365)
    const TIMEOUT_MS = 45_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error("Claude CLI timed out"));
      }, TIMEOUT_MS)
    );

    const result = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const [output, stderr, exitCode] = await Promise.race([result, timeout]);

    if (exitCode !== 0) {
      console.error(`Claude CLI error (exit ${exitCode}): ${stderr.substring(0, 200)}`);
      return session.lang === "pt"
        ? "Desculpa, tive um problema. Pode repetir?"
        : "Sorry, I had a problem. Could you repeat that?";
    }

    // Clean up: remove any markdown artifacts Claude might add
    return output
      .trim()
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/^#+\s*/gm, "")
      .replace(/^- /gm, "")
      .replace(/`/g, "")
      .replace(/\[.*?\]\(.*?\)/g, ""); // Remove markdown links
  } catch (error: any) {
    console.error("Claude phone error:", error?.message || error);
    return session.lang === "pt"
      ? "Desculpa, demorei demais. Pode tentar de novo?"
      : "Sorry, that took too long. Can you try again?";
  }
}

// ============================================================
// WEBSOCKET SERVER (Bun.serve)
// ============================================================

console.log(`Starting Call Server on port ${PORT}...`);

const server = Bun.serve({
  port: PORT,

  // HTTP handler — health check endpoint
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for /conversation path
    if (url.pathname === "/conversation") {
      const upgraded = server.upgrade(req, {
        data: {
          reason: url.searchParams.get("reason") || "",
          lang: url.searchParams.get("lang") || "en",
        },
      });
      if (upgraded) return; // Bun handles the rest
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          activeCalls: activeSessions.size,
          uptime: process.uptime(),
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Claude Call Server", { status: 200 });
  },

  websocket: {
    open(ws) {
      console.log("WebSocket connection opened");
      // Session will be created when we receive the setup event
    },

    async message(ws, message) {
      try {
        const data = JSON.parse(
          typeof message === "string" ? message : Buffer.from(message).toString()
        );

        switch (data.type) {
          case "setup": {
            // Twilio sends this immediately after connecting
            const lang = (ws.data as any)?.lang || "en";
            const reason = decodeURIComponent(
              (ws.data as any)?.reason || ""
            );

            const session: CallSession = {
              callSid: data.callSid || "unknown",
              from: data.from || "",
              to: data.to || "",
              reason,
              lang,
              history: [],
              startedAt: new Date(),
            };

            activeSessions.set(ws as any, session);
            console.log(
              `Call setup: SID=${session.callSid}, from=${session.from}, lang=${lang}, reason="${reason.substring(0, 50)}"`
            );
            break;
          }

          case "prompt": {
            // Caller spoke — voicePrompt contains the transcribed text
            const userSpeech = data.voicePrompt;
            if (!userSpeech?.trim()) break;

            const session = activeSessions.get(ws as any);
            if (!session) {
              console.error("No session found for this WebSocket");
              break;
            }

            // Detect language from speech if different from initial
            const detectedLang = detectLanguage(userSpeech);
            if (detectedLang !== "en") {
              session.lang = detectedLang;
            }

            console.log(
              `[${session.callSid}] ${USER_NAME || "Caller"}: "${userSpeech}"`
            );

            // Add to history
            session.history.push({ role: "user", content: userSpeech });

            // Check for goodbye signals
            const goodbyePatterns =
              /\b(tchau|bye|goodbye|adeus|até logo|até mais|encerr|deslig|hang up|that'?s all|that is all)\b/i;
            if (goodbyePatterns.test(userSpeech)) {
              const farewell =
                session.lang === "pt"
                  ? "Tá bom, tchau! Se precisar de algo, é só me chamar no Telegram."
                  : session.lang === "es"
                    ? "Bueno, adiós! Si necesitas algo, escríbeme en Telegram."
                    : "Alright, bye! If you need anything, just message me on Telegram.";

              ws.send(
                JSON.stringify({
                  type: "text",
                  token: farewell,
                  last: true,
                })
              );

              // End the call after a brief pause
              setTimeout(() => {
                ws.send(JSON.stringify({ type: "end" }));
              }, 3000);

              console.log(`[${session.callSid}] Call ending (goodbye detected)`);
              break;
            }

            // Get Claude's response
            const response = await callClaudeForPhone(userSpeech, session);

            console.log(`[${session.callSid}] Ona: "${response}"`);

            // Add to history
            session.history.push({ role: "assistant", content: response });

            // Send response to Twilio as a single text message
            // (ConversationRelay handles TTS)
            ws.send(
              JSON.stringify({
                type: "text",
                token: response,
                last: true,
              })
            );
            break;
          }

          case "interrupt": {
            // Caller interrupted TTS — log it
            const session = activeSessions.get(ws as any);
            console.log(
              `[${session?.callSid || "?"}] Interrupted after: "${data.utteranceUntilInterrupt?.substring(0, 50)}..."`
            );

            // Update the last assistant message to reflect what was actually heard
            if (session && session.history.length > 0) {
              const lastMsg = session.history[session.history.length - 1];
              if (
                lastMsg.role === "assistant" &&
                data.utteranceUntilInterrupt
              ) {
                lastMsg.content = data.utteranceUntilInterrupt;
              }
            }
            break;
          }

          case "dtmf": {
            console.log(`DTMF digit: ${data.digit}`);
            break;
          }

          case "error": {
            console.error(
              `ConversationRelay error: ${data.description}`
            );
            break;
          }

          default:
            console.log(`Unknown message type: ${data.type}`);
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    },

    close(ws, code, reason) {
      const session = activeSessions.get(ws as any);
      if (session) {
        const duration = Math.round(
          (Date.now() - session.startedAt.getTime()) / 1000
        );
        console.log(
          `Call ended: SID=${session.callSid}, duration=${duration}s, exchanges=${session.history.length}`
        );

        // Log conversation summary
        if (session.history.length > 0) {
          console.log("--- Call Transcript ---");
          for (const msg of session.history) {
            const speaker = msg.role === "user" ? (USER_NAME || "Caller") : "Ona";
            console.log(`  ${speaker}: ${msg.content}`);
          }
          console.log("--- End Transcript ---");
        }

        activeSessions.delete(ws as any);
      } else {
        console.log("WebSocket closed (no session)");
      }
    },
  },
});

// Log startup info
const ngrokUrl = await getNgrokUrl();
console.log(`Call Server running on port ${PORT}`);
if (ngrokUrl) {
  console.log(`ngrok URL detected: ${ngrokUrl}`);
  console.log(`WebSocket endpoint: ${ngrokUrl}/conversation`);
} else {
  console.log(
    "No ngrok URL detected. Start ngrok with: ngrok http " + PORT
  );
  console.log(
    "Then set NGROK_URL in .env, or leave it for auto-detection."
  );
}
console.log(`Health check: http://localhost:${PORT}/health`);
