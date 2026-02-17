/**
 * TTS Test
 *
 * Verifies that Groq TTS is configured correctly.
 * Run: bun run test:tts
 */

import "dotenv/config";

async function testTts(): Promise<boolean> {
  // Check GROQ_API_KEY
  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is not set in .env");
    return false;
  }
  console.log("GROQ_API_KEY: set");

  // Check ffmpeg (required for WAV → OGG Opus conversion)
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    console.log("ffmpeg: installed");
  } catch {
    console.error(
      "ffmpeg: NOT FOUND — install with: brew install ffmpeg (macOS), apt install ffmpeg (Linux), or winget install ffmpeg (Windows)"
    );
    return false;
  }

  // Generate a test audio clip
  console.log("\nGenerating test audio...");
  try {
    const { synthesize } = await import("../src/tts.ts");
    const audio = await synthesize("Hello, this is a TTS test.");

    if (!audio) {
      console.error("TTS returned no audio. Check GROQ_API_KEY and model availability.");
      return false;
    }

    console.log(`Audio generated: ${(audio.length / 1024).toFixed(1)} KB`);

    // Verify it starts with OGG magic bytes (OggS)
    if (audio[0] === 0x4f && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53) {
      console.log("Format: valid OGG container (Telegram compatible)");
    } else {
      console.error(
        `Format: unexpected header [${audio[0]?.toString(16)}, ${audio[1]?.toString(16)}, ${audio[2]?.toString(16)}, ${audio[3]?.toString(16)}] — expected OGG (4f 67 67 53)`
      );
      return false;
    }

    return true;
  } catch (error: any) {
    console.error("TTS test failed:", error.message || error);
    return false;
  }
}

// ---- Main ----

console.log("TTS Test\n");

const voice = process.env.TTS_VOICE || "hannah";
const model = process.env.TTS_MODEL || "canopylabs/orpheus-v1-english";
console.log(`Model: ${model}`);
console.log(`Voice: ${voice}\n`);

const passed = await testTts();

if (passed) {
  console.log("\nTTS is ready. Voice replies will work on Telegram.");
} else {
  console.error("\nTTS test failed. Fix the issues above.");
  process.exit(1);
}
