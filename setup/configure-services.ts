/**
 * Claude Telegram Relay — Configure Services (Windows/Linux)
 *
 * Sets up PM2 for process management on non-macOS systems.
 *
 * Usage: bun run setup/configure-services.ts [--service relay|checkin|briefing|all]
 */

import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return { ok: false, stdout: "", stderr: "Command not found" };
  }
}

interface ServiceDef {
  name: string;
  script: string;
  cron?: string;
  description: string;
}

const SERVICES: Record<string, ServiceDef> = {
  relay: {
    name: "claude-telegram-relay",
    script: "src/relay.ts",
    description: "Main bot (always running)",
  },
  "call-server": {
    name: "claude-call-server",
    script: "src/call-server.ts",
    description: "Voice call WebSocket server (always running)",
  },
  checkin: {
    name: "claude-smart-checkin",
    script: "examples/smart-checkin.ts",
    cron: "*/30 9-18 * * *",
    description: "Smart check-ins (every 30 min, 9am-6pm)",
  },
  briefing: {
    name: "claude-morning-briefing",
    script: "examples/morning-briefing.ts",
    cron: "0 8 * * 1-5",
    description: "Morning briefing (Mon-Fri at 8am)",
  },
};

/**
 * Parse a cron expression and create a Windows Task Scheduler task.
 * Supports: "0 8 * * 1-5" (daily Mon-Fri at 8am), "*/30 9-18 * * *" (every 30 min 9am-6pm)
 */
async function installWindowsScheduledTask(config: ServiceDef): Promise<boolean> {
  if (!config.cron) return false;

  const taskName = config.name;
  const bunPath = (await run(["where", "bun"])).stdout.split("\n")[0]?.trim() || "bun";
  const scriptPath = join(PROJECT_ROOT, config.script);

  // Delete existing task (ignore errors if it doesn't exist)
  await run(["schtasks", "/Delete", "/TN", taskName, "/F"]);

  // Parse cron: minute hour dom month dow
  const parts = config.cron.split(/\s+/);
  const [cronMin, cronHour, _dom, _month, cronDow] = parts;

  // Determine schedule type and time
  let scheduleArgs: string[] = [];

  if (cronMin.startsWith("*/")) {
    // Interval-based: e.g., "*/30 9-18 * * *"
    const intervalMin = parseInt(cronMin.substring(2));
    // Parse hour range
    let startHour = "09:00";
    let endHour = "18:00";
    if (cronHour.includes("-")) {
      const [h1, h2] = cronHour.split("-").map(Number);
      startHour = `${String(h1).padStart(2, "0")}:00`;
      endHour = `${String(h2).padStart(2, "0")}:00`;
    }
    scheduleArgs = [
      "/SC", "MINUTE",
      "/MO", String(intervalMin),
      "/ST", startHour,
      "/ET", endHour,
    ];
  } else {
    // Fixed time: e.g., "0 8 * * 1-5"
    const hour = String(parseInt(cronHour)).padStart(2, "0");
    const minute = String(parseInt(cronMin)).padStart(2, "0");
    const startTime = `${hour}:${minute}`;

    if (cronDow === "1-5") {
      // Weekdays only
      scheduleArgs = ["/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", startTime];
    } else if (cronDow === "*") {
      // Every day
      scheduleArgs = ["/SC", "DAILY", "/ST", startTime];
    } else {
      scheduleArgs = ["/SC", "DAILY", "/ST", startTime];
    }
  }

  // Build the command that the task will run
  // Use cmd /c to set working directory and load .env
  const taskCommand = `cmd /c "cd /d "${PROJECT_ROOT}" && "${bunPath}" run ${config.script}"`;

  const result = await run([
    "schtasks", "/Create",
    "/TN", taskName,
    ...scheduleArgs,
    "/TR", taskCommand,
    "/F",  // Force overwrite
  ]);

  if (result.ok) {
    console.log(`  ${PASS} ${config.name} scheduled — ${config.description}`);
    console.log(`      ${dim(`Windows Task: ${taskName}`)}`);
    return true;
  }

  // schtasks can be finicky — fall back to showing manual instructions
  console.log(`  ${FAIL} Could not create scheduled task automatically`);
  console.log(`      ${dim(`Error: ${result.stderr.substring(0, 100)}`)}`);
  console.log(`      ${dim(`Manual: schtasks /Create /TN ${taskName} ${scheduleArgs.join(" ")} /TR "${bunPath} run ${scriptPath}"`)}`);
  return false;
}

async function checkPm2(): Promise<boolean> {
  const result = await run(["npx", "pm2", "--version"]);
  if (result.ok) {
    console.log(`  ${PASS} PM2: v${result.stdout}`);
    return true;
  }
  console.log(`  ${FAIL} PM2 not found`);
  console.log(`      ${dim("Install: npm install -g pm2")}`);
  return false;
}

async function installService(config: ServiceDef): Promise<boolean> {
  if (config.cron) {
    if (process.platform === "win32") {
      return installWindowsScheduledTask(config);
    }
    // Linux: show cron instructions
    console.log(`  ${PASS} ${config.name}: add to crontab manually`);
    console.log(`      ${dim(`${config.cron} cd ${PROJECT_ROOT} && bun run ${config.script}`)}`);
    return true;
  }

  // Always-on service — use PM2
  // Stop existing first
  await run(["npx", "pm2", "delete", config.name]);

  // Use "pm2 start bun -- run <script>" to avoid PM2's broken Bun container
  // which uses require() and fails on async modules (top-level await)
  const result = await run([
    "npx", "pm2", "start", "bun",
    "--name", config.name,
    "--cwd", PROJECT_ROOT,
    "-o", join(LOGS_DIR, `${config.name}.log`),
    "-e", join(LOGS_DIR, `${config.name}.error.log`),
    "--", "run", config.script,
  ]);

  if (result.ok) {
    console.log(`  ${PASS} ${config.name} started — ${config.description}`);
    return true;
  }
  console.log(`  ${FAIL} Failed to start ${config.name}: ${result.stderr}`);
  return false;
}

async function main() {
  if (process.platform === "darwin") {
    console.log(`\n  You're on macOS. Use launchd instead:`);
    console.log(`      ${dim("bun run setup/configure-launchd.ts")}`);
    process.exit(0);
  }

  // Parse --service flag
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : "relay";
  const toInstall = serviceArg === "all" ? Object.keys(SERVICES) : [serviceArg];

  console.log("");
  console.log(bold("  Configure Services (PM2)"));
  console.log("");

  const pm2Ok = await checkPm2();
  if (!pm2Ok) process.exit(1);

  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  console.log("");
  for (const name of toInstall) {
    const config = SERVICES[name];
    if (!config) {
      console.log(`  ${FAIL} Unknown service: ${name}`);
      continue;
    }
    await installService(config);
  }

  // Save PM2 config for auto-restart on reboot
  await run(["npx", "pm2", "save"]);
  console.log("");

  if (process.platform === "win32") {
    // pm2 startup doesn't work on Windows — use the Startup folder instead
    console.log(`  ${bold("Auto-start on boot (Windows):")}`);
    const pm2Path = (await run(["where", "pm2.cmd"])).stdout.split("\n")[0]?.trim();
    if (pm2Path) {
      const startupDir = join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
      const vbsPath = join(startupDir, "pm2-startup.vbs");
      const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "cmd /c ""${pm2Path}"" resurrect", 0, False\n`;
      await Bun.write(vbsPath, vbsContent);
      console.log(`  ${PASS} PM2 auto-start configured (Windows Startup folder)`);
      console.log(`      ${dim(vbsPath)}`);
    } else {
      console.log(`  ${FAIL} Could not find pm2.cmd — auto-start not configured`);
      console.log(`      ${dim("Ensure PM2 is installed globally: npm install -g pm2")}`);
    }
  } else {
    console.log(`  ${dim("Auto-start on boot:")} npx pm2 startup`);
  }

  console.log(`  ${dim("Check status:")}        npx pm2 status`);
  console.log(`  ${dim("View logs:")}           npx pm2 logs`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
