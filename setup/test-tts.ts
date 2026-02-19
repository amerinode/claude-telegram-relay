/**
 * TTS Test
 *
 * Verifies that text-to-speech is configured correctly.
 * Tests ElevenLabs (primary) or Google Cloud (fallback).
 * Run: bun run test:tts
 */

import "dotenv/config";
import { synthesizeWithInfo, getTtsProvider, detectLanguage } from "../src/tts.ts";

async function testTts(): Promise<boolean> {
  const provider = getTtsProvider();

  if (!provider) {
    console.error("No TTS provider configured!");
    console.error("  Option 1: Set ELEVENLABS_API_KEY in .env (recommended — most natural voices)");
    console.error("            Get a free key at: elevenlabs.io → Profile → API Keys");
    console.error("  Option 2: Add Google Cloud credentials at config/google-tts-credentials.json");
    return false;
  }

  console.log(`Provider: ${provider === "elevenlabs" ? "ElevenLabs (most natural)" : "Google Cloud (fallback)"}`);

  if (provider === "elevenlabs") {
    console.log("API Key: set");
  }

  // Test language detection
  console.log("\nLanguage detection:");
  console.log(`  "Olá, tudo bem?" → ${detectLanguage("Olá, tudo bem?")}`);
  console.log(`  "Hello, how are you?" → ${detectLanguage("Hello, how are you?")}`);
  console.log(`  "Hola, ¿cómo estás?" → ${detectLanguage("Hola, ¿cómo estás?")}`);

  // Generate test audio in Portuguese (primary use case)
  console.log("\nGenerating test audio (Portuguese)...");
  try {
    const result = await synthesizeWithInfo("Oi Gil, tudo bem? Aqui é a Ona, sua assistente.");

    if (!result) {
      console.error("TTS returned no audio. Check your credentials.");
      return false;
    }

    console.log(`  Provider: ${result.provider}`);
    console.log(`  Format: ${result.format}`);
    console.log(`  File: ${result.filename}`);
    console.log(`  Size: ${(result.audio.length / 1024).toFixed(1)} KB`);

    // Verify audio format
    if (result.format === "mp3") {
      // MP3 files start with ID3 tag (49 44 33) or MPEG sync word (ff fb)
      const isMP3 =
        (result.audio[0] === 0x49 && result.audio[1] === 0x44 && result.audio[2] === 0x33) ||
        (result.audio[0] === 0xff && (result.audio[1] & 0xe0) === 0xe0);
      if (isMP3) {
        console.log("  Header: valid MP3 (Telegram compatible)");
      } else {
        console.error(`  Header: unexpected [${result.audio[0]?.toString(16)}, ${result.audio[1]?.toString(16)}]`);
        return false;
      }
    } else if (result.format === "ogg") {
      // OGG starts with "OggS" (4f 67 67 53)
      const isOGG = result.audio[0] === 0x4f && result.audio[1] === 0x67 && result.audio[2] === 0x67 && result.audio[3] === 0x53;
      if (isOGG) {
        console.log("  Header: valid OGG (Telegram compatible)");
      } else {
        console.error(`  Header: unexpected [${result.audio[0]?.toString(16)}, ${result.audio[1]?.toString(16)}]`);
        return false;
      }
    }

    return true;
  } catch (error: any) {
    console.error("TTS test failed:", error.message || error);
    return false;
  }
}

// ---- Main ----

console.log("=== TTS Test ===\n");

const passed = await testTts();

if (passed) {
  console.log("\n✅ TTS is ready. Voice replies will work on Telegram.");
} else {
  console.error("\n❌ TTS test failed. Fix the issues above.");
  process.exit(1);
}
