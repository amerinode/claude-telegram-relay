/**
 * Phone Call Module (Twilio ConversationRelay)
 *
 * Makes outbound phone calls using Twilio's REST API.
 * Uses ConversationRelay for interactive two-way voice conversations.
 * The call-server.ts WebSocket server handles the AI conversation.
 *
 * Voice strategy:
 *   ConversationRelay → ElevenLabs (most natural, human-like — Twilio default)
 *   Fallback <Say>    → Amazon Polly Neural (reliable, always works)
 */

import twilio from "twilio";
import { detectLanguage } from "./tts.ts";
import { getNgrokUrl } from "./ngrok.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || "";

// ElevenLabs FEMALE premade voices for ConversationRelay
// Premade voices are official ElevenLabs voices available on all tiers including Twilio
// Community voices (Amora Faria etc.) only work via direct API (Telegram), not via Twilio
const ELEVENLABS_VOICES: Record<string, string> = {
  pt: "EXAVITQu4vr4xnSDxMaL",  // Sarah (soft, warm, natural female — premade, Gil's pick)
  en: "21m00Tcm4TlvDq8ikWAM",  // Rachel (young, calm American female — premade)
  es: "EXAVITQu4vr4xnSDxMaL",  // Sarah (soft, warm, natural female — premade, Gil's pick)
};

// Amazon Polly Neural voices for <Say> fallback (per language)
const POLLY_FALLBACK: Record<string, string> = {
  pt: "Polly.Camila-Neural",
  en: "Polly.Joanna-Neural",
  es: "Polly.Mia-Neural",
};

// Language codes for TwiML (must be supported by Twilio ConversationRelay + ElevenLabs)
// Supported: bg-BG, cs-CZ, da-DK, de-DE, en-AU, en-GB, en-IN, en-US, es-ES, es-US,
//            fi-FI, fr-CA, fr-FR, hi-IN, hu-HU, id-ID, it-IT, ja-JP, ko-KR, nl-BE,
//            nl-NL, pl-PL, pt-BR, pt-PT, ro-RO, ru-RU, sv-SE, ta-IN, tr-TR, uk-UA, vi-VN
// NOTE: es-MX is NOT supported — use es-US instead
const LANG_CODES: Record<string, string> = {
  pt: "pt-BR",
  en: "en-US",
  es: "es-US",
};

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Check if Twilio calling is configured.
 */
export function isCallConfigured(): boolean {
  return !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
}

/**
 * Make an outbound phone call via Twilio.
 *
 * If the call-server WebSocket is available (ngrok running), uses
 * ConversationRelay with Google Chirp3-HD voice for warm, natural conversation.
 * Otherwise, falls back to a one-way <Say> call with Amazon Polly.
 *
 * @param to      - Phone number to call (E.164 format, e.g. +15551234567)
 * @param message - Text to speak as greeting / call reason
 * @param lang    - Language hint ("pt", "en", "es") — auto-detected if omitted
 * @returns       - Twilio Call SID (for tracking)
 */
export async function makeCall(
  to: string,
  message: string,
  lang?: string
): Promise<string> {
  if (!isCallConfigured()) {
    throw new Error(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in .env"
    );
  }

  // Clean phone number — ensure E.164 format
  const cleanNumber = to.replace(/[^\d+]/g, "");
  if (!cleanNumber.startsWith("+")) {
    throw new Error(`Phone number must be in E.164 format (e.g., +15551234567). Got: ${to}`);
  }

  // Detect language for voice selection
  const detectedLang = lang || detectLanguage(message);
  const langCode = LANG_CODES[detectedLang] || LANG_CODES.en;

  // Try ConversationRelay (interactive two-way call)
  const ngrokUrl = await getNgrokUrl();

  let twiml: string;

  if (ngrokUrl) {
    // Interactive call via ConversationRelay with ElevenLabs (most natural)
    const wsUrl = `${ngrokUrl}/conversation?reason=${encodeURIComponent(message)}&lang=${detectedLang}`;

    // Build a natural welcome greeting
    const greeting = buildGreeting(message, detectedLang);

    // ElevenLabs voice ID per language (Twilio built-in, no API key needed)
    const voiceId = ELEVENLABS_VOICES[detectedLang] || ELEVENLABS_VOICES.en;

    twiml =
      `<Response>` +
      `<Connect>` +
      `<ConversationRelay ` +
      `url="${escapeXml(wsUrl)}" ` +
      `welcomeGreeting="${escapeXml(greeting)}" ` +
      `welcomeGreetingInterruptible="any" ` +
      `ttsProvider="ElevenLabs" ` +
      `voice="${voiceId}" ` +
      `language="${langCode}" ` +
      `interruptible="any" ` +
      `interruptSensitivity="high" ` +
      `/>` +
      `</Connect>` +
      `</Response>`;

    console.log(`Initiating INTERACTIVE call to ${cleanNumber} (voice: ElevenLabs/${voiceId}, lang: ${langCode}, ws: ${wsUrl.substring(0, 60)}...)`);
  } else {
    // Fallback: one-way call with <Say> using Amazon Polly Neural
    const pollyVoice = POLLY_FALLBACK[detectedLang] || POLLY_FALLBACK.en;
    console.log("No ngrok URL — falling back to one-way <Say> call");
    twiml =
      `<Response>` +
      `<Say voice="${pollyVoice}" language="${langCode}">${escapeXml(message)}</Say>` +
      `<Pause length="1"/>` +
      `<Say voice="${pollyVoice}" language="${langCode}">${detectedLang === "pt" ? "Tchau!" : detectedLang === "es" ? "Adiós!" : "Bye!"}</Say>` +
      `</Response>`;

    console.log(`Initiating ONE-WAY call to ${cleanNumber} (voice: ${pollyVoice})`);
  }

  const client = twilio(TWILIO_SID, TWILIO_TOKEN);

  const call = await client.calls.create({
    twiml,
    to: cleanNumber,
    from: TWILIO_FROM,
  });

  console.log(`Call initiated: SID=${call.sid}, status=${call.status}`);
  return call.sid;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Build a brief welcome greeting.
 * Keep it short — just a quick "hi" so the person knows someone's there.
 * The real conversation starts after they respond.
 */
function buildGreeting(_message: string, lang: string): string {
  const userName = process.env.USER_NAME || "";

  if (lang === "pt") {
    return userName ? `Oi ${userName}!` : `Oi!`;
  } else if (lang === "es") {
    return userName ? `Hola ${userName}!` : `Hola!`;
  } else {
    return userName ? `Hi ${userName}!` : `Hi!`;
  }
}

/**
 * Escape special XML characters for safe embedding in TwiML.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
