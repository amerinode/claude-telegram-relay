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

import { readFile, writeFile, unlink } from "fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { detectLanguage } from "./tts.ts";
import { getNgrokUrl } from "./ngrok.ts";
import {
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
} from "./memory.ts";
import { handleMs365Request } from "./ms365.ts";
import {
  isHospitableConfigured,
  handleHospitableRequest,
  listMessages,
  getInquiryMessages,
  getReservation,
  sendMessage as sendHospitableMessage,
  formatWebhookMessage,
} from "./hospitable.ts";
import { needsSearch, searchWeb } from "./search.ts";

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
// TELEGRAM (for sending webhook notifications)
// ============================================================

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_USER_ID = process.env.TELEGRAM_USER_ID || "";

/**
 * Send a Telegram message with optional inline keyboard.
 * Uses raw fetch to avoid importing grammY in the call server.
 */
async function sendTelegram(
  text: string,
  replyMarkup?: any
): Promise<any> {
  if (!TG_TOKEN || !TG_USER_ID) return null;
  const body: any = {
    chat_id: TG_USER_ID,
    text,
    parse_mode: "HTML",
  };
  if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);

  const resp = await fetch(
    `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return resp.json();
}

// ============================================================
// HOSPITABLE WEBHOOK — Draft storage for auto-reply approval
// ============================================================

interface DraftReply {
  reservationId: string;
  draft: string;
  guestName: string;
  propertyName: string;
  guestMessage: string;
  createdAt: number;
}

// Map of reservation UUID → draft reply (cleared after 1 hour)
export const pendingDrafts = new Map<string, DraftReply>();

// Clean up old drafts every 10 minutes
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, draft] of pendingDrafts) {
    if (draft.createdAt < oneHourAgo) pendingDrafts.delete(key);
  }
}, 10 * 60 * 1000);

/**
 * Handle incoming guest message from Hospitable webhook.
 * 1. Parse the webhook payload
 * 2. Fetch reservation context
 * 3. Generate a draft reply via Claude
 * 4. Send to Telegram with inline buttons
 */
async function handleGuestWebhook(payload: any): Promise<void> {
  const info = formatWebhookMessage(payload);
  if (!info || !info.messageBody || !info.conversationId) {
    console.log("Hospitable webhook: no message body or conversation ID, skipping");
    return;
  }

  // Skip messages sent by the host (only notify on guest messages)
  if (info.senderType === "host") {
    console.log("Hospitable webhook: host message, skipping notification");
    return;
  }

  const isInquiry = !info.reservationId && !!info.inquiryId;
  console.log(
    `Hospitable webhook: ${info.guestName} @ ${info.propertyName} (${isInquiry ? "inquiry" : "reservation"}): "${info.messageBody.substring(0, 60)}..."`
  );

  // Fetch recent conversation history for context
  let conversationContext = "";
  try {
    const messages = isInquiry
      ? await getInquiryMessages(info.inquiryId)
      : await listMessages(info.reservationId, 5);
    if (messages.length) {
      const recentMsgs = isInquiry ? messages.slice(-5) : messages;
      conversationContext = (isInquiry ? recentMsgs : recentMsgs.reverse())
        .map((m: any) => {
          const name = (m.senderType || m.sender) === "host" ? "You" : info.guestName;
          return `${name}: ${m.body}`;
        })
        .join("\n");
    }
  } catch (e: any) {
    console.error(`Hospitable: failed to fetch message history: ${e.message}`);
  }

  // Generate draft reply via Claude CLI
  let draftReply = "";
  try {
    const draftPrompt = [
      `You are Ona, a warm and professional Airbnb host assistant.`,
      `Draft a brief, friendly reply to a guest message.`,
      ``,
      `Property: ${info.propertyName}`,
      `Guest: ${info.guestName}`,
      `Check-in: ${info.arrivalDate} → Check-out: ${info.departureDate}`,
      `Platform: ${info.platform}`,
      conversationContext ? `\nRecent conversation:\n${conversationContext}` : "",
      ``,
      `Guest's latest message: "${info.messageBody}"`,
      ``,
      `Write a concise, helpful reply (2-4 sentences max). Be warm but professional.`,
      `Do NOT include greetings like "Dear" or sign-offs like "Best regards".`,
      `Start with "Hi ${info.guestName}!" and get straight to the point.`,
      `If you don't have specific info (like door codes, WiFi), say you'll send it closer to check-in.`,
      `Reply ONLY with the message text, nothing else.`,
    ]
      .filter(Boolean)
      .join("\n");

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const draftPromptFile = join(tmpdir(), `draft_prompt_${Date.now()}.txt`);
    await writeFile(draftPromptFile, draftPrompt);

    const draftOutput = await new Promise<string>((res) => {
      const child = nodeSpawn(CLAUDE_PATH, ["--no-session-persistence", "--output-format", "text"], {
        cwd: PROJECT_DIR || PROJECT_ROOT,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      let out = "";
      child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      const timer = setTimeout(() => { child.kill("SIGTERM"); unlink(draftPromptFile).catch(() => {}); res(""); }, 30000);
      const fs = require("fs");
      fs.createReadStream(draftPromptFile).pipe(child.stdin!);
      child.on("close", () => { clearTimeout(timer); unlink(draftPromptFile).catch(() => {}); res(out.trim()); });
      child.on("error", () => { clearTimeout(timer); unlink(draftPromptFile).catch(() => {}); res(""); });
    });

    draftReply = draftOutput;
    if (!draftReply) draftReply = `Hi ${info.guestName}! Thanks for your message. I'll get back to you shortly.`;
  } catch (e: any) {
    console.error(`Hospitable: draft generation failed: ${e.message}`);
    draftReply = `Hi ${info.guestName}! Thanks for your message. I'll get back to you shortly.`;
  }

  // Store draft for approval (keyed by conversationId which works for both reservations and inquiries)
  pendingDrafts.set(info.conversationId, {
    reservationId: info.conversationId,
    draft: draftReply,
    guestName: info.guestName,
    propertyName: info.propertyName,
    guestMessage: info.messageBody,
    createdAt: Date.now(),
  });

  // Format Telegram notification with inline buttons
  const dateRange =
    info.arrivalDate && info.departureDate
      ? ` (${info.arrivalDate} → ${info.departureDate})`
      : "";

  const typeLabel = isInquiry ? "inquiry" : "reservation";
  const telegramText =
    `📩 <b>New ${typeLabel} message from ${escapeHtml(info.guestName)}</b>\n` +
    `🏠 ${escapeHtml(info.propertyName)}${dateRange}\n\n` +
    `<i>"${escapeHtml(info.messageBody)}"</i>\n\n` +
    `💬 <b>Suggested reply:</b>\n` +
    `${escapeHtml(draftReply)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Send", callback_data: `hospitable_send:${info.conversationId}` },
        { text: "✏️ Edit", callback_data: `hospitable_edit:${info.conversationId}` },
        { text: "❌ Skip", callback_data: `hospitable_skip:${info.conversationId}` },
      ],
    ],
  };

  await sendTelegram(telegramText, keyboard);
  console.log(`Hospitable: sent draft to Telegram for approval (reservation: ${info.reservationId})`);
}

/**
 * Handle new/changed reservation from Hospitable webhook.
 * Sends a Telegram notification with reservation details.
 */
async function handleReservationWebhook(payload: any, isNew: boolean): Promise<void> {
  const data = payload.data || payload;

  const guestName = data.guest?.first_name || data.guest_name || data.guest?.name || "Guest";
  const propertyName = data.properties?.[0]?.name || data.property_name || data.property?.name || "Property";
  const platform = data.platform || "airbnb";
  const status = data.reservation_status?.current?.category || data.status || "";
  const arrivalDate = (data.arrival_date || "").split("T")[0];
  const departureDate = (data.departure_date || "").split("T")[0];
  const nights = data.nights || "";
  const guestCount = data.guests?.total || "";
  const code = data.code || "";

  // Financial info (if included)
  const fin = data.financials;
  const hostRevenue = fin?.host?.revenue?.formatted || "";
  const guestTotal = fin?.guest?.total_price?.formatted || "";

  const emoji = isNew ? "🎉" : "🔄";
  const action = isNew ? "New reservation" : "Reservation updated";

  let text =
    `${emoji} <b>${action}!</b>\n` +
    `🏠 ${escapeHtml(propertyName)}\n` +
    `👤 ${escapeHtml(guestName)}` +
    (guestCount ? ` (${guestCount} guests)` : "") + `\n` +
    `📅 ${arrivalDate} → ${departureDate}` +
    (nights ? ` (${nights} nights)` : "") + `\n` +
    `📋 ${platform} · ${status}`;

  if (code) text += ` · ${code}`;
  if (hostRevenue) text += `\n💰 Payout: ${hostRevenue}`;
  else if (guestTotal) text += `\n💰 Guest total: ${guestTotal}`;

  console.log(`Hospitable webhook: ${action} — ${guestName} @ ${propertyName} (${arrivalDate} → ${departureDate})`);
  await sendTelegram(text);
}

/**
 * Handle new review from Hospitable webhook.
 * Sends a Telegram notification with review content.
 */
async function handleReviewWebhook(payload: any): Promise<void> {
  const data = payload.data || payload;

  const guestName = data.guest?.first_name || data.guest_name || data.reviewer_name || data.reviewer || "Guest";
  const propertyName = data.properties?.[0]?.name || data.property_name || data.property?.name || data.listing_name || "Property";
  const platform = data.platform || "airbnb";
  const rating = data.rating || data.overall_rating || data.stars || "";
  const publicReview = data.public_review || data.review_text || data.body || data.content || "";
  const privateNote = data.private_feedback || data.private_review || data.private_note || "";
  const categories = data.category_ratings || data.categories || null;

  let text =
    `⭐ <b>New review!</b>\n` +
    `🏠 ${escapeHtml(propertyName)}\n` +
    `👤 ${escapeHtml(guestName)} (${platform})`;

  if (rating) text += `\n⭐ Rating: ${rating}/5`;

  if (categories && typeof categories === "object") {
    const cats = Object.entries(categories)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (cats) text += `\n📊 ${cats}`;
  }

  if (publicReview) {
    const preview = publicReview.length > 300 ? publicReview.substring(0, 300) + "..." : publicReview;
    text += `\n\n💬 <i>"${escapeHtml(preview)}"</i>`;
  }

  if (privateNote) {
    const preview = privateNote.length > 200 ? privateNote.substring(0, 200) + "..." : privateNote;
    text += `\n\n🔒 <b>Private note:</b> <i>"${escapeHtml(preview)}"</i>`;
  }

  console.log(`Hospitable webhook: New review from ${guestName} @ ${propertyName}`);
  await sendTelegram(text);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
    /\b(next|upcoming|today'?s?|this week'?s?|tomorrow'?s?)\b.{0,20}\b(meetings?|events?|appointments?|calls?|calendar|schedule)\b/i,
    /\b(meetings?|events?|appointments?)\b.{0,20}\b(today|this week|tomorrow|scheduled)\b/i,
    /\b(calend[aá]rios?|agendas?|reuni[aãõ]o|reuni[oõ]es|eventos?)\b.{0,20}(hoje|amanh[aã]|semana|próxim|agendar|criar|adicionar|cancelar)/i,
    /\b(agendar|marcar|criar|adicionar)\b.{0,30}\b(reuni|almoço|jantar|chamada|evento)\b/i,
    // Portuguese: "o que tem no meu calendário" / "meu calendário para amanhã"
    /\b(meu|minha)\s+(calend[aá]rio|agenda|compromissos?)\b/i,
    /\b(calend[aá]rio|agenda|compromissos?)\s+(para|pra|de)\s+(amanh[aã]|hoje|semana)/i,
    /\b(o que|que).{0,15}(calend[aá]rio|agenda|compromissos?)\b/i,
    /amanh[aã].{0,20}\b(calend[aá]rio|agenda|reuni|compromisso|evento)\b/i,
    /\b(what'?s|what is).{0,15}(on )?(my )?(calendar|schedule|agenda).{0,15}(tomorrow|today)\b/i,
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
// HOSPITABLE DETECTION (same patterns as relay.ts)
// ============================================================

function needsHospitable(message: string): boolean {
  if (process.env.HOSPITABLE_ENABLED !== "true") return false;

  const hospitablePatterns = [
    /\b(reservat|booking|bookings|reserva[sç])\b/i,
    /\b(guests?|hóspede|hóspedes|check.?in|check.?out|arrivals?|departures?)\b/i,
    /\b(propert|listings?|my (apartment|house|villa|cabin|unit|place|rental))/i,
    /\b(imóve[ils]|propriedad)/i,
    /\b(airbnb|vrbo|booking\.com|hospitable)\b/i,
    /\b(guest.?messag|write.?to.?guest|reply.?to.?guest|contact.?guest|message.?guest)\b/i,
    /\b(mensagem.{0,10}hóspede|responder.{0,10}hóspede)\b/i,
    /\b(hospitable.?inbox|inbox.?messages?|latest.?messages)\b/i,
    /\b(caixa.?de.?entrada|mensagens?.?(recentes|novas|últimas))\b/i,
    /\b(occupancy|availability|calendar.{0,10}(rental|property|listing)|vacant|blocked)\b/i,
    /\b(ocupação|disponibilidade)\b/i,
    /\b(reviews?|ratings?|avaliaç)/i,
    /\b(stays?|night.?stay|upcoming.?stay)\b/i,
    /\b(rental|short.?term|vacation.?rental|aluguel)\b/i,
    /\b(earn|revenue|payout|transaction|financ|income|billing)\b/i,
    /\b(fatur|ganhos?|receita|quanto.?(fiz|ganhei|faturei|recebi))\b/i,
    /\b(how.?much.?(did|have|earn|made?))\b/i,
    /\b(soma|sum|total).{0,15}(reserv|booking|month|mês|mes)/i,
    /\b(relatório|report).{0,15}(financ|reserv|booking|mensal|monthly)/i,
  ];

  return hospitablePatterns.some(p => p.test(message));
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
  pendingBuffer: string[];      // buffer for rapid successive utterances
  debounceTimer: any;           // timer for debounce
  processing: boolean;          // lock to prevent concurrent Claude calls
  pendingTelegramMessages: string[];  // queued messages to send via Telegram
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

  // Check if this question needs Hospitable data (vacation rentals)
  // Truncate for phone calls — spoken responses can't use full inbox data
  let hospitableContext = "";
  if (needsHospitable(userSpeech)) {
    console.log(`[${session.callSid}] Hospitable request detected, fetching...`);
    try {
      hospitableContext = await handleHospitableRequest(userSpeech, recentHistory || "");
      if (hospitableContext.length > 3000) {
        hospitableContext = hospitableContext.substring(0, 3000) + "\n... (truncated for phone call — summarize what's above)";
      }
      console.log(`[${session.callSid}] Hospitable context (${hospitableContext.length} chars): ${hospitableContext.substring(0, 80)}...`);
    } catch (error: any) {
      console.error(`[${session.callSid}] Hospitable error: ${error.message}`);
    }
  }

  // Check if this question needs web search
  let searchContext = "";
  if (needsSearch(userSpeech)) {
    console.log(`[${session.callSid}] Web search detected, querying Brave...`);
    try {
      searchContext = await searchWeb(userSpeech, 3); // Fewer results for phone calls
      if (searchContext) console.log(`[${session.callSid}] Search context (${searchContext.length} chars): ${searchContext.substring(0, 80)}...`);
    } catch (error: any) {
      console.error(`[${session.callSid}] Search error: ${error.message}`);
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
    `- LANGUAGE: Respond in ${session.lang === "pt" ? "PORTUGUESE" : session.lang === "es" ? "SPANISH" : "ENGLISH"}. This is based on the caller's current language. Only switch if the caller explicitly speaks a different language.`,
    "- When sharing email or calendar info, summarize it conversationally — don't list raw data.",
    "- For search results, give a brief spoken answer — no URLs or links.",
    "- If you don't know something, be light about it — keep it in the current language.",
    "",
    "TELEGRAM FOLLOW-UP:",
    "- When the caller asks you to send them something on Telegram (a summary, link, details, etc.),",
    "  include this tag in your response: [SEND_TELEGRAM: message text here]",
    "- The tag is processed automatically — the message is sent immediately to their Telegram.",
    "- Confirm it verbally: 'Done, I just sent that to your Telegram' or 'Pronto, mandei no Telegram'.",
    "- You can include multiple tags if needed.",
    "- The message text supports HTML formatting (bold, italic, links).",
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

  // Add Hospitable data (vacation rentals)
  if (hospitableContext) {
    promptParts.push(`\nHOSPITABLE DATA (Vacation Rentals):\n${hospitableContext}`);
    promptParts.push(
      "Summarize rental and guest info conversationally for speech. " +
      "Don't read out UUIDs, raw dates, or full message threads. " +
      "Give a brief spoken summary: who messaged, what they want, what property, key dates."
    );
  }

  // Add web search results
  if (searchContext) {
    promptParts.push(`\n${searchContext}`);
    promptParts.push(
      "Use the search results to give a brief spoken answer. " +
      "Don't read out URLs or list numbered results — just answer naturally."
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

    // Build CLI args WITHOUT prompt (piped via stdin to avoid Windows arg length limit)
    const claudeArgs = [
      "--no-session-persistence",
      "--output-format",
      "text",
      "--allowedTools",
      "WebFetch",
    ];

    // Write prompt to temp file, then pipe via stdin (same pattern as relay.ts)
    const promptFile = join(tmpdir(), `call_prompt_${Date.now()}.txt`);
    await writeFile(promptFile, systemPrompt);

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

      // 90-second timeout for phone calls (extra time for Hospitable + search + MS365 gathering)
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        unlink(promptFile).catch(() => {});
        safeResolve(
          session.lang === "pt"
            ? "Desculpa, demorei demais. Pode tentar de novo?"
            : "Sorry, that took too long. Can you try again?"
        );
      }, 90_000);

      // Pipe the prompt file to stdin
      const fs = require("fs");
      const readStream = fs.createReadStream(promptFile);
      readStream.pipe(child.stdin!);

      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});

        if (code !== 0) {
          console.error(`Claude CLI error (exit ${code}): ${stderr.substring(0, 200)}`);
          safeResolve(
            session.lang === "pt"
              ? "Desculpa, tive um problema. Pode repetir?"
              : "Sorry, I had a problem. Could you repeat that?"
          );
          return;
        }

        // Clean up: remove any markdown artifacts Claude might add
        const cleaned = output
          .trim()
          .replace(/\*\*/g, "")
          .replace(/\*/g, "")
          .replace(/^#+\s*/gm, "")
          .replace(/^- /gm, "")
          .replace(/`/g, "")
          .replace(/\[.*?\]\(.*?\)/g, "");

        safeResolve(cleaned || "Hmm, I didn't get a response. Could you try again?");
      });

      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        console.error("Spawn error:", err);
        safeResolve(
          session.lang === "pt"
            ? "Desculpa, tive um problema. Pode repetir?"
            : "Sorry, I had a problem. Could you repeat that?"
        );
      });
    });
  } catch (error: any) {
    console.error("Claude phone error:", error?.message || error);
    return session.lang === "pt"
      ? "Desculpa, demorei demais. Pode tentar de novo?"
      : "Sorry, that took too long. Can you try again?";
  }
}

// ============================================================
// TELEGRAM TAG PROCESSING (for phone call follow-ups)
// ============================================================

/**
 * Process [SEND_TELEGRAM: message] tags in Claude's response.
 * Sends the message to Telegram immediately and strips the tag from the spoken response.
 */
async function processTelegramTags(response: string, session: CallSession): Promise<string> {
  let clean = response;

  for (const match of response.matchAll(/\[SEND_TELEGRAM:\s*([\s\S]+?)\]/gi)) {
    const messageText = match[1].trim();
    if (messageText) {
      try {
        await sendTelegram(`📞 <b>From your phone call:</b>\n\n${messageText}`);
        console.log(`[${session.callSid}] Sent Telegram message: "${messageText.substring(0, 60)}..."`);
        session.pendingTelegramMessages.push(messageText);
      } catch (error: any) {
        console.error(`[${session.callSid}] Failed to send Telegram: ${error.message}`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  // Also handle multiline variant: [SEND_TELEGRAM]...[/SEND_TELEGRAM]
  for (const match of response.matchAll(/\[SEND_TELEGRAM\]\s*([\s\S]*?)\s*\[\/SEND_TELEGRAM\]/gi)) {
    const messageText = match[1].trim();
    if (messageText) {
      try {
        await sendTelegram(`📞 <b>From your phone call:</b>\n\n${messageText}`);
        console.log(`[${session.callSid}] Sent Telegram message (block): "${messageText.substring(0, 60)}..."`);
        session.pendingTelegramMessages.push(messageText);
      } catch (error: any) {
        console.error(`[${session.callSid}] Failed to send Telegram: ${error.message}`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
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

    // Hospitable webhook — receives guest messages, reservations, reviews from Hospitable
    if (url.pathname === "/hospitable-webhook" && req.method === "POST") {
      try {
        const payload = await req.json();
        const eventType = payload.event || payload.type || "";
        console.log(`Hospitable webhook received: ${eventType}`);

        // Process in background — don't block the webhook response
        if (eventType === "message.created") {
          handleGuestWebhook(payload).catch((e) =>
            console.error(`Hospitable webhook handler error: ${e.message}`)
          );
        } else if (eventType === "reservation.created") {
          handleReservationWebhook(payload, true).catch((e) =>
            console.error(`Hospitable reservation webhook error: ${e.message}`)
          );
        } else if (eventType === "reservation.changed") {
          handleReservationWebhook(payload, false).catch((e) =>
            console.error(`Hospitable reservation webhook error: ${e.message}`)
          );
        } else if (eventType === "review.created") {
          handleReviewWebhook(payload).catch((e) =>
            console.error(`Hospitable review webhook error: ${e.message}`)
          );
        } else {
          console.log(`Hospitable webhook: unhandled event type "${eventType}"`);
        }

        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e: any) {
        console.error(`Hospitable webhook parse error: ${e.message}`);
        return new Response("Bad request", { status: 400 });
      }
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          activeCalls: activeSessions.size,
          hospitable: isHospitableConfigured(),
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
              pendingBuffer: [],
              debounceTimer: null,
              processing: false,
              pendingTelegramMessages: [],
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

            // Detect language from speech and update session
            const detectedLang = detectLanguage(userSpeech);
            session.lang = detectedLang;

            console.log(
              `[${session.callSid}] ${USER_NAME || "Caller"}: "${userSpeech}"`
            );

            // Check for goodbye signals immediately (no debounce)
            const goodbyePatterns =
              /\b(tchau|bye|goodbye|adeus|até logo|até mais|encerr|deslig|hang up|that'?s all|that is all)\b/i;
            if (goodbyePatterns.test(userSpeech)) {
              session.history.push({ role: "user", content: userSpeech });
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

              setTimeout(() => {
                ws.send(JSON.stringify({ type: "end" }));
              }, 3000);

              console.log(`[${session.callSid}] Call ending (goodbye detected)`);
              break;
            }

            // Skip pure greetings entirely — the welcomeGreeting already said hi,
            // so we just absorb the greeting and wait for the real question
            const greetingOnly = /^(hi|hey|hello|oi|olá|ola|hola|yo|bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)[\s,!.]*(\w+)?[.,!?\s]*$/i;
            if (session.history.length === 0 && greetingOnly.test(userSpeech.trim())) {
              console.log(`[${session.callSid}] Greeting absorbed, waiting for real question: "${userSpeech}"`);
              break;
            }

            // Buffer rapid utterances and debounce (700ms) to avoid duplicate responses
            session.pendingBuffer.push(userSpeech);
            if (session.debounceTimer) clearTimeout(session.debounceTimer);

            session.debounceTimer = setTimeout(async () => {
              try {
                // If already processing a Claude call, wait for it to finish
                if (session.processing) return;
                session.processing = true;

                // Combine buffered utterances into one message
                const combined = session.pendingBuffer.join(" ").trim();
                session.pendingBuffer = [];

                if (!combined) {
                  session.processing = false;
                  return;
                }

                session.history.push({ role: "user", content: combined });

                // If we're about to fetch external data, tell the caller to hold on
                const willFetchData = needsMs365(combined) || needsHospitable(combined) || needsSearch(combined);
                if (willFetchData) {
                  const holdMsg = session.lang === "pt"
                    ? "Espera um pouquinho, vou buscar essa informação pra você."
                    : session.lang === "es"
                      ? "Dame un momento, voy a buscar esa información."
                      : "Hold on, let me grab that info for you.";
                  ws.send(JSON.stringify({ type: "text", token: holdMsg, last: true }));
                }

                let response = await callClaudeForPhone(combined, session);

                // Process [SEND_TELEGRAM: ...] tags — send immediately and strip from spoken response
                response = await processTelegramTags(response, session);

                console.log(`[${session.callSid}] Ona: "${response}"`);
                session.history.push({ role: "assistant", content: response });

                ws.send(
                  JSON.stringify({
                    type: "text",
                    token: response,
                    last: true,
                  })
                );

                session.processing = false;

                // If more utterances arrived while processing, handle them
                if (session.pendingBuffer.length > 0) {
                  const remaining = session.pendingBuffer.join(" ").trim();
                  session.pendingBuffer = [];
                  if (remaining) {
                    session.processing = true;
                    session.history.push({ role: "user", content: remaining });
                    let followUp = await callClaudeForPhone(remaining, session);
                    followUp = await processTelegramTags(followUp, session);
                    console.log(`[${session.callSid}] Ona: "${followUp}"`);
                    session.history.push({ role: "assistant", content: followUp });
                    ws.send(JSON.stringify({ type: "text", token: followUp, last: true }));
                    session.processing = false;
                  }
                }
              } catch (error: any) {
                console.error(`[${session.callSid}] Debounce handler error: ${error.message}`);
                session.processing = false;
                try {
                  const errMsg = session.lang === "pt"
                    ? "Desculpa, tive um problema. Pode repetir?"
                    : "Sorry, I had a problem. Could you repeat that?";
                  ws.send(JSON.stringify({ type: "text", token: errMsg, last: true }));
                } catch {}
              }
            }, 700);

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
        const minutes = Math.floor(duration / 60);
        const seconds = duration % 60;
        const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

        console.log(
          `Call ended: SID=${session.callSid}, duration=${durationStr}, exchanges=${session.history.length}`
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

        // Send call summary to Telegram (non-blocking)
        if (session.history.length > 0) {
          const exchanges = Math.floor(session.history.length / 2);
          const topics = session.history
            .filter((m) => m.role === "user")
            .map((m) => m.content.substring(0, 80))
            .slice(0, 5);

          let summary = `📞 <b>Call ended</b> (${durationStr}, ${exchanges} exchanges)\n\n`;
          summary += `<b>Topics discussed:</b>\n`;
          summary += topics.map((t) => `• ${escapeHtml(t)}`).join("\n");

          if (session.pendingTelegramMessages.length > 0) {
            summary += `\n\n📨 ${session.pendingTelegramMessages.length} message(s) sent to Telegram during the call.`;
          }

          sendTelegram(summary).catch((e) =>
            console.error(`Failed to send call summary: ${e.message}`)
          );
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
  if (isHospitableConfigured()) {
    console.log(`Hospitable webhook URL: ${ngrokUrl.replace("wss://", "https://")}/hospitable-webhook`);
  }
} else {
  console.log(
    "No ngrok URL detected. Start ngrok with: ngrok http " + PORT
  );
  console.log(
    "Then set NGROK_URL in .env, or leave it for auto-detection."
  );
}
console.log(`Health check: http://localhost:${PORT}/health`);
