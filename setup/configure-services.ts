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
  cron?: string | string[];
  description: string;
}

const SERVICES: Record<string, ServiceDef> = {
  relay: {
    name: "claude-telegram-relay",
    script: "src/relay.ts",
    description: "Main bot (always running)",
  },
  checkin: {
    name: "claude-smart-checkin",
    script: "examples/smart-checkin.ts",
    cron: [
      "0 9-17 * * 1-5",   // Weekdays: hourly 9am-5pm (9 times)
      "0 12 * * 0,6",     // Weekends: noon only
    ],
    description: "Smart check-ins (hourly 9am-5pm weekdays, noon weekends)",
  },
  briefing: {
    name: "claude-morning-briefing",
    script: "examples/morning-briefing.ts",
    cron: "0 9 * * *",
    description: "Morning briefing (daily at 9am)",
  },
  "inbox-cleanup": {
    name: "claude-inbox-cleanup",
    script: "examples/inbox-cleanup.ts",
    cron: "0 10 * * 1-5",
    description: "Inbox spam cleanup (daily at 10am, weekdays)",
  },
  recap: {
    name: "claude-friday-recap",
    script: "examples/friday-recap.ts",
    cron: "30 16 * * 5",
    description: "Friday weekly recap (Fridays at 4:30pm)",
  },
};

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

async function startPm2(name: string, script: string, cronExpr?: string): Promise<boolean> {
  // Stop existing first
  await run(["npx", "pm2", "delete", name]);

  const args = [
    "npx", "pm2", "start", "bun",
    "--name", name,
    "--cwd", PROJECT_ROOT,
    "-o", join(LOGS_DIR, `${name}.log`),
    "-e", join(LOGS_DIR, `${name}.error.log`),
  ];

  if (cronExpr) {
    // Scheduled service: --cron-restart triggers at the cron time,
    // --no-autorestart prevents PM2 from restarting it in between
    args.push("--cron-restart", cronExpr, "--no-autorestart");
  }

  args.push("--", "run", script);
  return (await run(args)).ok;
}

async function installService(config: ServiceDef): Promise<boolean> {
  if (config.cron) {
    // Scheduled service — use PM2 --cron-restart
    const crons = Array.isArray(config.cron) ? config.cron : [config.cron];

    let allOk = true;
    for (let i = 0; i < crons.length; i++) {
      // Multiple cron expressions get suffixed: name-weekday, name-weekend, etc.
      const suffix = crons.length > 1 ? `-${i + 1}` : "";
      const pmName = `${config.name}${suffix}`;
      const ok = await startPm2(pmName, config.script, crons[i]);
      if (ok) {
        console.log(`  ${PASS} ${pmName} scheduled — ${dim(crons[i])}`);
      } else {
        console.log(`  ${FAIL} Failed to start ${pmName}`);
        allOk = false;
      }
    }
    return allOk;
  }

  // Always-on service
  const ok = await startPm2(config.name, config.script);
  if (ok) {
    console.log(`  ${PASS} ${config.name} started — ${config.description}`);
  } else {
    console.log(`  ${FAIL} Failed to start ${config.name}`);
  }
  return ok;
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
  console.log(`  ${dim("Auto-start on boot:")} npx pm2 startup`);
  console.log(`  ${dim("Check status:")}        npx pm2 status`);
  console.log(`  ${dim("View logs:")}           npx pm2 logs`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
