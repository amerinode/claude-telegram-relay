/**
 * Text-to-Speech Module
 *
 * Converts text to OGG Opus audio via Groq TTS API + ffmpeg.
 * Returns a Buffer suitable for Telegram's sendVoice (OGG+Opus).
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";

const TTS_MODEL = process.env.TTS_MODEL || "canopylabs/orpheus-v1-english";
const TTS_VOICE = process.env.TTS_VOICE || "hannah";

/**
 * Synthesize text to OGG Opus audio.
 * Returns null if Groq is not configured or on error.
 */
export async function synthesize(text: string): Promise<Buffer | null> {
  if (!process.env.GROQ_API_KEY) return null;
  if (!text.trim()) return null;

  try {
    const Groq = (await import("groq-sdk")).default;
    const groq = new Groq();

    const response = await groq.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: "wav",
    });

    const wavBuffer = Buffer.from(await response.arrayBuffer());
    return await convertToOggOpus(wavBuffer);
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}

/**
 * Convert WAV buffer to OGG Opus via ffmpeg.
 * Telegram requires OGG+Opus for voice messages.
 */
async function convertToOggOpus(wavBuffer: Buffer): Promise<Buffer> {
  const timestamp = Date.now();
  const tmpDir = process.env.TMPDIR || process.env.TEMP || "/tmp";
  const wavPath = join(tmpDir, `tts_${timestamp}.wav`);
  const oggPath = join(tmpDir, `tts_${timestamp}.ogg`);

  try {
    await writeFile(wavPath, wavBuffer);

    const ffmpeg = spawn(
      [
        "ffmpeg",
        "-i", wavPath,
        "-c:a", "libopus",
        "-b:a", "64k",
        "-ar", "48000",
        "-ac", "1",
        oggPath,
        "-y",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await ffmpeg.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(ffmpeg.stderr).text();
      throw new Error(`ffmpeg failed (code ${exitCode}): ${stderr}`);
    }

    return Buffer.from(await readFile(oggPath));
  } finally {
    await unlink(wavPath).catch(() => {});
    await unlink(oggPath).catch(() => {});
  }
}
