/**
 * Text-to-Speech Module
 *
 * Converts text to audio for Telegram voice messages.
 *
 * Provider strategy (in order of preference):
 *   1. ElevenLabs  — Most natural, human-like female voices (needs ELEVENLABS_API_KEY)
 *   2. Google Cloud — Neural2 voices, decent quality (needs google-tts-credentials.json)
 *
 * ElevenLabs outputs MP3 which Telegram accepts directly via sendVoice.
 * Google Cloud outputs OGG Opus natively.
 *
 * Supports English, Portuguese, and Spanish with automatic language routing.
 */

import { join, dirname } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// ELEVENLABS CONFIG (primary — most natural)
// ============================================================

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";

// Native female voices per language (Starter plan — community library access)
// Same voices used on phone calls for consistent Ona personality
const ELEVENLABS_VOICES: Record<string, { voiceId: string; langCode: string }> = {
  pt: { voiceId: process.env.TTS_VOICE_PT || "QJd9SLe6MVCdF6DR0EAu", langCode: "pt" },  // Amora Faria (soft, sweet, warm Brazilian female)
  en: { voiceId: process.env.TTS_VOICE_EN || "MnUw1cSnpiLoLhpd3Hqp", langCode: "en" },  // English female voice (selected by Gil)
  es: { voiceId: process.env.TTS_VOICE_ES || "86V9x9hrQds83qf7zaGn", langCode: "es" },  // Spanish female voice (selected by Gil)
};

// Model: Flash v2.5 — fastest, uses half the credits of multilingual_v2
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";

// ============================================================
// GOOGLE CLOUD CONFIG (fallback)
// ============================================================

const GOOGLE_CREDENTIALS_PATH =
  process.env.GOOGLE_TTS_CREDENTIALS ||
  join(PROJECT_ROOT, "config", "google-tts-credentials.json");

const GOOGLE_VOICES: Record<string, { languageCode: string; name: string }> = {
  en: { languageCode: "en-US", name: "en-US-Neural2-F" },
  pt: { languageCode: "pt-BR", name: "pt-BR-Neural2-A" },
  es: { languageCode: "es-US", name: "es-US-Neural2-A" },
};

const DEFAULT_LANG = "en";

// ============================================================
// LANGUAGE DETECTION
// ============================================================

/**
 * Detect language from text using simple heuristics.
 * Falls back to the provided hint or English.
 *
 * Note: In the voice pipeline, Whisper detects language more accurately.
 * This is a fallback for when no language hint is available.
 */
export function detectLanguage(text: string, hint?: string): string {
  if (hint && (ELEVENLABS_VOICES[hint] || GOOGLE_VOICES[hint])) return hint;

  const lower = text.toLowerCase();
  // Normalize to split words on any non-letter boundary
  const words = lower.split(/[^a-záàâãéèêíóòôõúüçñ]+/);

  let ptScore = 0;
  let esScore = 0;

  // Character-based signals
  if (/[ãõ]/.test(lower)) ptScore += 10;
  if (/ç/.test(lower)) ptScore += 3;
  if (/[ñ¿¡]/.test(lower)) esScore += 10;

  // Word sets
  const ptWords = new Set([
    "você", "não", "também", "obrigado", "obrigada", "então",
    "fazer", "preciso", "ainda", "isso", "estou", "tenho",
    "pode", "muito", "aqui", "olá",
  ]);
  const esWords = new Set([
    "usted", "también", "pero", "hola", "gracias", "necesito",
    "todavía", "bueno", "trabajo", "quiero", "estoy", "tengo",
    "puede", "mucho", "aquí",
  ]);

  for (const w of words) {
    if (ptWords.has(w)) ptScore += 2;
    if (esWords.has(w)) esScore += 2;
  }

  if (ptScore > 0 && ptScore > esScore) return "pt";
  if (esScore > 0 && esScore > ptScore) return "es";
  if (ptScore > 0 && ptScore === esScore) return "pt";

  return DEFAULT_LANG;
}

// ============================================================
// ELEVENLABS TTS (primary)
// ============================================================

/**
 * Synthesize text using ElevenLabs API.
 * Returns MP3 audio buffer (Telegram accepts MP3 via sendVoice).
 */
async function synthesizeElevenLabs(
  text: string,
  lang: string
): Promise<{ audio: Buffer; format: "mp3" } | null> {
  const voice = ELEVENLABS_VOICES[lang] || ELEVENLABS_VOICES[DEFAULT_LANG];

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL,
        language_code: voice.langCode,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,           // Flash v2.5 doesn't support style — set to 0
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error(`ElevenLabs TTS error (${response.status}):`, error.substring(0, 200));
    return null;
  }

  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength) {
    console.error("ElevenLabs returned empty audio");
    return null;
  }

  return { audio: Buffer.from(arrayBuffer), format: "mp3" };
}

// ============================================================
// GOOGLE CLOUD TTS (fallback)
// ============================================================

/**
 * Synthesize text using Google Cloud TTS.
 * Returns OGG Opus audio buffer.
 */
async function synthesizeGoogle(
  text: string,
  lang: string
): Promise<{ audio: Buffer; format: "ogg" } | null> {
  const voice = GOOGLE_VOICES[lang] || GOOGLE_VOICES[DEFAULT_LANG];

  const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
  const client = new TextToSpeechClient({
    keyFilename: GOOGLE_CREDENTIALS_PATH,
  });

  const [response] = await client.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: voice.languageCode,
      name: voice.name,
    },
    audioConfig: {
      audioEncoding: "OGG_OPUS" as any,
      sampleRateHertz: 48000,
    },
  });

  if (!response.audioContent) {
    console.error("Google TTS returned no audio content");
    return null;
  }

  return { audio: Buffer.from(response.audioContent as Uint8Array), format: "ogg" };
}

// ============================================================
// PUBLIC API
// ============================================================

/** Audio result with format info for the caller */
export interface TtsResult {
  audio: Buffer;
  format: "mp3" | "ogg";
  filename: string;
  provider: "elevenlabs" | "google";
}

/**
 * Check which TTS provider is available.
 */
export function getTtsProvider(): "elevenlabs" | "google" | null {
  if (ELEVENLABS_API_KEY) return "elevenlabs";
  // Check if Google credentials file likely exists (actual check happens on use)
  try {
    if (GOOGLE_CREDENTIALS_PATH) return "google";
  } catch {}
  return null;
}

/**
 * Synthesize text to audio.
 *
 * Tries ElevenLabs first (most natural), falls back to Google Cloud.
 * Returns audio buffer with format metadata, or null on failure.
 *
 * @param text - The text to speak
 * @param lang - Language hint: "en", "pt", or "es" (auto-detected if omitted)
 */
export async function synthesize(
  text: string,
  lang?: string
): Promise<Buffer | null> {
  const result = await synthesizeWithInfo(text, lang);
  return result?.audio || null;
}

/**
 * Synthesize text to audio with metadata (provider, format, filename).
 * Use this when you need to know the audio format for proper file extension.
 */
export async function synthesizeWithInfo(
  text: string,
  lang?: string
): Promise<TtsResult | null> {
  if (!text.trim()) return null;

  const detectedLang = lang || detectLanguage(text);

  // Try ElevenLabs first (most natural, human-like)
  if (ELEVENLABS_API_KEY) {
    try {
      const result = await synthesizeElevenLabs(text, detectedLang);
      if (result) {
        return {
          ...result,
          filename: "response.mp3",
          provider: "elevenlabs",
        };
      }
    } catch (error) {
      console.error("ElevenLabs TTS failed, trying Google fallback:", error);
    }
  }

  // Fallback to Google Cloud TTS
  try {
    const result = await synthesizeGoogle(text, detectedLang);
    if (result) {
      return {
        ...result,
        filename: "response.ogg",
        provider: "google",
      };
    }
  } catch (error) {
    console.error("Google TTS also failed:", error);
  }

  return null;
}
