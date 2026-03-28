/**
 * Inbox Cleanup — Automated Spam/Marketing Filter
 *
 * Runs once daily on weekdays (via PM2 cron). Scans recent inbox emails,
 * uses Claude to classify spam/marketing, and moves them to "Potential Spam" folder.
 *
 * Flow:
 *   1. Fetch recent unread emails from Inbox
 *   2. Ask Claude to classify which are spam/marketing
 *   3. Create "Potential Spam" folder if needed
 *   4. Move flagged emails to that folder
 *   5. Send summary to Gil on Telegram
 *
 * Run manually: bun run examples/inbox-cleanup.ts
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import {
  listEmails,
  getOrCreateMailFolder,
  moveEmail,
  type Email,
} from "../src/ms365.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const USER_NAME = process.env.USER_NAME || "Gil";
const FOLDER_NAME = process.env.SPAM_FOLDER_NAME || "Potential Spam";

// How many emails to scan each run
const SCAN_COUNT = 30;

// State file to track processed emails (avoid re-scanning)
const STATE_FILE = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".claude-relay",
  "inbox-cleanup-state.json",
);

interface CleanupState {
  lastRunTime: string;
  /** Email IDs we've already processed (kept for 7 days) */
  processedIds: Record<string, string>; // emailId -> ISO timestamp
}

async function loadState(): Promise<CleanupState> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastRunTime: "", processedIds: {} };
  }
}

async function saveState(state: CleanupState): Promise<void> {
  // Prune entries older than 7 days
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.processedIds)) {
    if (new Date(ts).getTime() < cutoff) {
      delete state.processedIds[id];
    }
  }
  const dir = dirname(STATE_FILE);
  const { mkdirSync, existsSync } = await import("fs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
        }),
      },
    );
    if (!response.ok) {
      const err = await response.text().catch(() => "");
      console.error(`Telegram API error (${response.status}): ${err.substring(0, 200)}`);
    }
    return response.ok;
  } catch (error: any) {
    console.error(`Telegram send failed: ${error.message}`);
    return false;
  }
}

/**
 * Ask Claude to classify emails as spam/marketing or legitimate.
 * Returns the IDs of emails Claude flags as spam.
 */
async function classifyWithClaude(emails: Email[]): Promise<string[]> {
  const emailList = emails
    .map(
      (e, i) =>
        `[${i}] From: ${e.from} <${e.fromEmail}>\n    Subject: ${e.subject}\n    Preview: ${e.preview.substring(0, 150)}`,
    )
    .join("\n");

  const prompt = `You are an email spam/marketing classifier for ${USER_NAME}, a CEO of a telecom company (Amerinode).

EMAILS TO CLASSIFY:
${emailList}

RULES:
- Flag as SPAM: cold sales outreach, marketing newsletters, promotional offers, award/list bait, surveys, product announcements from companies ${USER_NAME} didn't sign up for
- Flag as SPAM: emails addressed to the wrong person (wrong name)
- Keep as LEGITIMATE: emails from colleagues, clients, partners, direct business contacts, internal company emails, personal contacts
- Keep as LEGITIMATE: emails from services ${USER_NAME} actively uses (calendar invites, meeting summaries, etc.)
- When in doubt, keep it — false positives are worse than false negatives

Respond with ONLY the bracket numbers of spam/marketing emails, comma-separated. Example: 0, 3, 5, 7
If none are spam, respond with: NONE`;

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const claudeArgs = ["--no-session-persistence", "--output-format", "text"];
    const promptFile = join(PROJECT_ROOT, `temp_classify_${Date.now()}.txt`);
    await writeFile(promptFile, prompt);

    const result = await new Promise<string>((resolve) => {
      const child = nodeSpawn(CLAUDE_PATH, claudeArgs, {
        cwd: PROJECT_ROOT,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let output = "";
      child.stdout?.on("data", (d: Buffer) => {
        output += d.toString();
      });
      child.stderr?.on("data", () => {}); // discard

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        unlink(promptFile).catch(() => {});
        resolve("NONE");
      }, 120_000);

      const fs = require("fs");
      fs.createReadStream(promptFile).pipe(child.stdin!);

      child.on("close", () => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        resolve(output.trim() || "NONE");
      });

      child.on("error", () => {
        clearTimeout(timeout);
        unlink(promptFile).catch(() => {});
        resolve("NONE");
      });
    });

    console.log(`Claude classification: ${result}`);

    if (result.toUpperCase().includes("NONE")) return [];

    // Parse indices like "0, 3, 5, 7"
    const indices = result
      .replace(/[^0-9,]/g, "")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 0 && n < emails.length);

    return indices.map((i) => emails[i].id);
  } catch (error: any) {
    console.error("Claude classification error:", error.message);
    return [];
  }
}

async function main() {
  console.log("=== Inbox Cleanup ===");
  console.log(`Time: ${new Date().toLocaleString()}`);

  const state = await loadState();

  // 1. Fetch recent emails
  console.log(`\nFetching last ${SCAN_COUNT} emails...`);
  const allEmails = await listEmails(SCAN_COUNT);
  console.log(`Found ${allEmails.length} emails total`);

  // Filter out already-processed emails
  const newEmails = allEmails.filter((e) => !state.processedIds[e.id]);
  console.log(`New (unprocessed): ${newEmails.length}`);

  if (newEmails.length === 0) {
    console.log("No new emails to process. Done.");
    state.lastRunTime = new Date().toISOString();
    await saveState(state);
    return;
  }

  // 2. Classify with Claude
  console.log("\nAsking Claude to classify...");
  const spamIds = await classifyWithClaude(newEmails);
  console.log(`Flagged as spam: ${spamIds.length}`);

  // Mark all scanned emails as processed
  const now = new Date().toISOString();
  for (const email of newEmails) {
    state.processedIds[email.id] = now;
  }

  if (spamIds.length === 0) {
    console.log("Inbox is clean! No spam found.");
    state.lastRunTime = now;
    await saveState(state);
    return;
  }

  // 3. Get or create the spam folder
  console.log(`\nEnsuring "${FOLDER_NAME}" folder exists...`);
  const folder = await getOrCreateMailFolder(FOLDER_NAME);
  if (folder.created) {
    console.log(`Created folder: ${folder.displayName}`);
  } else {
    console.log(`Folder exists: ${folder.displayName}`);
  }

  // 4. Move spam emails
  console.log("\nMoving spam emails...");
  let moved = 0;
  let failed = 0;
  const movedEmails: Email[] = [];

  for (const emailId of spamIds) {
    try {
      await moveEmail(emailId, folder.id);
      moved++;
      const email = newEmails.find((e) => e.id === emailId);
      if (email) movedEmails.push(email);
    } catch (e: any) {
      console.error(`Failed to move email: ${e.message}`);
      failed++;
    }
  }

  console.log(`Moved: ${moved}, Failed: ${failed}`);

  // 5. Send summary to Telegram
  if (moved > 0 && BOT_TOKEN && CHAT_ID) {
    const lines = movedEmails.map(
      (e) => `• ${e.from} — ${e.subject.substring(0, 60)}`,
    );
    const summary =
      `🧹 Inbox cleanup: moved ${moved} email${moved !== 1 ? "s" : ""} to "${FOLDER_NAME}"\n\n` +
      lines.join("\n") +
      (failed > 0 ? `\n\n⚠️ ${failed} failed to move` : "");

    await sendTelegram(summary);
  }

  state.lastRunTime = now;
  await saveState(state);
  console.log("\nInbox cleanup complete.");
}

main().catch((error) => {
  console.error("Inbox cleanup failed:", error);
  process.exit(1);
});
