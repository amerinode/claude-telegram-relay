/**
 * MS365 Worker — File-based IPC to avoid Bun's libuv crash
 *
 * This runs as a SEPARATE Node.js process (via PM2), completely independent
 * of Bun. It watches a request directory for JSON files. When one appears,
 * it runs Claude with the MS365 MCP config and writes the result.
 *
 * The Telegram relay (Bun) writes request files and polls for response files.
 * This avoids Bun ever being in the process ancestry of Claude+MCP.
 *
 * Request file format: { prompt: string, configFile: string, allowedTools: string[] }
 * Response file format: { output: string } or { error: string }
 */
import { watch, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const WATCH_DIR = process.argv[2] || join(process.env.HOME || process.env.USERPROFILE, ".claude-relay", "ms365-requests");
const LOG_FILE = join(WATCH_DIR, "..", "ms365-worker.log");

// Ensure watch directory exists
if (!existsSync(WATCH_DIR)) {
  mkdirSync(WATCH_DIR, { recursive: true });
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `${ts}: ${msg}\n`;
  try { writeFileSync(LOG_FILE, line, { flag: "a" }); } catch {}
  process.stderr.write(line);
}

log("MS365 worker started. Watching: " + WATCH_DIR);

const MAX_RETRIES = 5;
const CRASH_CODES = new Set([3221225477, -1073741819, 139]);

function processRequest(filePath) {
  let request;
  try {
    const raw = readFileSync(filePath, "utf-8");
    request = JSON.parse(raw);
  } catch (e) {
    log(`Failed to read request ${filePath}: ${e.message}`);
    return;
  }

  const { prompt, configFile, allowedTools, responseFile } = request;
  if (!prompt || !configFile || !responseFile) {
    log(`Invalid request: missing fields`);
    return;
  }

  log(`Processing request: ${prompt.substring(0, 60)}...`);

  // Delete request file immediately so we don't process it again
  try { unlinkSync(filePath); } catch {}

  const args = [
    "-p", prompt,
    "--no-session-persistence",
    "--output-format", "text",
    "--mcp-config", configFile,
    "--allowedTools", ...(allowedTools || ["mcp__ms365__*"]),
  ];

  const env = {
    ...process.env,
    CLAUDECODE: "",
    CLAUDE_CODE_ENTRYPOINT: "",
  };

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log(`  Attempt ${attempt}/${MAX_RETRIES}...`);

    const result = spawnSync("claude", args, {
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env,
    });

    // Success
    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      log(`  Attempt ${attempt} succeeded (${result.stdout.length} chars)`);
      writeFileSync(responseFile, JSON.stringify({ output: result.stdout.trim() }), "utf-8");
      return;
    }

    // Check for output despite non-zero exit (crash at shutdown after completing)
    if (result.stdout && result.stdout.trim()) {
      log(`  Attempt ${attempt} had exit=${result.status} but has output, using it`);
      writeFileSync(responseFile, JSON.stringify({ output: result.stdout.trim() }), "utf-8");
      return;
    }

    const isCrash = CRASH_CODES.has(result.status) || result.signal === "SIGSEGV";
    lastError = result.stderr || result.error?.message || `exit:${result.status}`;
    log(`  Attempt ${attempt} ${isCrash ? "crashed" : "failed"}: ${lastError.substring(0, 150)}`);

    if (!isCrash) break; // Non-crash error, don't retry

    // Brief pause before retry
    if (attempt < MAX_RETRIES) {
      spawnSync(process.platform === "win32" ? "timeout" : "sleep",
        process.platform === "win32" ? ["/t", "1", "/nobreak"] : ["1"],
        { windowsHide: true, stdio: "ignore" });
    }
  }

  // All attempts failed
  log(`  All attempts failed: ${lastError?.substring(0, 200)}`);
  writeFileSync(responseFile, JSON.stringify({ error: lastError || "All attempts crashed" }), "utf-8");

  // Self-restart: the libuv crash rate increases over time, so after a
  // full failure (all retries exhausted), exit and let PM2 restart us
  // with a fresh process. This dramatically improves the next request.
  log("  Self-restarting worker (PM2 will respawn)...");
  setTimeout(() => process.exit(1), 500);
}

// Watch for new .json request files
log("Watching for request files...");

// Process any existing files first
import { readdirSync } from "fs";
const existing = readdirSync(WATCH_DIR).filter(f => f.endsWith(".request.json"));
for (const f of existing) {
  processRequest(join(WATCH_DIR, f));
}

// Watch for new files
const watcher = watch(WATCH_DIR, (eventType, filename) => {
  if (!filename || !filename.endsWith(".request.json")) return;
  const filePath = join(WATCH_DIR, filename);
  // Small delay to ensure file is fully written
  setTimeout(() => {
    if (existsSync(filePath)) {
      processRequest(filePath);
    }
  }, 100);
});

// Keep process alive
process.on("SIGINT", () => {
  log("Worker shutting down");
  watcher.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Worker shutting down");
  watcher.close();
  process.exit(0);
});
