/**
 * Brave Search Module
 *
 * Calls the Brave Search API directly from the relay,
 * bypassing MCP to avoid Bun crashes on Windows ARM64.
 *
 * Returns formatted search results that get injected into
 * the Claude prompt as context.
 */

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveApiResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

/**
 * Detect if a user message likely needs a web search.
 * Returns true for questions about current events, facts, etc.
 */
export function needsSearch(message: string): boolean {
  if (!BRAVE_API_KEY) return false;

  const lower = message.toLowerCase();

  const searchPatterns = [
    // Current events / news
    /\b(hoje|today|yesterday|ontem|this week|esta semana|latest|últim|notícia|news)\b/i,
    // Sports
    /\b(jogou|jogaram|placar|score|game|jogo|partida|match|ganhou|perdeu|won|lost|campeonato|championship|standings|classificação)\b/i,
    // Lookups / research
    /\b(what is|what are|who is|who are|when did|when is|where is|how to|how much|how many)\b/i,
    /\b(o que é|quem é|quando|onde fica|como|quanto|quantos)\b/i,
    /\b(qué es|quién es|cuándo|dónde|cómo|cuánto)\b/i,
    // Weather
    /\b(weather|clima|tempo|previsão|forecast|temperature|temperatura)\b/i,
    // Prices / stocks / crypto
    /\b(price|preço|cotação|stock|ação|bitcoin|crypto|dólar|dollar|euro|exchange rate|câmbio)\b/i,
    // Search verbs
    /\b(search|buscar|pesquisar|procurar|look up|find out|google)\b/i,
    // Explicit internet request
    /\b(internet|online|web|site|website)\b/i,
  ];

  return searchPatterns.some((p) => p.test(lower));
}

/**
 * Extract a clean search query from a user message.
 * Removes conversational fluff and keeps the searchable part.
 */
function extractSearchQuery(message: string): string {
  let q = message
    // Remove common conversational prefixes
    .replace(/^(vamos l[aá]|ok|tudo bem|pronto|hey|oi|ol[aá]|hi|hello|please|por favor)[.,!?\s]*/i, "")
    // Remove trailing punctuation clutter
    .replace(/[.!]+$/, "")
    .trim();

  // If too short after cleanup, use the original
  if (q.length < 3) q = message.trim();

  return q;
}

/**
 * Search the web using Brave Search API.
 * Returns formatted context string for injection into Claude's prompt.
 */
export async function searchWeb(query: string, count: number = 5): Promise<string> {
  if (!BRAVE_API_KEY) {
    return "";
  }

  try {
    const cleanQuery = extractSearchQuery(query);
    console.log(`Brave search query: "${cleanQuery}"`);

    const params = new URLSearchParams({
      q: cleanQuery,
      count: count.toString(),
      text_decorations: "false",
    });

    const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
    });

    if (!response.ok) {
      console.error(`Brave Search error: ${response.status} ${response.statusText}`);
      return "";
    }

    const data = (await response.json()) as BraveApiResponse;
    const results: BraveSearchResult[] = (data.web?.results || [])
      .filter((r) => r.title && r.description)
      .map((r) => ({
        title: r.title!,
        url: r.url || "",
        description: r.description!,
      }));

    if (results.length === 0) {
      return "";
    }

    const formatted = results
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.description}\n   ${r.url}`)
      .join("\n\n");

    return `WEB SEARCH RESULTS for "${query}":\n\n${formatted}`;
  } catch (error) {
    console.error("Brave Search error:", error);
    return "";
  }
}
