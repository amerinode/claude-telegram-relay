/**
 * Search Module — Brave Search + Kiwi Tequila Flight API
 *
 * Brave Search: general web queries, deal blogs, mistake fares
 * Kiwi Tequila: real-time flight pricing with booking links
 *
 * Both called directly from the relay (no MCP) to avoid
 * Bun crashes on Windows ARM64.
 */

// ─── Brave Search ───────────────────────────────────────────

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

// ─── Kiwi Tequila Flight API ────────────────────────────────

const TEQUILA_API_KEY = process.env.TEQUILA_API_KEY || "";
const TEQUILA_BASE = "https://api.tequila.kiwi.com";

interface TequilaRoute {
  airline: string;
  flight_no: number;
  cityFrom: string;
  cityTo: string;
  flyFrom: string;
  flyTo: string;
  local_departure: string;
  local_arrival: string;
  return: number; // 0 = outbound, 1 = return leg
}

interface TequilaFlight {
  price: number;
  airlines: string[];
  deep_link: string;
  duration: { departure: number; return: number; total: number };
  route: TequilaRoute[];
  bags_price: Record<string, number>;
  availability: { seats: number | null };
  flyFrom: string;
  flyTo: string;
  cityFrom: string;
  cityTo: string;
  local_departure: string;
  local_arrival: string;
  nightsInDest: number | null;
}

interface TequilaSearchResponse {
  data: TequilaFlight[];
  currency: string;
}

interface ParsedFlightQuery {
  origin: string | null;
  destination: string | null;
  dateFrom: string | null; // DD/MM/YYYY
  dateTo: string | null;
  returnFrom: string | null;
  returnTo: string | null;
  isRoundTrip: boolean;
}

/**
 * Common city → IATA code map.
 * Avoids API calls for Gil's frequent routes and well-known cities.
 */
const IATA_CODES: Record<string, string> = {
  // Brazil
  "sao paulo": "SAO", "são paulo": "SAO", "sp": "SAO", "sampa": "SAO",
  "guarulhos": "GRU", "gru": "GRU", "congonhas": "CGH",
  "rio": "GIG", "rio de janeiro": "GIG",
  "brasilia": "BSB", "brasília": "BSB",
  "belo horizonte": "CNF", "bh": "CNF",
  "recife": "REC", "salvador": "SSA", "fortaleza": "FOR",
  "curitiba": "CWB", "porto alegre": "POA", "florianopolis": "FLN",
  "manaus": "MAO", "belem": "BEL", "belém": "BEL",
  "campinas": "VCP", "viracopos": "VCP",
  // USA
  "miami": "MIA", "fort lauderdale": "FLL", "fll": "FLL",
  "new york": "NYC", "nyc": "NYC", "jfk": "JFK", "newark": "EWR",
  "los angeles": "LAX", "la": "LAX",
  "chicago": "ORD", "san francisco": "SFO", "sf": "SFO",
  "boston": "BOS", "dallas": "DFW", "houston": "IAH",
  "atlanta": "ATL", "washington": "WAS", "dc": "WAS",
  "orlando": "MCO", "tampa": "TPA", "seattle": "SEA",
  "las vegas": "LAS", "denver": "DEN", "phoenix": "PHX",
  "philadelphia": "PHL", "charlotte": "CLT",
  // Latin America
  "mexico city": "MEX", "ciudad de mexico": "MEX",
  "bogota": "BOG", "bogotá": "BOG",
  "buenos aires": "BUE", "santiago": "SCL",
  "lima": "LIM", "panama city": "PTY", "panama": "PTY",
  "medellin": "MDE", "medellín": "MDE",
  "cancun": "CUN", "cancún": "CUN",
  "havana": "HAV", "san juan": "SJU",
  // Europe
  "london": "LON", "paris": "PAR", "madrid": "MAD",
  "lisbon": "LIS", "lisboa": "LIS",
  "rome": "ROM", "roma": "ROM",
  "barcelona": "BCN", "amsterdam": "AMS",
  "frankfurt": "FRA", "berlin": "BER", "munich": "MUC",
  "zurich": "ZRH", "geneva": "GVA", "vienna": "VIE",
  "brussels": "BRU", "dublin": "DUB", "milan": "MIL",
  "porto": "OPO",
  // Middle East / Asia / Other
  "dubai": "DXB", "doha": "DOH", "istanbul": "IST",
  "tokyo": "TYO", "singapore": "SIN", "hong kong": "HKG",
  "sydney": "SYD", "cape town": "CPT", "johannesburg": "JNB",
};

const IATA_PATTERN = /^[A-Z]{3}$/;

// ─── Detection Functions ────────────────────────────────────

/**
 * Detect if a user message likely needs a web search.
 */
export function needsSearch(message: string): boolean {
  if (!BRAVE_API_KEY) return false;

  const lower = message.toLowerCase();

  const searchPatterns = [
    /\b(hoje|today|yesterday|ontem|this week|esta semana|latest|últim|notícia|news)\b/i,
    /\b(jogou|jogaram|placar|score|game|jogo|partida|match|ganhou|perdeu|won|lost|campeonato|championship|standings|classificação)\b/i,
    /\b(what is|what are|who is|who are|when did|when is|where is|how to|how much|how many)\b/i,
    /\b(o que é|quem é|quando|onde fica|como|quanto|quantos)\b/i,
    /\b(qué es|quién es|cuándo|dónde|cómo|cuánto)\b/i,
    /\b(weather|clima|tempo|previsão|forecast|temperature|temperatura)\b/i,
    /\b(price|preço|cotação|stock|ação|bitcoin|crypto|dólar|dollar|euro|exchange rate|câmbio)\b/i,
    /\b(search|buscar|pesquisar|procurar|look up|find out|google)\b/i,
    /\b(internet|online|web|site|website)\b/i,
    /\b(company|empresa|companhia|briefing|report|relatório|competitor|concorrente|industry|indústria)\b/i,
    /\b(telefone|phone|contact|contato|address|endereço|horário|hours|opening|location|localização|loja|store|shop)\b/i,
    /\b(me passe|me dê|me envie|me mande|give me|find me|get me|send me)\b/i,
  ];

  return searchPatterns.some((p) => p.test(lower));
}

/**
 * Extract a clean search query from a user message.
 */
function extractSearchQuery(message: string): string {
  let q = message
    .replace(/^(vamos l[aá]|ok|tudo bem|pronto|hey|oi|ol[aá]|hi|hello|please|por favor)[.,!?\s]*/i, "")
    .replace(/[.!]+$/, "")
    .trim();

  if (q.length < 3) q = message.trim();
  return q;
}

/**
 * Detect /flights command
 */
export function isFlightSearch(message: string): boolean {
  return /^\/flights\b/i.test(message.trim());
}

/**
 * Detect /hotels command
 */
export function isHotelSearch(message: string): boolean {
  return /^\/hotels\b/i.test(message.trim());
}

// ─── IATA Code Resolution ───────────────────────────────────

/**
 * Resolve a city name or code to an IATA code.
 * 1. If already a 3-letter uppercase code, return as-is
 * 2. Check hardcoded IATA_CODES map
 * 3. Fall back to Tequila locations API
 */
async function resolveIataCode(term: string): Promise<string | null> {
  const cleaned = term.trim();
  if (!cleaned) return null;

  // Already an IATA code?
  if (IATA_PATTERN.test(cleaned)) return cleaned;

  // Check hardcoded map
  const lower = cleaned.toLowerCase();
  if (IATA_CODES[lower]) return IATA_CODES[lower];

  // Fall back to Tequila locations API
  if (!TEQUILA_API_KEY) return null;

  try {
    const params = new URLSearchParams({
      term: cleaned,
      location_types: "city",
      limit: "1",
    });
    const res = await fetch(`${TEQUILA_BASE}/locations/query?${params}`, {
      headers: { apikey: TEQUILA_API_KEY },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const locations = data.locations as Array<{ id: string; name: string }>;
    if (locations.length > 0) {
      console.log(`Tequila resolved "${cleaned}" → ${locations[0].id} (${locations[0].name})`);
      return locations[0].id;
    }
    return null;
  } catch (err) {
    console.error("Tequila location resolve error:", err);
    return null;
  }
}

// ─── Flight Query Parsing ───────────────────────────────────

/**
 * Parse natural language flight query into structured data.
 *
 * Handles: "São Paulo to Miami", "GRU MIA March 15",
 *          "SP Miami round trip next week", etc.
 */
function parseFlightQuery(query: string): ParsedFlightQuery {
  const details = query.replace(/^\/flights\s*/i, "").trim();

  const result: ParsedFlightQuery = {
    origin: null,
    destination: null,
    dateFrom: null,
    dateTo: null,
    returnFrom: null,
    returnTo: null,
    isRoundTrip: false,
  };

  if (!details) return result;

  // Detect round trip keywords
  result.isRoundTrip = /\b(round\s*trip|ida\s*e\s*volta|rt|return|volta|roundtrip)\b/i.test(details);

  // Clean out round trip keywords for parsing
  let cleaned = details
    .replace(/\b(round\s*trip|ida\s*e\s*volta|rt|roundtrip)\b/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // Strategy 1: "City to City [date]" — most common pattern
  const toPattern = /^(.+?)\s+(?:to|para|a|→|->|-->|–|pra)\s+(.+?)(?:\s+(?:on|em|in|for|around|dia|date|returning)\s+(.+))?$/i;
  // Strategy 2: "CODE CODE [date]" — two IATA codes
  const codePattern = /^([A-Z]{3})\s+([A-Z]{3})(?:\s+(.+))?$/;
  // Strategy 3: "CODE City [date]" or "City CODE [date]"
  const mixedPattern1 = /^([A-Z]{3})\s+(.+?)(?:\s+(?:on|em|in|for|around|dia)\s+(.+))?$/i;
  const mixedPattern2 = /^(.+?)\s+([A-Z]{3})(?:\s+(.+))?$/i;

  let origin: string | null = null;
  let destination: string | null = null;
  let dateStr: string | null = null;

  const toMatch = cleaned.match(toPattern);
  const codeMatch = cleaned.match(codePattern);

  if (toMatch) {
    origin = toMatch[1].trim();
    destination = toMatch[2].trim();
    dateStr = toMatch[3]?.trim() || null;
  } else if (codeMatch) {
    origin = codeMatch[1];
    destination = codeMatch[2];
    dateStr = codeMatch[3]?.trim() || null;
  } else {
    // Try mixed patterns
    const mix1 = cleaned.match(mixedPattern1);
    const mix2 = cleaned.match(mixedPattern2);
    if (mix1) {
      origin = mix1[1];
      destination = mix1[2].trim();
      dateStr = mix1[3]?.trim() || null;
    } else if (mix2) {
      origin = mix2[1].trim();
      destination = mix2[2];
      dateStr = mix2[3]?.trim() || null;
    } else {
      // Last resort: split on spaces, first token origin, second destination
      const tokens = cleaned.split(/\s+/);
      if (tokens.length >= 2) {
        origin = tokens[0];
        destination = tokens[1];
        dateStr = tokens.slice(2).join(" ") || null;
      }
    }
  }

  result.origin = origin;
  result.destination = destination;

  // Parse dates if present
  if (dateStr) {
    const dates = parseDateRange(dateStr);
    result.dateFrom = dates.from;
    result.dateTo = dates.to;
  }

  return result;
}

/**
 * Parse natural language date references into DD/MM/YYYY ranges.
 *
 * "March 15" → ±3 days around that date
 * "next week" / "semana que vem" → Mon–Sun
 * "next month" → full month
 * Default: today + 30 days
 */
function parseDateRange(dateStr: string): { from: string; to: string } {
  const now = new Date();
  const formatDate = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

  const lower = dateStr.toLowerCase().trim();

  // "next week" / "semana que vem"
  if (/next\s*week|semana\s*que\s*vem|pr[oó]xima\s*semana/i.test(lower)) {
    const monday = new Date(now);
    const daysUntilMon = ((8 - now.getDay()) % 7) || 7;
    monday.setDate(now.getDate() + daysUntilMon);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from: formatDate(monday), to: formatDate(sunday) };
  }

  // "next month" / "mês que vem"
  if (/next\s*month|m[eê]s\s*que\s*vem|pr[oó]ximo\s*m[eê]s/i.test(lower)) {
    const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    return { from: formatDate(first), to: formatDate(last) };
  }

  // "this week" / "esta semana"
  if (/this\s*week|esta\s*semana/i.test(lower)) {
    const endOfWeek = new Date(now);
    endOfWeek.setDate(now.getDate() + (7 - now.getDay()));
    return { from: formatDate(now), to: formatDate(endOfWeek) };
  }

  // Try "Month Day" or "Day Month" or "Day de Month"
  const monthNames: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    janeiro: 0, fevereiro: 1, março: 2, marco: 2, abril: 3, maio: 4, junho: 5,
    julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
  };

  // "March 15" or "March 15-20"
  const monthDayRange = lower.match(/(\w+)\s+(\d{1,2})\s*[-–to]+\s*(\d{1,2})/);
  if (monthDayRange && monthNames[monthDayRange[1]] !== undefined) {
    const month = monthNames[monthDayRange[1]];
    const dayFrom = parseInt(monthDayRange[2]);
    const dayTo = parseInt(monthDayRange[3]);
    let from = new Date(now.getFullYear(), month, dayFrom);
    let to = new Date(now.getFullYear(), month, dayTo);
    if (from < now) { from.setFullYear(from.getFullYear() + 1); to.setFullYear(to.getFullYear() + 1); }
    return { from: formatDate(from), to: formatDate(to) };
  }

  // "March 15" (single date → ±3 days)
  const monthDay = lower.match(/(\w+)\s+(\d{1,2})/);
  if (monthDay && monthNames[monthDay[1]] !== undefined) {
    const month = monthNames[monthDay[1]];
    const day = parseInt(monthDay[2]);
    let target = new Date(now.getFullYear(), month, day);
    if (target < now) target.setFullYear(target.getFullYear() + 1);
    const from = new Date(target);
    from.setDate(from.getDate() - 3);
    if (from < now) from.setTime(now.getTime());
    const to = new Date(target);
    to.setDate(to.getDate() + 3);
    return { from: formatDate(from), to: formatDate(to) };
  }

  // "15 de março" / "15 March" (day before month)
  const dayMonth = lower.match(/(\d{1,2})\s+(?:de\s+)?(\w+)/);
  if (dayMonth && monthNames[dayMonth[2]] !== undefined) {
    const month = monthNames[dayMonth[2]];
    const day = parseInt(dayMonth[1]);
    let target = new Date(now.getFullYear(), month, day);
    if (target < now) target.setFullYear(target.getFullYear() + 1);
    const from = new Date(target);
    from.setDate(from.getDate() - 3);
    if (from < now) from.setTime(now.getTime());
    const to = new Date(target);
    to.setDate(to.getDate() + 3);
    return { from: formatDate(from), to: formatDate(to) };
  }

  // Just a month name: "March" → whole month
  for (const [name, month] of Object.entries(monthNames)) {
    if (lower === name || lower === `in ${name}` || lower === `em ${name}`) {
      let first = new Date(now.getFullYear(), month, 1);
      if (first < now) first.setFullYear(first.getFullYear() + 1);
      const last = new Date(first.getFullYear(), month + 1, 0);
      return { from: formatDate(first), to: formatDate(last) };
    }
  }

  // Default: today + 30 days
  const defaultTo = new Date(now);
  defaultTo.setDate(now.getDate() + 30);
  return { from: formatDate(now), to: formatDate(defaultTo) };
}

// ─── Flight Search ──────────────────────────────────────────

/**
 * Search for flights. Tries Kiwi Tequila API first (real prices),
 * falls back to Brave Search (deal blogs).
 */
export async function searchFlights(query: string): Promise<string> {
  const details = query.replace(/^\/flights\s*/i, "").trim();
  if (!details) return "";

  // Primary: Tequila API (real-time prices)
  if (TEQUILA_API_KEY) {
    try {
      const result = await searchFlightsTequila(query);
      if (result) {
        console.log("✅ Flight results from Kiwi Tequila API");
        return result;
      }
    } catch (err) {
      console.error("Tequila flight search failed, falling back to Brave:", err);
    }
  }

  // Fallback: Brave Search (blog posts, deal sites)
  console.log("⚠️ Using Brave Search fallback for flights");
  return searchFlightsBrave(query);
}

/**
 * Search flights using the Kiwi Tequila API.
 * Returns formatted markdown string with real prices and booking links.
 */
async function searchFlightsTequila(query: string): Promise<string | null> {
  const parsed = parseFlightQuery(query);

  if (!parsed.origin || !parsed.destination) {
    console.log("Could not parse origin/destination from query");
    return null;
  }

  // Resolve both cities to IATA codes in parallel
  const [originCode, destCode] = await Promise.all([
    resolveIataCode(parsed.origin),
    resolveIataCode(parsed.destination),
  ]);

  if (!originCode || !destCode) {
    console.log(`Could not resolve IATA: "${parsed.origin}" → ${originCode}, "${parsed.destination}" → ${destCode}`);
    return null;
  }

  console.log(`Flight search: ${originCode} → ${destCode} (${parsed.isRoundTrip ? "round trip" : "one-way"})`);

  // Date defaults
  const now = new Date();
  const formatDate = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

  const defaultFrom = formatDate(now);
  const defaultTo = formatDate(new Date(now.getTime() + 30 * 86400000));

  // Build API params
  const params: Record<string, string> = {
    fly_from: originCode,
    fly_to: destCode,
    date_from: parsed.dateFrom || defaultFrom,
    date_to: parsed.dateTo || defaultTo,
    curr: "USD",
    sort: "price",
    limit: "8",
    max_stopovers: "2",
    flight_type: parsed.isRoundTrip ? "round" : "oneway",
    adults: "1",
    selected_cabins: "M",
  };

  // Round trip return dates
  if (parsed.isRoundTrip) {
    if (parsed.returnFrom && parsed.returnTo) {
      params.return_from = parsed.returnFrom;
      params.return_to = parsed.returnTo;
    } else {
      // Default: return 5-10 days after departure window
      const depTo = parsed.dateTo || defaultTo;
      const [dd, mm, yyyy] = depTo.split("/").map(Number);
      const depEnd = new Date(yyyy, mm - 1, dd);
      const retFrom = new Date(depEnd.getTime() + 5 * 86400000);
      const retTo = new Date(depEnd.getTime() + 10 * 86400000);
      params.return_from = formatDate(retFrom);
      params.return_to = formatDate(retTo);
      params.nights_in_dst_from = "3";
      params.nights_in_dst_to = "14";
    }
  }

  const searchParams = new URLSearchParams(params);
  const url = `${TEQUILA_BASE}/v2/search?${searchParams}`;
  console.log(`Tequila API call: ${url.replace(TEQUILA_API_KEY, "***")}`);

  const res = await fetch(url, {
    headers: { apikey: TEQUILA_API_KEY },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`Tequila API error: ${res.status} ${res.statusText} — ${errText}`);
    return null;
  }

  const data = (await res.json()) as TequilaSearchResponse;

  if (!data.data || data.data.length === 0) {
    return (
      `FLIGHT SEARCH RESULTS (Kiwi.com API — real-time pricing):\n` +
      `Route: ${originCode} → ${destCode}\n` +
      `Dates: ${params.date_from} to ${params.date_to}\n\n` +
      `No flights found for this route and date range. Suggest trying:\n` +
      `- Broader date range (e.g., "next month")\n` +
      `- Alternate airports (e.g., FLL instead of MIA)\n` +
      `- One-way instead of round trip`
    );
  }

  return formatTequilaResults(data.data, data.currency || "USD", originCode, destCode, params);
}

/**
 * Format Tequila API flight results as structured markdown for Claude.
 */
function formatTequilaResults(
  flights: TequilaFlight[],
  currency: string,
  origin: string,
  dest: string,
  params: Record<string, string>
): string {
  const formatDuration = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  };

  const formatDT = (iso: string): string => {
    const d = new Date(iso);
    const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${day} ${time}`;
  };

  const lines = flights.map((f, i) => {
    // Separate outbound and return legs
    const outbound = f.route.filter(r => r.return === 0);
    const returnLegs = f.route.filter(r => r.return === 1);
    const stops = outbound.length - 1;
    const stopText = stops === 0 ? "Direct ✈️" : `${stops} stop${stops > 1 ? "s" : ""}`;
    const airlines = [...new Set(f.airlines)].join(", ");

    const outboundSegs = outbound
      .map(r => `    ${r.flyFrom} → ${r.flyTo}  ${r.airline}${r.flight_no}  dep ${formatDT(r.local_departure)} → arr ${formatDT(r.local_arrival)}`)
      .join("\n");

    let returnSegs = "";
    if (returnLegs.length > 0) {
      const retStops = returnLegs.length - 1;
      const retStopText = retStops === 0 ? "Direct" : `${retStops} stop${retStops > 1 ? "s" : ""}`;
      returnSegs =
        `\n  Return (${retStopText}, ${formatDuration(f.duration.return)}):\n` +
        returnLegs
          .map(r => `    ${r.flyFrom} → ${r.flyTo}  ${r.airline}${r.flight_no}  dep ${formatDT(r.local_departure)} → arr ${formatDT(r.local_arrival)}`)
          .join("\n");
    }

    const bagPrice = f.bags_price?.["1"]
      ? ` | +$${Math.round(f.bags_price["1"])} checked bag`
      : "";
    const seats = f.availability?.seats
      ? ` | ${f.availability.seats} seats left`
      : "";

    return (
      `${i + 1}. **$${f.price}** — ${airlines} — ${stopText} — ${formatDuration(f.duration.departure)}${bagPrice}${seats}\n` +
      `  Outbound:\n${outboundSegs}` +
      returnSegs + "\n" +
      `  🔗 Book: ${f.deep_link}`
    );
  });

  const isRoundTrip = params.flight_type === "round";

  return (
    `FLIGHT SEARCH RESULTS (Kiwi.com API — real-time pricing):\n` +
    `Route: ${origin} → ${dest}${isRoundTrip ? " (round trip)" : " (one-way)"}\n` +
    `Dates: ${params.date_from} to ${params.date_to}${isRoundTrip ? ` | Return: ${params.return_from} to ${params.return_to}` : ""}\n` +
    `Currency: ${currency} | Sorted by price | Economy\n\n` +
    lines.join("\n\n")
  );
}

/**
 * Fallback: search flights using Brave Search (returns blog posts and deals).
 */
async function searchFlightsBrave(query: string): Promise<string> {
  if (!BRAVE_API_KEY) return "";

  const details = query.replace(/^\/flights\s*/i, "").trim();
  if (!details) return "";

  const searches = [
    searchWeb(`cheap flights ${details} best deals ${new Date().getFullYear()}`, 5),
    searchWeb(`mistake fares flash sales flights ${details}`, 4),
    searchWeb(`cheapest dates to fly ${details} price trends`, 4),
    searchWeb(`alternate airports hidden city flights ${details}`, 3),
  ];

  const results = await Promise.all(searches);
  const combined = results.filter(Boolean).join("\n\n---\n\n");

  return combined
    ? `FLIGHT SEARCH RESULTS (Web search — approximate, not real-time):\n\n${combined}`
    : "";
}

// ─── Hotel Search ───────────────────────────────────────────

/**
 * Multi-search for hotel deals and local restaurants.
 */
export async function searchHotels(query: string): Promise<string> {
  if (!BRAVE_API_KEY) return "";

  const details = query.replace(/^\/hotels\s*/i, "").trim();
  if (!details) return "";

  const searches = [
    searchWeb(`best budget hotels ${details} near center ${new Date().getFullYear()}`, 5),
    searchWeb(`best Airbnb ${details} central location deals`, 4),
    searchWeb(`best cheap local restaurants ${details} locals favorite`, 4),
  ];

  const results = await Promise.all(searches);
  const combined = results.filter(Boolean).join("\n\n---\n\n");

  return combined
    ? `HOTEL & DINING SEARCH RESULTS:\n\n${combined}`
    : "";
}

// ─── Web Search ─────────────────────────────────────────────

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
