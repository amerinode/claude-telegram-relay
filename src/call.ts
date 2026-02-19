/**
 * Phone Call Module (Twilio ConversationRelay)
 *
 * Makes outbound phone calls using Twilio's REST API.
 * Uses ConversationRelay for interactive two-way voice conversations.
 * The call-server.ts WebSocket server handles the AI conversation.
 *
 * Voice strategy:
 *   ConversationRelay → Google Chirp3-HD (warm, expressive, multilingual)
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

// Google Chirp3-HD voice for ConversationRelay
// Aoede = warm, expressive female voice (works across all languages)
// Format for ConversationRelay: "locale-Chirp3-HD-VoiceName"
const CHIRP_VOICE = "Aoede";

// Amazon Polly Neural voices for <Say> fallback (per language)
const POLLY_FALLBACK: Record<string, string> = {
  pt: "Polly.Camila-Neural",
  en: "Polly.Joanna-Neural",
  es: "Polly.Mia-Neural",
};

// Language codes for TwiML
const LANG_CODES: Record<string, string> = {
  pt: "pt-BR",
  en: "en-US",
  es: "es-MX",
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
    // Interactive call via ConversationRelay with Google Chirp3-HD
    const wsUrl = `${ngrokUrl}/conversation?reason=${encodeURIComponent(message)}&lang=${detectedLang}`;

    // Build a natural welcome greeting
    const greeting = buildGreeting(message, detectedLang);

    // Google Chirp3-HD voice: "locale-Chirp3-HD-VoiceName"
    const chirpVoiceId = `${langCode}-Chirp3-HD-${CHIRP_VOICE}`;

    twiml =
      `<Response>` +
      `<Connect>` +
      `<ConversationRelay ` +
      `url="${escapeXml(wsUrl)}" ` +
      `welcomeGreeting="${escapeXml(greeting)}" ` +
      `welcomeGreetingInterruptible="any" ` +
      `ttsProvider="Google" ` +
      `voice="${chirpVoiceId}" ` +
      `transcriptionLanguage="${langCode}" ` +
      `interruptible="any" ` +
      `interruptSensitivity="high" ` +
      `/>` +
      `</Connect>` +
      `</Response>`;

    console.log(`Initiating INTERACTIVE call to ${cleanNumber} (voice: ${chirpVoiceId}, ws: ${wsUrl.substring(0, 60)}...)`);
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
 * Build a natural welcome greeting from the call reason/message.
 * This is what the caller hears when they answer the phone.
 */
function buildGreeting(message: string, lang: string): string {
  const userName = process.env.USER_NAME || "";

  if (lang === "pt") {
    return userName
      ? `Oi ${userName}, aqui é a Ona. ${message}`
      : `Oi, aqui é a Ona. ${message}`;
  } else if (lang === "es") {
    return userName
      ? `Hola ${userName}, soy Ona. ${message}`
      : `Hola, soy Ona. ${message}`;
  } else {
    return userName
      ? `Hi ${userName}, this is Ona. ${message}`
      : `Hi, this is Ona. ${message}`;
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
