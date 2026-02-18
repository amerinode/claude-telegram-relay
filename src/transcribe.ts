/**
 * Voice Transcription Module
 *
 * Routes to Groq (cloud) or whisper.cpp (local) based on VOICE_PROVIDER env var.
 * Returns transcription text and detected language code.
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";

const VOICE_PROVIDER = process.env.VOICE_PROVIDER || "";

export interface TranscriptionResult {
  text: string;
  language?: string; // ISO 639-1 code: "en", "pt", "es", etc.
}

/**
 * Transcribe an audio buffer to text.
 * Returns empty result if no provider is configured.
 */
export async function transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
  if (!VOICE_PROVIDER) return { text: "" };

  if (VOICE_PROVIDER === "groq") {
    return transcribeGroq(audioBuffer);
  }

  if (VOICE_PROVIDER === "local") {
    const text = await transcribeLocal(audioBuffer);
    return { text };
  }

  console.error(`Unknown VOICE_PROVIDER: ${VOICE_PROVIDER}`);
  return { text: "" };
}

async function transcribeGroq(audioBuffer: Buffer): Promise<TranscriptionResult> {
  const Groq = (await import("groq-sdk")).default;
  const groq = new Groq(); // reads GROQ_API_KEY from env

  const file = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

  const result = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
    response_format: "verbose_json",
  });

  // verbose_json includes detected language
  const language = (result as any).language || undefined;

  // Map full language names to ISO codes
  const langMap: Record<string, string> = {
    english: "en",
    portuguese: "pt",
    spanish: "es",
    french: "fr",
    german: "de",
    italian: "it",
  };

  const langCode = language ? langMap[language.toLowerCase()] || language : undefined;

  return {
    text: result.text.trim(),
    language: langCode,
  };
}

async function transcribeLocal(audioBuffer: Buffer): Promise<string> {
  const whisperBinary = process.env.WHISPER_BINARY || "whisper-cpp";
  const modelPath = process.env.WHISPER_MODEL_PATH || "";

  if (!modelPath) {
    throw new Error("WHISPER_MODEL_PATH not set");
  }

  const timestamp = Date.now();
  const tmpDir = process.env.TMPDIR || process.env.TEMP || "/tmp";
  const oggPath = join(tmpDir, `voice_${timestamp}.ogg`);
  const wavPath = join(tmpDir, `voice_${timestamp}.wav`);
  const txtPath = join(tmpDir, `voice_${timestamp}.txt`);

  try {
    // Write OGG to temp file
    await writeFile(oggPath, audioBuffer);

    // Convert OGG → WAV via ffmpeg
    const ffmpeg = spawn(
      ["ffmpeg", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const ffmpegExit = await ffmpeg.exited;
    if (ffmpegExit !== 0) {
      const stderr = await new Response(ffmpeg.stderr).text();
      throw new Error(`ffmpeg failed (code ${ffmpegExit}): ${stderr}`);
    }

    // Transcribe via whisper.cpp
    const whisper = spawn(
      [whisperBinary, "--model", modelPath, "--file", wavPath, "--output-txt", "--output-file", join(tmpDir, `voice_${timestamp}`), "--no-prints"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const whisperExit = await whisper.exited;
    if (whisperExit !== 0) {
      const stderr = await new Response(whisper.stderr).text();
      throw new Error(`whisper-cpp failed (code ${whisperExit}): ${stderr}`);
    }

    // Read the output text file
    const text = await readFile(txtPath, "utf-8");
    return text.trim();
  } finally {
    // Cleanup temp files
    await unlink(oggPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
    await unlink(txtPath).catch(() => {});
  }
}
