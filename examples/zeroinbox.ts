/**
 * ZeroInbox v2 — 5-Folder Email Management System
 *
 * Runs daily at 8:30 AM on weekdays via PM2. Full server-side execution —
 * no live session required. Fetches emails, classifies them, moves them,
 * drafts replies, and sends a Telegram summary.
 *
 * Folders:
 *   Important    — Customer/internal emails (domain-matched)
 *   Read         — Curated newsletters (sender-matched)
 *   Subscription — Marketing/newsletter emails (Claude-classified)
 *   Respond      — Emails needing a reply (Claude-classified)
 *   Spam         — Cold outreach, promos (score + Claude)
 *
 * Flow:
 *   1. Load rules (domains, safe senders, spam senders)
 *   2. Fetch 50 most recent inbox emails
 *   3. Skip already-processed email IDs
 *   4. Domain-rule pre-classification (Important, Read)
 *   5. Claude classifies remaining into Subscription/Respond/Spam
 *   6. Move all emails to their folders via Graph API
 *   7. For Important + Respond: read full email, Claude drafts reply → save to Drafts
 *   8. Telegram summary
 *   9. Save state
 *
 * Run manually: bun run examples/zeroinbox.ts
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import {
  listEmails,
  readEmail,
  getOrCreateMailFolder,
  moveEmail,
  createDraft,
  type Email,
} from "../src/ms365.ts";

// ============================================================
// CONFIG
// ============================================================

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const USER_NAME = process.env.USER_NAME || "Gil";

const RULES_FILE = join(PROJECT_ROOT, "config", "zeroinbox-rules.json");
const STATE_FILE = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".claude-relay",
  "zeroinbox-state.json"
);

const SCAN_COUNT = 50;
const MAX_DRAFTS = 10; // Cap drafts per run to avoid runaway API usage
const CLAUDE_TIMEOUT_MS = 90_000;

// ============================================================
// TYPES
// ============================================================

type Folder = "Important" | "Read" | "Subscription" | "Respond" | "Spam";

interface Rules {
  importantDomains: string[];
  readSenders: string[];
  spamSenders: string[];
  safeSenders: string[];
  spamKeywords: string[];
}

interface ClassifiedEmail {
  email: Email;
  folder: Folder;
  reason?: string;
}

interface ZeroInboxState {
  lastRunTime: string;
  /** emailId → ISO timestamp when processed */
  processedIds: Record<string, string>;
  /** Track spam senders discovered at runtime */
  learnedSpamSenders: string[];
}

interface RunSummary {
  total: number;
  moved: { folder: Folder; count: number }[];
  draftsCreated: number;
  errors: number;
}

// ============================================================
// STATE
// ============================================================

async function loadState(): Promise<ZeroInboxState> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      lastRunTime: parsed.lastRunTime || "",
      processedIds: parsed.processedIds || {},
      learnedSpamSenders: parsed.learnedSpamSenders || [],
    };
  } catch {
    return { lastRunTime: "", processedIds: {}, learnedSpamSenders: [] };
  }
}

async function saveState(state: ZeroInboxState): Promise<void> {
  // Prune processed IDs older than 14 days
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.processedIds)) {
    if (new Date(ts).getTime() < cutoff) delete state.processedIds[id];
  }
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// RULES
// ============================================================

async function loadRules(): Promise<Rules> {
  try {
    const raw = await readFile(RULES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      importantDomains: [],
      readSenders: [],
      spamSenders: [],
      safeSenders: [],
      spamKeywords: [],
    };
  }
}

function extractDomain(email: string): string {
  return email.split("@")[1]?.toLowerCase() || "";
}

// ============================================================
// DOMAIN-RULE PRE-CLASSIFICATION
// ============================================================

function preClassify(
  email: Email,
  rules: Rules,
  learnedSpamSenders: string[]
): Folder | null {
  const fromLower = email.fromEmail.toLowerCase();
  const fromDomain = extractDomain(fromLower);
  const subjectLower = email.subject.toLowerCase();
  const previewLower = email.preview.toLowerCase();

  // Safe sender → never spam
  const isSafe = rules.safeSenders.some(
    (s) => fromLower === s.toLowerCase()
  );

  // Important: customer or Amerinode domain
  if (
    rules.importantDomains.some(
      (d) => fromDomain === d.toLowerCase() || fromDomain.endsWith(`.${d.toLowerCase()}`)
    )
  ) {
    return "Important";
  }

  // Read: curated newsletter sender
  if (
    rules.readSenders.some(
      (s) => fromDomain === s.toLowerCase() || fromLower.endsWith(`@${s.toLowerCase()}`)
    )
  ) {
    return "Read";
  }

  // Spam: known spam senders
  if (!isSafe) {
    const allSpamSenders = [...rules.spamSenders, ...learnedSpamSenders];
    if (
      allSpamSenders.some((s) => {
        const sl = s.toLowerCase();
        return fromLower.includes(sl) || fromDomain.includes(sl);
      })
    ) {
      return "Spam";
    }

    // Spam: keyword match in subject or preview
    const allText = `${subjectLower} ${previewLower}`;
    const spamKeywordHit = rules.spamKeywords.some((kw) =>
      allText.includes(kw.toLowerCase())
    );
    if (spamKeywordHit) return "Spam";
  }

  // No pre-classification — let Claude decide
  return null;
}

// ============================================================
// CLAUDE HELPERS
// ============================================================

async function askClaude(prompt: string): Promise<string> {
  const tmpFile = join(PROJECT_ROOT, `temp_zeroinbox_${Date.now()}.txt`);
  await writeFile(tmpFile, prompt);

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve) => {
    const child = nodeSpawn(
      CLAUDE_PATH,
      ["--no-session-persistence", "--output-format", "text"],
      {
        cwd: PROJECT_ROOT,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      }
    );

    let output = "";
    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", () => {});

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      unlink(tmpFile).catch(() => {});
      resolve("");
    }, CLAUDE_TIMEOUT_MS);

    const fs = require("fs");
    fs.createReadStream(tmpFile).pipe(child.stdin!);

    child.on("close", () => {
      clearTimeout(timer);
      unlink(tmpFile).catch(() => {});
      resolve(output.trim());
    });

    child.on("error", () => {
      clearTimeout(timer);
      unlink(tmpFile).catch(() => {});
      resolve("");
    });
  });
}

// ============================================================
// STEP 1: CLAUDE MULTI-FOLDER CLASSIFICATION
// ============================================================

interface ClaudeClassification {
  index: number;
  folder: Folder;
  reason: string;
}

async function classifyWithClaude(
  emails: Email[]
): Promise<ClaudeClassification[]> {
  if (!emails.length) return [];

  const emailList = emails
    .map(
      (e, i) =>
        `[${i}] From: ${e.from} <${e.fromEmail}>\n    Subject: ${e.subject}\n    Preview: ${e.preview.substring(0, 200)}`
    )
    .join("\n\n");

  const prompt = `You are ZeroInbox, an email classification engine for ${USER_NAME}, CEO of Amerinode (global telecom company, 13 countries).

Classify each email into exactly one folder. Respond in JSON only — no prose.

FOLDERS:
- "Subscription": newsletters, digests, automated service emails, GitHub notifications, LinkedIn digests, Atlassian notifications, Jira/Confluence updates, invoice/receipt emails from services, any automated system email
- "Respond": a real person emailed ${USER_NAME} and expects a reply. Not a customer/partner (those go Important), but a legitimate human contact, a recruiter, a journalist, an event organizer, a potential partner, a personal contact
- "Spam": cold sales outreach, marketing promotions, award bait, lead gen pitches, "open to an exit" acquisition inquiries, speaking fee solicitations, SEO/backlink services, unsolicited offers

RULES:
- Customer/partner domain emails (telefonica.com, claro.com.br, timbrasil.com.br, algartelecom.com.br, vtal.com.br, tim.com.br, amerinode.com.br) were already classified as Important — they won't appear here
- If you genuinely cannot decide between Respond and Spam, lean Respond — false positives in Spam are worse
- GitHub/Jira/Atlassian notifications → always Subscription
- LinkedIn notifications → Subscription; LinkedIn InMail from a real person → Respond

EMAILS:
${emailList}

Respond with a JSON array, one entry per email:
[
  {"index": 0, "folder": "Subscription", "reason": "GitHub notification"},
  {"index": 1, "folder": "Spam", "reason": "Cold sales outreach about telecom leads"},
  ...
]`;

  try {
    const raw = await askClaude(prompt);

    // Extract JSON array from response (Claude might wrap in prose)
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error("Claude returned no JSON array:", raw.substring(0, 200));
      return [];
    }

    const parsed: ClaudeClassification[] = JSON.parse(match[0]);
    return parsed.filter(
      (c) =>
        typeof c.index === "number" &&
        c.index >= 0 &&
        c.index < emails.length &&
        ["Subscription", "Respond", "Spam"].includes(c.folder)
    );
  } catch (err: any) {
    console.error("Claude classification failed:", err.message);
    return [];
  }
}

// ============================================================
// STEP 2: DRAFT REPLIES FOR IMPORTANT + RESPOND
// ============================================================

async function draftReply(
  email: Email,
  fullBody: string
): Promise<string | null> {
  const prompt = `You are Ona, personal AI assistant for ${USER_NAME} (CEO of Amerinode, telecom company, 13 countries).

Draft a reply to this email on behalf of ${USER_NAME}. Be professional but warm. Match the language of the original email (if Portuguese → reply in Portuguese, if English → reply in English). Keep it concise and actionable.

ORIGINAL EMAIL:
From: ${email.from} <${email.fromEmail}>
Subject: ${email.subject}
Date: ${email.receivedAt}

Body:
${fullBody.substring(0, 2000)}

---
Write ONLY the reply body text (no subject line, no "Dear...", just the reply body starting from the first sentence). Keep it under 150 words.`;

  const result = await askClaude(prompt);
  return result || null;
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;

  // Split into chunks if needed (Telegram 4096 char limit)
  const chunks: string[] = [];
  const maxLen = 4096;
  let text = message;
  while (text.length > 0) {
    if (text.length <= maxLen) {
      chunks.push(text);
      break;
    }
    // Split at last newline before limit
    const cutoff = text.lastIndexOf("\n", maxLen);
    const splitAt = cutoff > 0 ? cutoff : maxLen;
    chunks.push(text.substring(0, splitAt));
    text = text.substring(splitAt).trimStart();
  }

  let ok = true;
  for (const chunk of chunks) {
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: CHAT_ID, text: chunk }),
        }
      );
      if (!resp.ok) {
        console.error(`Telegram error (${resp.status}): ${await resp.text().catch(() => "")}`);
        ok = false;
      }
    } catch (e: any) {
      console.error("Telegram send failed:", e.message);
      ok = false;
    }
  }
  return ok;
}

// ============================================================
// BUILD SUMMARY
// ============================================================

function buildSummaryMessage(
  summary: RunSummary,
  classified: ClassifiedEmail[],
  draftsCreated: number,
  errors: number
): string {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: process.env.USER_TIMEZONE || "America/Sao_Paulo",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const folderEmojis: Record<Folder, string> = {
    Important: "📌",
    Read: "📖",
    Subscription: "📬",
    Respond: "💬",
    Spam: "🗑️",
  };

  const lines: string[] = [`📧 ZeroInbox — ${timestamp}`, ""];

  // Summary counts
  const byFolder: Partial<Record<Folder, ClassifiedEmail[]>> = {};
  for (const c of classified) {
    if (!byFolder[c.folder]) byFolder[c.folder] = [];
    byFolder[c.folder]!.push(c);
  }

  const folderOrder: Folder[] = ["Important", "Read", "Subscription", "Respond", "Spam"];
  for (const folder of folderOrder) {
    const items = byFolder[folder] || [];
    if (items.length === 0) continue;
    lines.push(`${folderEmojis[folder]} ${folder} (${items.length})`);
    // Show up to 5 items per folder
    for (const item of items.slice(0, 5)) {
      lines.push(`  • ${item.email.from} — ${item.email.subject.substring(0, 55)}`);
    }
    if (items.length > 5) lines.push(`  + ${items.length - 5} more`);
    lines.push("");
  }

  if (draftsCreated > 0) {
    lines.push(`✏️ ${draftsCreated} draft${draftsCreated !== 1 ? "s" : ""} saved to Outlook Drafts`);
  }

  if (errors > 0) {
    lines.push(`⚠️ ${errors} error${errors !== 1 ? "s" : ""} — check logs`);
  }

  if (classified.length === 0) {
    lines.push("✅ Inbox already clean — nothing to process");
  }

  return lines.join("\n").trim();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("=== ZeroInbox v2 ===");
  console.log(`Time: ${new Date().toISOString()}`);

  // --- Load rules + state ---
  const [rules, state] = await Promise.all([loadRules(), loadState()]);
  console.log(`Loaded rules: ${rules.importantDomains.length} important domains, ${rules.readSenders.length} read senders`);

  // --- Fetch emails ---
  console.log(`\nFetching last ${SCAN_COUNT} inbox emails...`);
  let allEmails: Email[];
  try {
    allEmails = await listEmails(SCAN_COUNT);
  } catch (err: any) {
    console.error("Failed to fetch emails:", err.message);
    await sendTelegram(`❌ ZeroInbox failed: could not fetch emails\n${err.message}`);
    return;
  }
  console.log(`Fetched ${allEmails.length} emails`);

  // --- Skip already-processed ---
  const newEmails = allEmails.filter((e) => !state.processedIds[e.id]);
  console.log(`New (unprocessed): ${newEmails.length}`);

  if (newEmails.length === 0) {
    console.log("Nothing new to process. Done.");
    state.lastRunTime = new Date().toISOString();
    await saveState(state);
    return;
  }

  // --- Pre-classify by domain rules ---
  const classified: ClassifiedEmail[] = [];
  const needsClaude: Email[] = [];

  for (const email of newEmails) {
    const folder = preClassify(email, rules, state.learnedSpamSenders);
    if (folder) {
      classified.push({ email, folder, reason: "domain/sender rule" });
    } else {
      needsClaude.push(email);
    }
  }
  console.log(`Pre-classified: ${classified.length}, needs Claude: ${needsClaude.length}`);

  // --- Claude classification for remaining ---
  if (needsClaude.length > 0) {
    console.log("\nAsking Claude to classify remaining emails...");
    const claudeResults = await classifyWithClaude(needsClaude);
    console.log(`Claude classified ${claudeResults.length}/${needsClaude.length}`);

    const classifiedByIndex = new Map(claudeResults.map((c) => [c.index, c]));

    for (let i = 0; i < needsClaude.length; i++) {
      const email = needsClaude[i];
      const result = classifiedByIndex.get(i);
      if (result) {
        classified.push({ email, folder: result.folder, reason: result.reason });
      } else {
        // Claude didn't return a result → default to Subscription (safest)
        classified.push({ email, folder: "Subscription", reason: "unclassified (default)" });
      }
    }
  }

  // --- Resolve folder IDs ---
  console.log("\nResolving folder IDs...");
  const folderIds: Partial<Record<Folder, string>> = {};
  const foldersNeeded = [...new Set(classified.map((c) => c.folder))];

  await Promise.all(
    foldersNeeded.map(async (folder) => {
      try {
        const f = await getOrCreateMailFolder(folder);
        folderIds[folder] = f.id;
        if (f.created) console.log(`Created folder: ${folder}`);
        else console.log(`Folder exists: ${folder} (${f.id.substring(0, 20)}...)`);
      } catch (err: any) {
        console.error(`Failed to get/create folder "${folder}":`, err.message);
      }
    })
  );

  // --- Move emails ---
  console.log("\nMoving emails...");
  let moveErrors = 0;
  const now = new Date().toISOString();

  for (const item of classified) {
    const folderId = folderIds[item.folder];
    if (!folderId) {
      console.error(`No folder ID for ${item.folder}, skipping email: ${item.email.id}`);
      moveErrors++;
      state.processedIds[item.email.id] = now; // still mark as processed
      continue;
    }
    try {
      await moveEmail(item.email.id, folderId);
      state.processedIds[item.email.id] = now;
      console.log(`  → ${item.folder}: ${item.email.from} / ${item.email.subject.substring(0, 50)}`);
    } catch (err: any) {
      // "Resource not found" means email was already moved (e.g., race condition or re-run)
      if (err.message?.includes("404") || err.message?.includes("Resource not found")) {
        console.log(`  (already moved) ${item.folder}: ${item.email.subject.substring(0, 40)}`);
        state.processedIds[item.email.id] = now;
      } else {
        console.error(`  Failed to move to ${item.folder}: ${err.message}`);
        moveErrors++;
      }
    }
  }

  // --- Draft replies for Important + Respond ---
  const draftCandidates = classified
    .filter((c) => c.folder === "Important" || c.folder === "Respond")
    .slice(0, MAX_DRAFTS);

  let draftsCreated = 0;
  if (draftCandidates.length > 0) {
    console.log(`\nDrafting replies for ${draftCandidates.length} emails...`);

    for (const item of draftCandidates) {
      try {
        console.log(`  Drafting: ${item.email.subject.substring(0, 50)}`);
        const full = await readEmail(item.email.id).catch(() => null);
        const body = full?.body || item.email.preview;

        const replyBody = await draftReply(item.email, body);
        if (!replyBody) {
          console.log(`  Skipped (no draft generated): ${item.email.subject.substring(0, 40)}`);
          continue;
        }

        await createDraft({
          to: [item.email.fromEmail],
          subject: `Re: ${item.email.subject}`,
          body: replyBody,
        });

        draftsCreated++;
        console.log(`  Draft saved: Re: ${item.email.subject.substring(0, 40)}`);
      } catch (err: any) {
        console.error(`  Draft failed for "${item.email.subject}":`, err.message);
        moveErrors++;
      }
    }
  }

  // --- Update last run time + save state ---
  state.lastRunTime = now;
  await saveState(state);

  // --- Send Telegram summary ---
  const summary = buildSummaryMessage(
    { total: classified.length, moved: [], draftsCreated, errors: moveErrors },
    classified,
    draftsCreated,
    moveErrors
  );

  if (BOT_TOKEN && CHAT_ID) {
    await sendTelegram(summary);
  }

  console.log("\n=== ZeroInbox complete ===");
  console.log(`Classified: ${classified.length}, Drafts: ${draftsCreated}, Errors: ${moveErrors}`);
}

main().catch((err) => {
  console.error("ZeroInbox v2 fatal error:", err);
  process.exit(1);
});
