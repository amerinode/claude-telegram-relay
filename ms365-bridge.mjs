/**
 * MS365 Bridge Script (with retry)
 *
 * Runs Claude CLI with MS365 MCP tools via Node.js spawnSync.
 * Works around a Windows libuv bug (0xC0000005) that crashes
 * non-deterministically when the MCP server makes HTTP requests.
 *
 * The crash is a race condition — ~30-50% of attempts succeed.
 * This bridge retries up to 3 times on crash, which gives >95%
 * overall success rate.
 *
 * Usage: node ms365-bridge.mjs <prompt-file> <output-file> <config-file> <tools...>
 */
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";

const [, , promptFile, outputFile, configFile, ...allowedTools] = process.argv;

if (!promptFile || !outputFile || !configFile) {
  process.stderr.write(
    "Usage: node ms365-bridge.mjs <prompt-file> <output-file> <config-file> <tools...>\n"
  );
  process.exit(1);
}

const logFile = join(dirname(promptFile), "bridge-debug.log");
function log(msg) {
  const ts = new Date().toISOString();
  try { appendFileSync(logFile, `${ts}: ${msg}\n`); } catch {}
}

const prompt = readFileSync(promptFile, "utf-8");

const args = [
  "-p", prompt,
  "--no-session-persistence",
  "--output-format", "text",
  "--mcp-config", configFile,
  "--allowedTools", ...allowedTools,
];

const env = {
  ...process.env,
  CLAUDECODE: "",
  CLAUDE_CODE_ENTRYPOINT: "",
};

const MAX_RETRIES = 3;
const CRASH_CODE = 3221225477; // 0xC0000005 unsigned
const CRASH_CODE_SIGNED = -1073741819; // 0xC0000005 signed
const SEGFAULT_SIGNAL = "SIGSEGV";

log(`Bridge started. Prompt length: ${prompt.length}, tools: ${allowedTools.join(" ")}`);

let lastError = null;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  log(`Attempt ${attempt}/${MAX_RETRIES}...`);

  const result = spawnSync("claude", args, {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env,
  });

  const exitCode = result.status;
  const signal = result.signal;

  // Check for success
  if (exitCode === 0 && result.stdout && result.stdout.trim()) {
    log(`Attempt ${attempt} succeeded (${result.stdout.length} chars)`);
    writeFileSync(outputFile, result.stdout, "utf-8");
    process.exit(0);
  }

  // Check for the known libuv crash (non-deterministic race condition)
  const isCrash = (
    exitCode === CRASH_CODE ||
    exitCode === CRASH_CODE_SIGNED ||
    signal === SEGFAULT_SIGNAL ||
    exitCode === 139  // SIGSEGV exit code
  );

  if (isCrash && attempt < MAX_RETRIES) {
    log(`Attempt ${attempt} crashed (exit=${exitCode}, signal=${signal}), retrying...`);
    lastError = `crash:${exitCode}`;
    // Brief pause before retry
    spawnSync("timeout", ["/t", "2", "/nobreak"], { windowsHide: true, stdio: "ignore" });
    continue;
  }

  // Non-crash error or final attempt
  if (result.stdout && result.stdout.trim()) {
    // Got output despite error exit code (e.g., MCP server crashed at shutdown)
    log(`Attempt ${attempt} had exit=${exitCode} but has output, using it`);
    writeFileSync(outputFile, result.stdout, "utf-8");
    process.exit(0);
  }

  lastError = result.stderr || result.error?.message || `exit:${exitCode}`;
  log(`Attempt ${attempt} failed: ${lastError.substring(0, 200)}`);

  if (!isCrash) {
    // Non-crash error, don't retry
    break;
  }
}

// All attempts failed
log(`All ${MAX_RETRIES} attempts failed. Last error: ${lastError?.substring(0, 200)}`);
writeFileSync(outputFile, `ERROR:${CRASH_CODE}:${lastError || "All attempts crashed"}`, "utf-8");
