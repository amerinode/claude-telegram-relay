/**
 * Morning Briefing Example
 *
 * Sends a daily summary via Telegram at a scheduled time.
 * Customize this for your own morning routine.
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/morning-briefing.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run examples/morning-briefing.ts
 */

import {
  getFinancialsFromSupabase,
  getReservations,
  listProperties,
} from "../src/hospitable";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";

// ============================================================
// TELEGRAM HELPER
// ============================================================

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
          parse_mode: "Markdown",
        }),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// DATA FETCHERS (customize these for your sources)
// ============================================================

async function getUnreadEmails(): Promise<string> {
  // Example: Use Gmail API, IMAP, or MCP tool
  // Return a summary of unread emails

  // Placeholder - replace with your implementation
  return "- 3 unread emails (1 urgent from client)";
}

async function getCalendarEvents(): Promise<string> {
  // Example: Use Google Calendar API or MCP tool
  // Return today's events

  // Placeholder
  return "- 10:00 Team standup\n- 14:00 Client call";
}

async function getActiveGoals(): Promise<string> {
  // Load from your persistence layer (Supabase, JSON file, etc.)

  // Placeholder
  return "- Finish video edit\n- Review PR";
}

async function getWeather(): Promise<string> {
  // Optional: Weather API

  // Placeholder
  return "Sunny, 22°C";
}

async function getAINews(): Promise<string> {
  // Optional: Pull from X/Twitter, RSS, or news API
  // Use Grok, Perplexity, or web search

  // Placeholder
  return "- OpenAI released GPT-5\n- Anthropic launches new feature";
}

async function getAirbnbSummary(): Promise<string> {
  if (process.env.HOSPITABLE_ENABLED !== "true") return "";

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  const startDate = new Date(year, month, 1).toISOString().split("T")[0];
  const endDate = new Date(year, month + 1, 0).toISOString().split("T")[0];
  const today = now.toISOString().split("T")[0];
  const in7days = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];

  const monthLabel = now.toLocaleDateString("en-US", { month: "long" });

  // Fetch financials + upcoming reservations in parallel
  const properties = await listProperties();
  const propertyIds = properties.map((p) => p.id);

  const [financials, upcoming] = await Promise.all([
    getFinancialsFromSupabase(startDate, endDate),
    getReservations({
      propertyIds,
      startDate: today,
      endDate: in7days,
      status: ["accepted"],
      perPage: 20,
    }),
  ]);

  const lines: string[] = [];

  // Month-to-date earnings by property
  if (financials.reservations.length) {
    const byProperty: Record<string, { totalCents: number; currency: string; count: number }> = {};
    for (const tx of financials.reservations) {
      const prop = tx.property_name || "Unknown";
      if (!byProperty[prop]) byProperty[prop] = { totalCents: 0, currency: tx.currency, count: 0 };
      byProperty[prop].totalCents += tx.amount_cents;
      byProperty[prop].count++;
    }

    lines.push(`*${monthLabel} Earnings (MTD):*`);
    let grandTotal = 0;
    for (const [prop, data] of Object.entries(byProperty)) {
      const fmt = data.currency === "BRL"
        ? `R$${(data.totalCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
        : `$${(data.totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
      lines.push(`  ${prop}: ${fmt} (${data.count} res)`);
      grandTotal += data.totalCents;
    }
    if (Object.keys(byProperty).length > 1) {
      const currency = financials.reservations[0]?.currency || "BRL";
      const fmtGrand = currency === "BRL"
        ? `R$${(grandTotal / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
        : `$${(grandTotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
      lines.push(`  *Total: ${fmtGrand}*`);
    }
  } else {
    lines.push(`*${monthLabel} Earnings:* No data yet`);
  }

  // Payouts MTD
  if (financials.payouts.length) {
    let payoutTotal = 0;
    for (const p of financials.payouts) payoutTotal += p.amount_cents;
    const currency = financials.payouts[0]?.currency || "USD";
    const fmtPayout = currency === "BRL"
      ? `R$${(payoutTotal / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
      : `$${(payoutTotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    lines.push(`*Payouts received:* ${fmtPayout} (${financials.payouts.length} transfers)`);
  }

  // Upcoming check-ins/outs (next 7 days)
  if (upcoming.length) {
    lines.push("");
    lines.push("*Next 7 days:*");
    for (const r of upcoming.sort(
      (a, b) => new Date(a.arrivalDate).getTime() - new Date(b.arrivalDate).getTime()
    )) {
      const arrival = new Date(r.arrivalDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const departure = new Date(r.departureDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const isToday = r.arrivalDate.split("T")[0] === today;
      const checkoutToday = r.departureDate.split("T")[0] === today;
      let tag = "";
      if (isToday) tag = " CHECK-IN TODAY";
      else if (checkoutToday) tag = " CHECKOUT TODAY";
      lines.push(`  ${arrival}–${departure}: ${r.guestName} @ ${r.propertyName} (${r.nights}n)${tag}`);
    }
  } else {
    lines.push("\n*Next 7 days:* No upcoming reservations");
  }

  return lines.join("\n");
}

// ============================================================
// BUILD BRIEFING
// ============================================================

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const sections: string[] = [];

  // Header
  sections.push(`🌅 **Good Morning!**\n${dateStr}\n`);

  // Weather (optional)
  try {
    const weather = await getWeather();
    sections.push(`☀️ **Weather**\n${weather}\n`);
  } catch (e) {
    console.error("Weather fetch failed:", e);
  }

  // Calendar
  try {
    const calendar = await getCalendarEvents();
    if (calendar) {
      sections.push(`📅 **Today's Schedule**\n${calendar}\n`);
    }
  } catch (e) {
    console.error("Calendar fetch failed:", e);
  }

  // Emails
  try {
    const emails = await getUnreadEmails();
    if (emails) {
      sections.push(`📧 **Inbox**\n${emails}\n`);
    }
  } catch (e) {
    console.error("Email fetch failed:", e);
  }

  // Goals
  try {
    const goals = await getActiveGoals();
    if (goals) {
      sections.push(`🎯 **Active Goals**\n${goals}\n`);
    }
  } catch (e) {
    console.error("Goals fetch failed:", e);
  }

  // AI News (optional)
  try {
    const news = await getAINews();
    if (news) {
      sections.push(`🤖 **AI News**\n${news}\n`);
    }
  } catch (e) {
    console.error("News fetch failed:", e);
  }

  // Airbnb / Hospitable
  try {
    const airbnb = await getAirbnbSummary();
    if (airbnb) {
      sections.push(`🏠 **Airbnb**\n${airbnb}\n`);
    }
  } catch (e) {
    console.error("Airbnb summary failed:", e);
  }

  // Footer
  sections.push("---\n_Reply to chat or say \"call me\" for voice briefing_");

  return sections.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const briefing = await buildBriefing();

  console.log("Sending briefing...");
  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent successfully!");
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main();

// ============================================================
// LAUNCHD PLIST FOR SCHEDULING (macOS)
// ============================================================
/*
Save this as ~/Library/LaunchAgents/com.claude.morning-briefing.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.morning-briefing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/morning-briefing.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-telegram-relay</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/morning-briefing.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/morning-briefing.error.log</string>
</dict>
</plist>

Load with: launchctl load ~/Library/LaunchAgents/com.claude.morning-briefing.plist
*/

// ============================================================
// CRON FOR SCHEDULING (Linux)
// ============================================================
/*
Add to crontab with: crontab -e

# Run at 9:00 AM every day
0 9 * * * cd /path/to/claude-telegram-relay && /home/USER/.bun/bin/bun run examples/morning-briefing.ts >> /tmp/morning-briefing.log 2>&1
*/
