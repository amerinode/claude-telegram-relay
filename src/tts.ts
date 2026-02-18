/**
 * Text-to-Speech Module
 *
 * Converts text to OGG Opus audio via Google Cloud TTS.
 * Returns a Buffer suitable for Telegram's sendVoice (OGG+Opus).
 *
 * Supports English, Portuguese, and Spanish with automatic language routing.
 */

import { join, dirname } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const GOOGLE_CREDENTIALS_PATH =
  process.env.GOOGLE_TTS_CREDENTIALS ||
  join(PROJECT_ROOT, "config", "google-tts-credentials.json");

// Language → voice config mapping
const VOICE_CONFIG: Record<string, { languageCode: string; name: string }> = {
  en: { languageCode: "en-US", name: process.env.TTS_VOICE_EN || "en-US-Neural2-F" },
  pt: { languageCode: "pt-BR", name: process.env.TTS_VOICE_PT || "pt-BR-Neural2-A" },
  es: { languageCode: "es-US", name: process.env.TTS_VOICE_ES || "es-US-Neural2-A" },
};

const DEFAULT_LANG = "en";

/**
 * Detect language from text using simple heuristics.
 * Falls back to the provided hint or English.
 *
 * Note: In the voice pipeline, Whisper detects language more accurately.
 * This is a fallback for when no language hint is available.
 */
export function detectLanguage(text: string, hint?: string): string {
  if (hint && VOICE_CONFIG[hint]) return hint;

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

/**
 * Synthesize text to OGG Opus audio using Google Cloud TTS.
 * @param text - The text to speak
 * @param lang - Language hint: "en", "pt", or "es" (auto-detected if omitted)
 * Returns null on error or if credentials are missing.
 */
export async function synthesize(
  text: string,
  lang?: string
): Promise<Buffer | null> {
  if (!text.trim()) return null;

  const detectedLang = lang || detectLanguage(text);
  const voice = VOICE_CONFIG[detectedLang] || VOICE_CONFIG[DEFAULT_LANG];

  try {
    const { TextToSpeechClient } = await import(
      "@google-cloud/text-to-speech"
    );
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

    return Buffer.from(response.audioContent as Uint8Array);
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}
