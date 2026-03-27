/**
 * Notion — Direct API Client
 *
 * Creates meeting summary pages in a Notion database.
 * Uses fetch() directly against api.notion.com (no SDK dependency).
 *
 * Requires:
 *   NOTION_API_KEY        — Internal integration token (ntn_...)
 *   NOTION_MEETINGS_DB_ID — Database ID from Notion URL
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function getHeaders(): Record<string, string> {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error("NOTION_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

// ============================================================
// TYPES
// ============================================================

export interface MeetingPageData {
  subject: string;
  date: string;          // ISO datetime
  endDate?: string;      // ISO datetime
  attendees?: string;    // Comma-separated names
  organizer?: string;
  duration?: string;     // e.g. "45 min"
  summary: string;
  actionItems?: string;
  decisions?: string;
  fullTranscript?: string; // Optional: stored in page body
}

// ============================================================
// API HELPERS
// ============================================================

async function notionRequest(path: string, body: unknown): Promise<any> {
  const resp = await fetch(`${NOTION_API}${path}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Notion API error (${resp.status}): ${err.substring(0, 300)}`);
  }

  return resp.json();
}

/**
 * Convert plain text to Notion rich_text blocks, splitting at 2000 char limit.
 */
function toRichText(text: string): Array<{ type: "text"; text: { content: string } }> {
  const chunks: Array<{ type: "text"; text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ type: "text", text: { content: text.substring(i, i + 2000) } });
  }
  return chunks.length ? chunks : [{ type: "text", text: { content: "" } }];
}

/**
 * Convert text to Notion paragraph blocks for page body content.
 * Splits by newlines into separate paragraphs.
 */
function toBodyBlocks(text: string): Array<Record<string, unknown>> {
  return text.split("\n").filter(Boolean).map(line => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: toRichText(line),
    },
  }));
}

// ============================================================
// MEETING PAGE CREATION
// ============================================================

/**
 * Create a meeting summary page in the Notion meetings database.
 */
export async function createMeetingPage(data: MeetingPageData): Promise<{ id: string; url: string }> {
  const dbId = process.env.NOTION_MEETINGS_DB_ID;
  if (!dbId) throw new Error("NOTION_MEETINGS_DB_ID not set");

  // Build properties
  const properties: Record<string, unknown> = {
    // Title property (required — Notion databases always have one title property)
    Name: {
      title: toRichText(data.subject),
    },
    Date: {
      date: {
        start: data.date,
        end: data.endDate || undefined,
      },
    },
  };

  // Optional text properties
  if (data.attendees) {
    properties["Attendees"] = { rich_text: toRichText(data.attendees) };
  }
  if (data.organizer) {
    properties["Organizer"] = { rich_text: toRichText(data.organizer) };
  }
  if (data.duration) {
    properties["Duration"] = { rich_text: toRichText(data.duration) };
  }
  if (data.summary) {
    properties["Summary"] = { rich_text: toRichText(data.summary) };
  }
  if (data.actionItems) {
    properties["Action Items"] = { rich_text: toRichText(data.actionItems) };
  }
  if (data.decisions) {
    properties["Decisions"] = { rich_text: toRichText(data.decisions) };
  }

  // Build page body content blocks
  const children: Array<Record<string, unknown>> = [];

  // Summary heading + content
  if (data.summary) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: toRichText("Summary") },
    });
    children.push(...toBodyBlocks(data.summary));
  }

  // Action Items
  if (data.actionItems) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: toRichText("Action Items") },
    });
    children.push(...toBodyBlocks(data.actionItems));
  }

  // Decisions
  if (data.decisions) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: toRichText("Decisions") },
    });
    children.push(...toBodyBlocks(data.decisions));
  }

  // Full transcript (collapsed in a toggle if available)
  if (data.fullTranscript) {
    // Notion limits children array to 100 blocks per request
    const transcriptLines = data.fullTranscript.split("\n").filter(Boolean).slice(0, 90);
    children.push({
      object: "block",
      type: "toggle",
      toggle: {
        rich_text: toRichText("Full Transcript"),
        children: transcriptLines.map(line => ({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: toRichText(line) },
        })),
      },
    });
  }

  const result = await notionRequest("/pages", {
    parent: { database_id: dbId },
    properties,
    children: children.slice(0, 100), // Notion limit
  });

  return { id: result.id, url: result.url };
}

/**
 * Check if Notion integration is configured.
 */
export function isNotionEnabled(): boolean {
  return !!(process.env.NOTION_API_KEY && process.env.NOTION_MEETINGS_DB_ID);
}
