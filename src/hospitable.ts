/**
 * Hospitable — Airbnb Guest Messaging Integration
 *
 * Connects to Hospitable's Public API v2 to manage Airbnb guest communication.
 * Uses Personal Access Token (PAT) authentication.
 *
 * Features:
 *   - List properties and reservations
 *   - Read and send guest messages
 *   - Detect Hospitable-related user intents
 *   - Format webhook payloads for Telegram
 *   - Generate auto-draft replies via Claude
 */

// ============================================================
// CONFIGURATION
// ============================================================

const API_BASE = "https://public.api.hospitable.com/v2";
const API_KEY = process.env.HOSPITABLE_API_KEY || "";

// Cache for properties (refreshed every hour)
let propertiesCache: Property[] | null = null;
let propertiesCacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ============================================================
// TYPES
// ============================================================

export interface Property {
  id: string;
  name: string;
  address?: string;
  bedrooms?: number;
  bathrooms?: number;
  maxGuests?: number;
  checkin?: string;
  checkout?: string;
}

export interface Reservation {
  id: string;
  code: string;
  platform: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  guestName?: string;
  guestCount?: number;
  propertyId?: string;
  propertyName?: string;
  conversationId?: string;
  lastMessageAt?: string;
}

export interface GuestMessage {
  id: string;
  body: string;
  sender: "guest" | "host" | "system";
  createdAt: string;
  images?: string[];
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Check if Hospitable integration is configured and enabled.
 */
export function isHospitableConfigured(): boolean {
  return process.env.HOSPITABLE_ENABLED === "true" && !!API_KEY;
}

/**
 * List all properties from Hospitable.
 * Results are cached for 1 hour.
 */
export async function listProperties(): Promise<Property[]> {
  if (propertiesCache && Date.now() - propertiesCacheTime < CACHE_TTL) {
    return propertiesCache;
  }

  const data = await hospitable("GET", "/properties?per_page=100&include=details");
  const properties = parseProperties(data);
  propertiesCache = properties;
  propertiesCacheTime = Date.now();
  return properties;
}

/**
 * List reservations with optional filters.
 */
export async function listReservations(options?: {
  propertyIds?: string[];
  startDate?: string;
  endDate?: string;
  status?: string;
  limit?: number;
}): Promise<Reservation[]> {
  const params = new URLSearchParams();
  params.set("per_page", String(options?.limit || 20));
  params.set("include", "guest,properties");

  if (options?.propertyIds?.length) {
    for (const id of options.propertyIds) {
      params.append("properties[]", id);
    }
  }
  if (options?.startDate) params.set("start_date", options.startDate);
  if (options?.endDate) params.set("end_date", options.endDate);

  const data = await hospitable("GET", `/reservations?${params.toString()}`);
  return parseReservations(data);
}

/**
 * Get a single reservation by UUID.
 */
export async function getReservation(uuid: string): Promise<Reservation | null> {
  try {
    const data = await hospitable("GET", `/reservations/${uuid}?include=guest,properties`);
    const reservations = parseReservations(data);
    return reservations[0] || null;
  } catch {
    return null;
  }
}

/**
 * List messages for a reservation.
 */
export async function listMessages(
  reservationUuid: string,
  limit = 10
): Promise<GuestMessage[]> {
  const data = await hospitable(
    "GET",
    `/reservations/${reservationUuid}/messages?per_page=${limit}&direction=desc`
  );
  return parseMessages(data);
}

/**
 * Send a message to a guest for a specific reservation.
 */
export async function sendMessage(
  reservationUuid: string,
  body: string,
  images?: string[]
): Promise<boolean> {
  const payload: any = { body };
  if (images?.length) payload.images = images;

  await hospitable("POST", `/reservations/${reservationUuid}/messages`, payload);
  console.log(`Hospitable: sent message to reservation ${reservationUuid} (${body.length} chars)`);
  return true;
}

/**
 * Detect if a user message needs Hospitable context.
 */
export function needsHospitable(message: string): boolean {
  if (!isHospitableConfigured()) return false;

  const lower = message.toLowerCase();

  const patterns = [
    /\b(guest|hóspede|huésped|inquilino)s?\b/i,
    /\b(airbnb|hospitable)\b/i,
    /\b(check.?in|check.?out|checkout)\b/i,
    /\b(reserv(ation|a)(tion|s|ções)?|booking|hospedagem)\b/i,
    /\b(reply|respond|responda?|contesta?)\b.{0,30}\b(guest|hóspede|message|mensagem)\b/i,
    /\b(who|quem).{0,20}(arriving|checking|chegando|entrando)\b/i,
    /\b(property|propriedade|imóvel|listing|anúncio)s?\b/i,
    /\b(ocupação|occupancy|disponibilidade|availability)\b/i,
    /\b(mensagem|message)\b.{0,20}\b(do|da|from|del)\b.{0,20}\b(hóspede|guest|huésped)\b/i,
    /\b(próximo|next|upcoming)\b.{0,20}\b(hóspede|guest|reserva|booking)\b/i,
  ];

  return patterns.some((p) => p.test(lower));
}

/**
 * Gather Hospitable context based on user's message intent.
 * Returns a formatted string to inject into Claude's prompt.
 */
export async function handleHospitableRequest(
  userMessage: string,
  _recentHistory: string
): Promise<string> {
  if (!isHospitableConfigured()) return "";

  const lower = userMessage.toLowerCase();
  const parts: string[] = [];

  try {
    // Always include properties
    const properties = await listProperties();
    if (properties.length) {
      parts.push("YOUR AIRBNB PROPERTIES:");
      for (const p of properties) {
        parts.push(
          `  - ${p.name} (ID: ${p.id})` +
            (p.address ? ` — ${p.address}` : "") +
            (p.bedrooms ? `, ${p.bedrooms}BR` : "") +
            (p.bathrooms ? `/${p.bathrooms}BA` : "") +
            (p.maxGuests ? `, max ${p.maxGuests} guests` : "") +
            (p.checkin ? `, check-in: ${p.checkin}` : "") +
            (p.checkout ? `, checkout: ${p.checkout}` : "")
        );
      }
    }

    // Get property IDs for reservation queries
    const propertyIds = properties.map((p) => p.id);

    // Check for reservation/guest intent
    const wantsReservations =
      /\b(reserv\w*|booking|check.?in|check.?out|guest|hóspede|huésped|arriving|quem|who|próximo|next|upcoming)\b/i.test(
        lower
      );

    if (wantsReservations && propertyIds.length) {
      // Get current and upcoming reservations (next 30 days)
      // Use 30 days ago as startDate to catch guests who checked in earlier and are still staying
      const sevenDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
      const thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const reservations = await listReservations({
        propertyIds,
        startDate: sevenDaysAgo,
        endDate: thirtyDays,
        limit: 20,
      });

      if (reservations.length) {
        const today = new Date().toISOString().split("T")[0];
        const active = reservations.filter(
          (r) => r.arrivalDate <= today && r.departureDate >= today
        );
        const upcoming = reservations.filter((r) => r.arrivalDate > today);

        if (active.length) {
          parts.push("\nCURRENTLY HOSTED (checked in now):");
          for (const r of active) {
            parts.push(
              `  - ${r.guestName || "Guest"} at ${r.propertyName || "Property"}: ` +
                `checked in ${r.arrivalDate}, checking out ${r.departureDate} (${r.platform}, ${r.status})` +
                ` [reservation_id: ${r.id}]`
            );
          }
        }

        if (upcoming.length) {
          parts.push("\nUPCOMING RESERVATIONS:");
          for (const r of upcoming) {
            parts.push(
              `  - ${r.guestName || "Guest"} at ${r.propertyName || "Property"}: ` +
                `${r.arrivalDate} → ${r.departureDate} (${r.platform}, ${r.status})` +
                ` [reservation_id: ${r.id}]`
            );
          }
        }

        if (!active.length && !upcoming.length) {
          parts.push("\nNo active or upcoming reservations in the next 30 days.");
        }
      } else {
        parts.push("\nNo upcoming reservations in the next 30 days.");
      }
    }

    // Check for message intent
    const wantsMessages =
      /\b(message\w*|mensage\w*|chat|conversa\w*|inbox|caixa)\b/i.test(lower) ||
      /\b(reply|respond\w*|contesta\w*|answer)\b/i.test(lower);

    if (wantsMessages && propertyIds.length) {
      // Get reservations with recent messages
      const today = new Date().toISOString().split("T")[0];
      const thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const reservations = await listReservations({
        propertyIds,
        startDate: today,
        endDate: thirtyDays,
        limit: 10,
      });

      // Fetch messages for reservations that have recent activity
      for (const r of reservations.slice(0, 5)) {
        try {
          const messages = await listMessages(r.id, 5);
          if (messages.length) {
            parts.push(
              `\nMESSAGES — ${r.guestName || "Guest"} (${r.propertyName}, ${r.arrivalDate} → ${r.departureDate}) [reservation_id: ${r.id}]:`
            );
            for (const m of messages.reverse()) {
              const who = m.sender === "guest" ? (r.guestName || "Guest") : "You";
              const time = new Date(m.createdAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
              parts.push(`  [${time}] ${who}: ${m.body.substring(0, 200)}`);
            }
          }
        } catch (error: any) {
          console.error(`Hospitable: failed to fetch messages for ${r.id}: ${error.message}`);
        }
      }
    }
  } catch (error: any) {
    console.error(`Hospitable error: ${error.message}`);
    parts.push(`(Hospitable API error: ${error.message})`);
  }

  return parts.join("\n");
}

/**
 * Format a webhook message.created payload for display.
 */
export function formatWebhookMessage(payload: any): {
  guestName: string;
  messageBody: string;
  propertyName: string;
  reservationId: string;
  arrivalDate: string;
  departureDate: string;
  platform: string;
} | null {
  try {
    const data = payload.data || payload;

    return {
      guestName: data.guest_name || data.guest?.name || "Guest",
      messageBody: data.body || data.message?.body || "",
      propertyName: data.property_name || data.property?.name || "Property",
      reservationId: data.reservation_id || data.reservation?.id || "",
      arrivalDate: data.arrival_date || data.reservation?.arrival_date || "",
      departureDate: data.departure_date || data.reservation?.departure_date || "",
      platform: data.platform || "airbnb",
    };
  } catch {
    return null;
  }
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

/**
 * Make an authenticated request to the Hospitable API.
 * Handles rate limiting with exponential backoff.
 */
async function hospitable(
  method: string,
  path: string,
  body?: any
): Promise<any> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (resp.status === 429) {
        // Rate limited — wait and retry
        const retryAfter = parseInt(resp.headers.get("retry-after") || "5", 10);
        console.warn(`Hospitable rate limited, waiting ${retryAfter}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `Hospitable API ${method} ${path}: ${resp.status} ${resp.statusText} — ${text.substring(0, 200)}`
        );
      }

      return await resp.json();
    } catch (error: any) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error(`Hospitable API request failed: ${method} ${path}`);
}

/**
 * Parse properties response into typed objects.
 * Hospitable API returns flat objects directly (NOT JSON:API attributes format).
 */
function parseProperties(data: any): Property[] {
  const items = Array.isArray(data.data) ? data.data : [];

  return items.map((p: any) => ({
    id: p.id,
    name: p.name || p.public_name || `Property ${p.id.substring(0, 8)}`,
    address: p.address?.display || p.address?.city || undefined,
    bedrooms: p.capacity?.bedrooms || undefined,
    bathrooms: p.capacity?.bathrooms || undefined,
    maxGuests: p.capacity?.max || undefined,
    checkin: p.checkin || undefined,
    checkout: p.checkout || undefined,
  }));
}

/**
 * Parse reservations response into typed objects.
 * Properties and guest are inline on each reservation (not in separate "included" array).
 */
function parseReservations(data: any): Reservation[] {
  const items = Array.isArray(data.data) ? data.data : [];

  return items.map((r: any) => ({
    id: r.id,
    code: r.code || "",
    platform: r.platform || "airbnb",
    status: r.reservation_status?.current?.category || r.status || "",
    arrivalDate: r.arrival_date?.split("T")[0] || "",
    departureDate: r.departure_date?.split("T")[0] || "",
    guestName: r.guest?.first_name || undefined,
    guestCount: r.guests?.total || undefined,
    propertyId: r.properties?.[0]?.id || undefined,
    propertyName: r.properties?.[0]?.name || undefined,
    conversationId: r.conversation_id || undefined,
    lastMessageAt: r.last_message_at || undefined,
  }));
}

/**
 * Parse messages response into typed objects.
 */
function parseMessages(data: any): GuestMessage[] {
  const items = Array.isArray(data.data) ? data.data : [];

  return items.map((m: any) => ({
    id: m.id || "",
    body: m.body || "",
    sender: m.sender || m.direction || "guest",
    createdAt: m.created_at || m.sent_at || "",
    images: m.images || undefined,
  }));
}
