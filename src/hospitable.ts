/**
 * Hospitable — Public API Client
 *
 * Calls the Hospitable Public API directly using fetch().
 * Manages vacation rental properties, reservations, guest messaging, and reviews.
 *
 * Auth: Personal Access Token (PAT) from Hospitable app settings.
 * API docs: https://developer.hospitable.com/docs/public-api-docs
 */

const API_BASE = "https://public.api.hospitable.com";
const API_TOKEN = process.env.HOSPITABLE_API_TOKEN || "";

// ============================================================
// HTTP CLIENT
// ============================================================

async function apiRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  } = {}
): Promise<unknown> {
  if (!API_TOKEN) throw new Error("HOSPITABLE_API_TOKEN not set");

  const { method = "GET", body, params } = options;

  let url = `${API_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Hospitable API error (${resp.status}): ${err.substring(0, 300)}`);
  }

  if (resp.status === 202 || resp.status === 204) {
    const text = await resp.text();
    return text ? JSON.parse(text) : { success: true };
  }

  return resp.json();
}

// ============================================================
// TYPES
// ============================================================

export interface Property {
  id: string;
  name: string;
  publicName: string;
  picture: string;
  address: string;
  timezone: string;
  listed: boolean;
  currency: string;
  capacity: { max: number; bedrooms: number; beds: number; bathrooms: number };
  checkIn: string;
  checkOut: string;
}

export interface Reservation {
  id: string;
  conversationId: string;
  platform: string;
  platformId: string;
  bookingDate: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  checkIn: string;
  checkOut: string;
  status: string;
  guestName: string;
  guestCount: number;
  propertyName: string;
  propertyId: string;
  lastMessageAt: string;
  note: string;
  issueAlert: string | null;
}

export interface Inquiry {
  id: string;
  platform: string;
  inquiryDate: string;
  arrivalDate: string;
  departureDate: string;
  guestName: string;
  guestCount: number;
  propertyName: string;
  propertyId: string;
  lastMessageAt: string;
}

export interface GuestMessage {
  body: string;
  senderType: string;
  senderName: string;
  createdAt: string;
  source: string;
}

export interface Transaction {
  id: string;
  platform: string;
  type: string; // "Reservation" | "Payout" | etc.
  details: string;
  reference: string | null;
  currency: string;
  amount: { amount: number; formatted: string; currency: string } | null;
  paidOutAmount: { amount: number; formatted: string; currency: string } | null;
  date: string;
  startDate: string | null;
  reservationCode: string | null; // extracted from details
}

export interface Payout {
  id: string;
  platform: string;
  platformId: string;
  bankAccount: string;
  amount: { amount: number; formatted: string; currency: string };
  date: string;
}

// ============================================================
// PROPERTIES
// ============================================================

/**
 * List all properties.
 */
export async function listProperties(): Promise<Property[]> {
  const data = (await apiRequest("/v2/properties", {
    params: { per_page: "100" },
  })) as any;

  return (data.data || []).map((p: any) => ({
    id: p.id,
    name: p.name || "",
    publicName: p.public_name || "",
    picture: p.picture || "",
    address: p.address?.display || "",
    timezone: p.timezone || "",
    listed: p.listed ?? true,
    currency: p.currency || "",
    capacity: {
      max: p.capacity?.max || 0,
      bedrooms: p.capacity?.bedrooms || 0,
      beds: p.capacity?.beds || 0,
      bathrooms: p.capacity?.bathrooms || 0,
    },
    checkIn: p["check-in"] || "",
    checkOut: p["check-out"] || "",
  }));
}

// ============================================================
// RESERVATIONS
// ============================================================

/**
 * Get reservations with optional filters.
 */
export async function getReservations(options: {
  propertyIds?: string[];
  startDate?: string;
  endDate?: string;
  status?: string[];
  dateQuery?: "checkin" | "checkout";
  includeGuest?: boolean;
  perPage?: number;
  sort?: string;
} = {}): Promise<Reservation[]> {
  const params: Record<string, string> = {
    per_page: String(options.perPage || 20),
    include: "guest,properties",
  };

  if (options.startDate) params.start_date = options.startDate;
  if (options.endDate) params.end_date = options.endDate;
  if (options.dateQuery) params.date_query = options.dateQuery;
  if (options.sort) params.sort = options.sort;

  // Build URL with array params manually (URLSearchParams doesn't handle arrays well)
  let url = "/v2/reservations";
  const queryParts: string[] = [];

  for (const [k, v] of Object.entries(params)) {
    queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }

  if (options.propertyIds?.length) {
    for (const id of options.propertyIds) {
      queryParts.push(`properties[]=${encodeURIComponent(id)}`);
    }
  }

  if (options.status?.length) {
    for (const s of options.status) {
      queryParts.push(`status[]=${encodeURIComponent(s)}`);
    }
  }

  if (queryParts.length) url += "?" + queryParts.join("&");

  const data = (await apiRequest(url)) as any;

  return (data.data || []).map((r: any) => ({
    id: r.id,
    conversationId: r.conversation_id || "",
    platform: r.platform || "",
    platformId: r.platform_id || "",
    bookingDate: r.booking_date || "",
    arrivalDate: r.arrival_date || "",
    departureDate: r.departure_date || "",
    nights: r.nights || 0,
    checkIn: r.check_in || "",
    checkOut: r.check_out || "",
    status: r.reservation_status?.current?.category || r.status || "",
    guestName: r.guest
      ? `${r.guest.first_name || ""} ${r.guest.last_name || ""}`.trim()
      : "Unknown",
    guestCount: r.guests?.total || 0,
    propertyName: r.properties?.[0]?.name || "",
    propertyId: r.properties?.[0]?.id || "",
    lastMessageAt: r.last_message_at || "",
    note: r.note || "",
    issueAlert: r.issue_alert || null,
  }));
}

/**
 * Get a single reservation by UUID.
 */
export async function getReservation(uuid: string): Promise<Reservation> {
  const data = (await apiRequest(`/v2/reservations/${uuid}`, {
    params: { include: "guest,properties" },
  })) as any;

  const r = data.data || data;
  return {
    id: r.id,
    conversationId: r.conversation_id || "",
    platform: r.platform || "",
    platformId: r.platform_id || "",
    bookingDate: r.booking_date || "",
    arrivalDate: r.arrival_date || "",
    departureDate: r.departure_date || "",
    nights: r.nights || 0,
    checkIn: r.check_in || "",
    checkOut: r.check_out || "",
    status: r.reservation_status?.current?.category || r.status || "",
    guestName: r.guest
      ? `${r.guest.first_name || ""} ${r.guest.last_name || ""}`.trim()
      : "Unknown",
    guestCount: r.guests?.total || 0,
    propertyName: r.properties?.[0]?.name || "",
    propertyId: r.properties?.[0]?.id || "",
    lastMessageAt: r.last_message_at || "",
    note: r.note || "",
    issueAlert: r.issue_alert || null,
  };
}

// ============================================================
// TRANSACTIONS & PAYOUTS (Financial data)
// ============================================================

/**
 * Get transactions (reservation earnings + payouts).
 * Note: Hospitable API may only return recent transactions.
 */
export async function getTransactions(options: {
  startDate?: string;
  endDate?: string;
  perPage?: number;
} = {}): Promise<Transaction[]> {
  const params: Record<string, string> = {
    per_page: String(options.perPage || 100),
  };
  if (options.startDate) params.start_date = options.startDate;
  if (options.endDate) params.end_date = options.endDate;

  const data = (await apiRequest("/v2/transactions", { params })) as any;

  return (data.data || []).map((t: any) => {
    // Extract reservation code from details like "Feb 13 – 18, 2026 HM89RB2Y9Z"
    const codeMatch = t.details?.match(/\b(HM[A-Z0-9]{6,})\b/);
    return {
      id: t.id,
      platform: t.platform || "",
      type: t.type || "",
      details: t.details || "",
      reference: t.reference || null,
      currency: t.currency || "",
      amount: t.amount || null,
      paidOutAmount: t.paid_out_amount || null,
      date: t.date || "",
      startDate: t.start_date || null,
      reservationCode: codeMatch?.[1] || null,
    };
  });
}

/**
 * Get payouts (money sent to bank account).
 */
export async function getPayouts(options: {
  startDate?: string;
  endDate?: string;
  perPage?: number;
} = {}): Promise<Payout[]> {
  const params: Record<string, string> = {
    per_page: String(options.perPage || 100),
  };
  if (options.startDate) params.start_date = options.startDate;
  if (options.endDate) params.end_date = options.endDate;

  const data = (await apiRequest("/v2/payouts", { params })) as any;

  return (data.data || []).map((p: any) => ({
    id: p.id,
    platform: p.platform || "",
    platformId: p.platform_id || "",
    bankAccount: p.bank_account || "",
    amount: p.amount || { amount: 0, formatted: "$0.00", currency: "USD" },
    date: p.date || "",
  }));
}

// ============================================================
// INQUIRIES (conversations with no reservation attached)
// ============================================================

/**
 * Get inquiries (pre-booking conversations) for given properties.
 */
export async function getInquiries(options: {
  propertyIds: string[];
  lastMessageAt?: string;
  perPage?: number;
  sort?: string;
}): Promise<Inquiry[]> {
  let url = "/v2/inquiries";
  const queryParts: string[] = [];

  for (const id of options.propertyIds) {
    queryParts.push(`properties[]=${encodeURIComponent(id)}`);
  }
  queryParts.push(`include=guest,properties`);
  queryParts.push(`per_page=${options.perPage || 20}`);
  if (options.lastMessageAt) {
    queryParts.push(`last_message_at=${encodeURIComponent(options.lastMessageAt)}`);
  }
  if (options.sort) {
    queryParts.push(`sort=${encodeURIComponent(options.sort)}`);
  }

  if (queryParts.length) url += "?" + queryParts.join("&");

  const data = (await apiRequest(url)) as any;

  return (data.data || []).map((i: any) => ({
    id: i.id,
    platform: i.platform || "",
    inquiryDate: i.inquiry_date || "",
    arrivalDate: i.arrival_date || "",
    departureDate: i.departure_date || "",
    guestName: i.guest
      ? `${i.guest.first_name || ""} ${i.guest.last_name || ""}`.trim()
      : "Unknown",
    guestCount: i.guests?.total || 0,
    propertyName: i.properties?.[0]?.name || "",
    propertyId: i.properties?.[0]?.id || "",
    lastMessageAt: i.last_message_at || "",
  }));
}

/**
 * Send a message to a guest for a specific inquiry (no reservation yet).
 */
export async function sendInquiryMessage(
  inquiryUuid: string,
  body: string
): Promise<{ sentReferenceId: string }> {
  const data = (await apiRequest(
    `/v2/inquiries/${inquiryUuid}/messages`,
    {
      method: "POST",
      body: { body },
    }
  )) as any;

  return {
    sentReferenceId: data.data?.sent_reference_id || "",
  };
}

// ============================================================
// MESSAGING
// ============================================================

function parseMessages(data: any): GuestMessage[] {
  return (data.data || []).map((m: any) => ({
    body: m.body || "",
    senderType: m.sender_type || "",
    senderName: m.sender?.first_name || m.sender?.full_name || m.sender_type || "",
    createdAt: m.created_at || "",
    source: m.source || "",
  }));
}

/**
 * Get messages for a reservation.
 */
export async function getMessages(reservationUuid: string): Promise<GuestMessage[]> {
  const data = (await apiRequest(
    `/v2/reservations/${reservationUuid}/messages`
  )) as any;
  return parseMessages(data);
}

/**
 * Get messages for an inquiry (conversation with no reservation).
 * NOTE: The Hospitable API v2 does not support reading inquiry messages
 * (GET /v2/inquiries/{id}/messages returns 405). Only POST (sending) is supported.
 * Return empty array to avoid spamming failed requests.
 */
export async function getInquiryMessages(_inquiryUuid: string): Promise<GuestMessage[]> {
  return [];
}

/**
 * Send a message to a guest for a specific reservation.
 * Rate limited: 2 messages/min per reservation, 50 messages/5min total.
 */
export async function sendMessage(
  reservationUuid: string,
  body: string
): Promise<{ sentReferenceId: string }> {
  const data = (await apiRequest(
    `/v2/reservations/${reservationUuid}/messages`,
    {
      method: "POST",
      body: { body },
    }
  )) as any;

  return {
    sentReferenceId: data.data?.sent_reference_id || "",
  };
}

// ============================================================
// HIGH-LEVEL HANDLER — Called by the relay
// ============================================================

/**
 * Check if a reservation is "currently staying" (guest is at the property right now).
 */
function isCurrentlyStaying(r: Reservation): boolean {
  const now = Date.now();
  const arrival = new Date(r.arrivalDate).getTime();
  const departure = new Date(r.departureDate).getTime();
  return r.status === "accepted" && arrival <= now && departure >= now;
}

/**
 * Format a date for display.
 */
function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Format a timestamp for message display.
 */
function fmtTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Fetch and format messages for a reservation or inquiry, returning a text block.
 * Uses the correct API endpoint based on the type.
 */
async function fetchMessageBlock(
  resId: string,
  guestName: string,
  propertyName: string,
  status: string,
  dates: string,
  guestCount: number,
  type: "reservation" | "inquiry"
): Promise<string | null> {
  try {
    // Use the correct endpoint based on type
    const messages = type === "inquiry"
      ? await getInquiryMessages(resId)
      : await getMessages(resId);
    const recent = messages.slice(-5);
    if (!recent.length) return null;

    let header = `MESSAGES — ${guestName} (${propertyName}, ${status}, ${dates}`;
    if (guestCount > 0) header += `, ${guestCount} guests`;
    header += `, ${type}, uuid: ${resId})`;

    const lines = recent.map((m) => {
      const time = fmtTime(m.createdAt);
      const sender = m.senderType === "host" ? "You" : m.senderName;
      return `  [${time}] ${sender}: ${m.body.substring(0, 300)}`;
    });

    return header + "\n" + lines.join("\n");
  } catch (e: any) {
    console.error(`Failed to fetch ${type} messages for ${resId}:`, e.message);
    return null;
  }
}

// ============================================================
// SUPABASE — Persistent financial storage
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function getSupabase(): SupabaseClient | null {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

/**
 * Sync current Hospitable API transactions into Supabase.
 * Upserts to avoid duplicates. Also enriches with reservation data (property, guest, dates).
 */
export async function syncTransactionsToSupabase(): Promise<number> {
  const sb = getSupabase();
  if (!sb) return 0;

  const [transactions, payouts, properties] = await Promise.all([
    getTransactions({ perPage: 100 }),
    getPayouts({ perPage: 100 }),
    listProperties(),
  ]);

  const propertyIds = properties.map((p) => p.id);

  // Get all reservations to enrich transaction data
  const reservations = await getReservations({
    propertyIds,
    startDate: "2025-01-01",
    endDate: new Date(Date.now() + 365 * 86400000).toISOString().split("T")[0],
    status: ["accepted"],
    perPage: 100,
  });

  // Build lookup: reservation code → reservation details
  const codeToRes: Record<string, Reservation> = {};
  for (const r of reservations) {
    if (r.platformId) codeToRes[r.platformId] = r;
  }

  let synced = 0;

  // Upsert reservation transactions
  for (const tx of transactions.filter((t) => t.type === "Reservation")) {
    const res = tx.reservationCode ? codeToRes[tx.reservationCode] : null;
    const { error } = await sb.from("hospitable_transactions").upsert(
      {
        hospitable_id: tx.id,
        platform: tx.platform,
        type: "reservation",
        reservation_code: tx.reservationCode,
        property_name: res?.propertyName || null,
        property_id: res?.propertyId || null,
        guest_name: res?.guestName || null,
        arrival_date: res?.arrivalDate?.split("T")[0] || null,
        departure_date: res?.departureDate?.split("T")[0] || null,
        nights: res?.nights || null,
        transaction_date: tx.startDate?.split("T")[0] || tx.date?.split("T")[0],
        amount_cents: tx.amount?.amount || 0,
        currency: tx.amount?.currency || tx.currency,
        amount_formatted: tx.amount?.formatted || null,
        details: tx.details,
        source: "hospitable_api",
      },
      { onConflict: "hospitable_id" }
    );
    if (!error) synced++;
  }

  // Upsert payout transactions
  for (const p of payouts) {
    const { error } = await sb.from("hospitable_transactions").upsert(
      {
        hospitable_id: p.id,
        platform: p.platform,
        type: "payout",
        transaction_date: p.date?.split("T")[0],
        amount_cents: p.amount?.amount || 0,
        currency: p.amount?.currency || "USD",
        amount_formatted: p.amount?.formatted || null,
        bank_account: p.bankAccount,
        payout_platform_id: p.platformId,
        details: `Payout → ${p.bankAccount}`,
        source: "hospitable_api",
      },
      { onConflict: "hospitable_id" }
    );
    if (!error) synced++;
  }

  console.log(`Synced ${synced} transactions to Supabase`);
  return synced;
}

/**
 * Get financial data from Supabase for a date range.
 * Returns both reservation earnings and payouts, grouped by property.
 */
export async function getFinancialsFromSupabase(
  startDate: string,
  endDate: string
): Promise<{
  reservations: Array<{
    property_name: string;
    guest_name: string;
    reservation_code: string;
    arrival_date: string;
    departure_date: string;
    nights: number;
    amount_cents: number;
    currency: string;
    amount_formatted: string;
    transaction_date: string;
  }>;
  payouts: Array<{
    amount_cents: number;
    currency: string;
    amount_formatted: string;
    transaction_date: string;
    bank_account: string;
  }>;
}> {
  const sb = getSupabase();
  if (!sb) return { reservations: [], payouts: [] };

  const [resResult, payResult] = await Promise.all([
    sb
      .from("hospitable_transactions")
      .select("*")
      .eq("type", "reservation")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: true }),
    sb
      .from("hospitable_transactions")
      .select("*")
      .eq("type", "payout")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: true }),
  ]);

  return {
    reservations: (resResult.data || []).map((r: any) => ({
      property_name: r.property_name || "Unknown",
      guest_name: r.guest_name || "Unknown",
      reservation_code: r.reservation_code || "",
      arrival_date: r.arrival_date || "",
      departure_date: r.departure_date || "",
      nights: r.nights || 0,
      amount_cents: r.amount_cents || 0,
      currency: r.currency || "BRL",
      amount_formatted: r.amount_formatted || "",
      transaction_date: r.transaction_date || "",
    })),
    payouts: (payResult.data || []).map((p: any) => ({
      amount_cents: p.amount_cents || 0,
      currency: p.currency || "USD",
      amount_formatted: p.amount_formatted || "",
      transaction_date: p.transaction_date || "",
      bank_account: p.bank_account || "",
    })),
  };
}

/**
 * Process a natural language Hospitable request.
 * Gathers relevant context (properties, reservations, messages) based on intent.
 */
export async function handleHospitableRequest(
  userMessage: string,
  recentHistory: string
): Promise<string> {
  try {
    const msg = userMessage.toLowerCase();
    let context = "";

    // Always fetch properties first (needed for reservation queries)
    const properties = await listProperties();

    if (!properties.length) {
      return "HOSPITABLE: No properties found in your account.";
    }

    const propertyIds = properties.map((p) => p.id);

    // Properties overview
    if (
      msg.match(
        /\b(propert|listings?|apartments?|houses?|villas?|imóve|propriedad|cabins?|units?)\b/i
      )
    ) {
      context +=
        "YOUR PROPERTIES:\n" +
        properties
          .map(
            (p) =>
              `- ${p.name} (${p.address}) — ${p.capacity.bedrooms}BR/${p.capacity.beds}B, max ${p.capacity.max} guests, check-in: ${p.checkIn}, check-out: ${p.checkOut}`
          )
          .join("\n");
    }

    // Reservations — detect specific month or default to next 30 days
    if (
      msg.match(
        /\b(reservat|booking|check.?in|check.?out|guests?|hóspede|reserva|upcoming|arrivals?|departures?|stays?|ocupação|occupancy)\b/i
      ) ||
      !context
    ) {
      // Detect specific month references (past or future)
      const monthNames: Record<string, number> = {
        jan: 0, janeiro: 0, january: 0,
        fev: 1, fevereiro: 1, february: 1, feb: 1,
        mar: 2, março: 2, march: 2,
        abr: 3, abril: 3, april: 3, apr: 3,
        mai: 4, maio: 4, may: 4,
        jun: 5, junho: 5, june: 5,
        jul: 6, julho: 6, july: 6,
        ago: 7, agosto: 7, august: 7, aug: 7,
        set: 8, setembro: 8, september: 8, sep: 8,
        out: 9, outubro: 9, october: 9, oct: 9,
        nov: 10, novembro: 10, november: 10,
        dez: 11, dezembro: 11, december: 11, dec: 11,
      };

      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      let specificMonth: number | null = null;
      let targetYear = currentYear;

      for (const [name, idx] of Object.entries(monthNames)) {
        if (msg.includes(name)) {
          specificMonth = idx;
          // If the month is in the future relative to current month, assume previous year
          if (idx > currentMonth) targetYear = currentYear - 1;
          break;
        }
      }

      // Also detect "last month" / "mês passado"
      if (msg.match(/\b(last.?month|mês.?passado|mes.?passado)\b/i)) {
        specificMonth = currentMonth - 1;
        if (specificMonth < 0) {
          specificMonth = 11;
          targetYear = currentYear - 1;
        }
      }

      let startDate: string;
      let endDate: string;
      let periodLabel: string;

      if (specificMonth !== null) {
        // Specific month requested — fetch that entire month
        startDate = new Date(targetYear, specificMonth, 1).toISOString().split("T")[0];
        endDate = new Date(targetYear, specificMonth + 1, 0).toISOString().split("T")[0];
        periodLabel = new Date(targetYear, specificMonth, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
      } else {
        // Default: next 30 days
        startDate = now.toISOString().split("T")[0];
        endDate = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
        periodLabel = "next 30 days";
      }

      const reservations = await getReservations({
        propertyIds,
        startDate,
        endDate,
        status: ["accepted", "request"],
        perPage: 50,
      });

      if (reservations.length) {
        context +=
          `\n\nRESERVATIONS (${periodLabel}):\n` +
          reservations
            .map((r) => {
              const arrival = fmtDate(r.arrivalDate);
              const departure = fmtDate(r.departureDate);
              let line = `- ${arrival}–${departure}: ${r.guestName} (${r.guestCount} guests, ${r.nights} nights) @ ${r.propertyName} [${r.platform}/${r.platformId}] — status: ${r.status}`;
              if (isCurrentlyStaying(r)) line += ` 🏠 CURRENTLY STAYING`;
              if (r.issueAlert) line += ` ⚠️ ISSUE: ${r.issueAlert}`;
              if (r.note) line += ` | note: ${r.note}`;
              line += ` | uuid: ${r.id}`;
              return line;
            })
            .join("\n");
      } else {
        context += `\n\nRESERVATIONS (${periodLabel}): None found.`;
      }
    }

    // INBOX / MESSAGES — the full inbox view
    // Fetches BOTH inquiries AND reservations (all statuses), with message content.
    // Excludes currently-staying guests unless explicitly asked.
    if (
      msg.match(
        /\b(messages?|messag|chat|conversation|inbox|guest.?messag|respond|reply|write.?to|contact|mensage[nm]s?|conversa[sç]|caixa.?de.?entrada|responder|contatar|escrever.?para)\b/i
      )
    ) {
      const excludeCurrent = !msg.match(/\b(current|active|staying|hospedad[oa])\b/i);
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      // Fetch inquiries AND reservations in parallel
      // Use sort=-last_message_at to get conversations with most recent messages first
      const [inquiries, recentReservations] = await Promise.all([
        getInquiries({ propertyIds, perPage: 30, sort: "-last_message_at" }).catch((e: any) => {
          console.error("Failed to fetch inquiries:", e.message);
          return [] as Inquiry[];
        }),
        getReservations({
          propertyIds,
          perPage: 50,
          sort: "-last_message_at",
        }).catch((e: any) => {
          console.error("Failed to fetch reservations for inbox:", e.message);
          return [] as Reservation[];
        }),
      ]);

      // Build a unified inbox from both sources
      const messageBlocks: { sortKey: string; block: string }[] = [];

      // Process inquiries (conversations with no reservation)
      // Sort by most recent message first (in case API doesn't honor sort param)
      const sortedInquiries = [...inquiries].sort(
        (a, b) =>
          new Date(b.lastMessageAt || b.inquiryDate).getTime() -
          new Date(a.lastMessageAt || a.inquiryDate).getTime()
      );
      for (const inq of sortedInquiries) {
        const dates = `${fmtDate(inq.arrivalDate)}–${fmtDate(inq.departureDate)}`;
        // For inquiries, the messages endpoint is the reservation messages format
        // but using the inquiry UUID
        const block = await fetchMessageBlock(
          inq.id,
          inq.guestName,
          inq.propertyName,
          "inquiry",
          dates,
          inq.guestCount,
          "inquiry"
        );
        if (block) {
          messageBlocks.push({
            sortKey: inq.lastMessageAt || inq.inquiryDate,
            block,
          });
        }
      }

      // Process reservations — include all statuses, filter out current stays if requested
      const filteredReservations = recentReservations
        .filter((r) => {
          if (excludeCurrent && isCurrentlyStaying(r)) return false;
          return true;
        })
        .filter((r) => r.lastMessageAt) // Only those with messages
        .sort(
          (a, b) =>
            new Date(b.lastMessageAt).getTime() -
            new Date(a.lastMessageAt).getTime()
        )
        .slice(0, 10);

      for (const res of filteredReservations) {
        const dates = `${fmtDate(res.arrivalDate)}–${fmtDate(res.departureDate)}`;
        const block = await fetchMessageBlock(
          res.id,
          res.guestName,
          res.propertyName,
          res.status,
          dates,
          res.guestCount,
          "reservation"
        );
        if (block) {
          messageBlocks.push({
            sortKey: res.lastMessageAt,
            block,
          });
        }
      }

      // Sort all blocks by most recent message and deduplicate by guest name
      messageBlocks.sort(
        (a, b) => new Date(b.sortKey).getTime() - new Date(a.sortKey).getTime()
      );

      // Deduplicate: if same guest appears in both inquiry and reservation, keep most recent
      const seenGuests = new Set<string>();
      const uniqueBlocks: string[] = [];
      for (const { block } of messageBlocks) {
        // Extract guest name from the header (between "— " and " (")
        const nameMatch = block.match(/^MESSAGES — (.+?) \(/);
        const guestKey = nameMatch?.[1]?.toLowerCase() || block;
        if (seenGuests.has(guestKey)) continue;
        seenGuests.add(guestKey);
        uniqueBlocks.push(block);
      }

      if (uniqueBlocks.length) {
        context += "\n\nINBOX MESSAGES (most recent first, excluding current stays):\n\n";
        context += uniqueBlocks.join("\n\n");
      } else {
        context += "\n\nINBOX: No recent messages found.";
      }

      // Also list inquiries without messages (new/unanswered)
      const inquiriesWithoutMessages = inquiries.filter(
        (inq) => !messageBlocks.some((b) => b.block.includes(inq.id))
      );
      if (inquiriesWithoutMessages.length) {
        context += "\n\nUNANSWERED INQUIRIES (no messages yet):\n";
        context += inquiriesWithoutMessages
          .map((inq) => {
            const dates = `${fmtDate(inq.arrivalDate)}–${fmtDate(inq.departureDate)}`;
            return `- ${inq.guestName} — ${inq.propertyName}, ${dates}, ${inq.guestCount} guests [inquiry, uuid: ${inq.id}]`;
          })
          .join("\n");
      }
    }

    // FINANCIAL — earnings, revenue, payouts, transactions
    if (
      msg.match(
        /\b(earn\w*|revenue|payout|transaction|financ\w*|fatur\w*|ganhos?|receita|income|billing|mensal|monthly)\b/i
      ) ||
      msg.match(
        /quanto.{0,10}(fiz|ganhei|faturei|recebi|gero[ua])/i
      ) ||
      msg.match(
        /how.?much.{0,10}(did|have|earn|made?)/i
      ) ||
      msg.match(
        /\b(soma|sum|total).{0,15}(reserv|booking|month|mês|mes)/i
      ) ||
      msg.match(
        /\b(relat[oó]rio|report).{0,15}(financ|reserv|booking|mensal|monthly)/i
      )
    ) {
      // Determine date range from message
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth(); // 0-indexed

      // Try to detect specific month mentions
      const monthNames: Record<string, number> = {
        jan: 0, janeiro: 0, january: 0,
        fev: 1, fevereiro: 1, february: 1, feb: 1,
        mar: 2, março: 2, march: 2,
        abr: 3, abril: 3, april: 3, apr: 3,
        mai: 4, maio: 4, may: 4,
        jun: 5, junho: 5, june: 5,
        jul: 6, julho: 6, july: 6,
        ago: 7, agosto: 7, august: 7, aug: 7,
        set: 8, setembro: 8, september: 8, sep: 8,
        out: 9, outubro: 9, october: 9, oct: 9,
        nov: 10, novembro: 10, november: 10,
        dez: 11, dezembro: 11, december: 11, dec: 11,
      };

      let targetMonth = currentMonth;
      let targetYear = currentYear;

      for (const [name, idx] of Object.entries(monthNames)) {
        if (msg.includes(name)) {
          targetMonth = idx;
          // If mentioned month is in the future, assume previous year
          if (idx > currentMonth) targetYear = currentYear - 1;
          break;
        }
      }

      // Also detect "last month" / "mês passado"
      if (msg.match(/\b(last.?month|mês.?passado|mes.?passado)\b/i)) {
        targetMonth = currentMonth - 1;
        if (targetMonth < 0) {
          targetMonth = 11;
          targetYear = currentYear - 1;
        }
      }

      const startDate = new Date(targetYear, targetMonth, 1)
        .toISOString()
        .split("T")[0];
      const endDate = new Date(targetYear, targetMonth + 1, 0)
        .toISOString()
        .split("T")[0];

      const monthLabel = new Date(targetYear, targetMonth, 1).toLocaleDateString(
        "en-US",
        { month: "long", year: "numeric" }
      );

      // Step 1: Sync latest API transactions to Supabase (captures new data)
      syncTransactionsToSupabase().catch((e: any) =>
        console.error("Background sync failed:", e.message)
      );

      // Step 2: Fetch reservations from API + financial data from Supabase
      const [periodReservations, sbFinancials] = await Promise.all([
        getReservations({
          propertyIds,
          startDate,
          endDate,
          status: ["accepted"],
          perPage: 100,
        }).catch((e: any) => {
          console.error("Failed to fetch period reservations:", e.message);
          return [] as Reservation[];
        }),
        getFinancialsFromSupabase(startDate, endDate).catch((e: any) => {
          console.error("Failed to fetch financials from Supabase:", e.message);
          return { reservations: [], payouts: [] };
        }),
      ]);

      // If Supabase has no data, try live API as fallback
      let hasFinancialData = sbFinancials.reservations.length > 0 || sbFinancials.payouts.length > 0;

      if (!hasFinancialData) {
        // Fallback: try live API transactions
        const [transactions, payouts] = await Promise.all([
          getTransactions({ perPage: 100 }).catch(() => [] as Transaction[]),
          getPayouts({ perPage: 100 }).catch(() => [] as Payout[]),
        ]);

        const startMs = new Date(startDate).getTime();
        const endMs = new Date(endDate + "T23:59:59").getTime();
        const liveTx = transactions
          .filter((t) => t.type === "Reservation")
          .filter((t) => {
            const d = new Date(t.startDate || t.date).getTime();
            return d >= startMs && d <= endMs;
          });
        const livePay = payouts.filter((p) => {
          const d = new Date(p.date).getTime();
          return d >= startMs && d <= endMs;
        });

        // Build code → property lookup from reservations
        const codeToProperty: Record<string, string> = {};
        for (const r of periodReservations) {
          if (r.platformId) codeToProperty[r.platformId] = r.propertyName;
        }

        // Convert live API data to same format as Supabase
        for (const tx of liveTx) {
          sbFinancials.reservations.push({
            property_name: tx.reservationCode ? codeToProperty[tx.reservationCode] || "Unknown" : "Unknown",
            guest_name: "",
            reservation_code: tx.reservationCode || "",
            arrival_date: "",
            departure_date: "",
            nights: 0,
            amount_cents: tx.amount?.amount || 0,
            currency: tx.amount?.currency || tx.currency,
            amount_formatted: tx.amount?.formatted || "",
            transaction_date: tx.startDate?.split("T")[0] || tx.date?.split("T")[0] || "",
          });
        }
        for (const p of livePay) {
          sbFinancials.payouts.push({
            amount_cents: p.amount?.amount || 0,
            currency: p.amount?.currency || "USD",
            amount_formatted: p.amount?.formatted || "",
            transaction_date: p.date?.split("T")[0] || "",
            bank_account: p.bankAccount || "",
          });
        }
        hasFinancialData = sbFinancials.reservations.length > 0 || sbFinancials.payouts.length > 0;
      }

      context += `\n\nFINANCIAL REPORT — ${monthLabel}:\n`;

      // Reservation earnings grouped by property
      if (sbFinancials.reservations.length) {
        context += "\nEARNINGS (by property):\n";
        const byProperty: Record<string, { total: number; currency: string; items: string[] }> = {};

        for (const tx of sbFinancials.reservations) {
          const prop = tx.property_name || "Unknown";
          if (!byProperty[prop]) {
            byProperty[prop] = { total: 0, currency: tx.currency, items: [] };
          }
          byProperty[prop].total += tx.amount_cents;
          const guest = tx.guest_name ? ` (${tx.guest_name})` : "";
          const dates = tx.arrival_date && tx.departure_date
            ? ` ${fmtDate(tx.arrival_date)}–${fmtDate(tx.departure_date)}`
            : "";
          byProperty[prop].items.push(
            `  - ${tx.amount_formatted}${dates}${guest} [${tx.reservation_code}]`
          );
        }

        let grandTotal = 0;
        for (const [prop, data] of Object.entries(byProperty)) {
          const formattedTotal =
            data.currency === "BRL"
              ? `R$${(data.total / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
              : `$${(data.total / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
          context += `\n${prop}: ${formattedTotal}\n`;
          context += data.items.join("\n") + "\n";
          grandTotal += data.total;
        }

        if (Object.keys(byProperty).length > 1) {
          const currency = sbFinancials.reservations[0]?.currency || "BRL";
          const formattedGrand =
            currency === "BRL"
              ? `R$${(grandTotal / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
              : `$${(grandTotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
          context += `\nGRAND TOTAL: ${formattedGrand}\n`;
        }
      }

      // Payouts
      if (sbFinancials.payouts.length) {
        context += "\nPAYOUTS (sent to bank):\n";
        let payoutTotal = 0;
        for (const p of sbFinancials.payouts) {
          context += `  - ${p.amount_formatted} on ${p.transaction_date} → ${p.bank_account}\n`;
          payoutTotal += p.amount_cents;
        }
        const currency = sbFinancials.payouts[0]?.currency || "USD";
        const formattedPayoutTotal =
          currency === "BRL"
            ? `R$${(payoutTotal / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
            : `$${(payoutTotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
        context += `  Total payouts: ${formattedPayoutTotal}\n`;
      }

      // Reservations list for the period
      if (periodReservations.length) {
        const byProp: Record<string, Reservation[]> = {};
        for (const r of periodReservations) {
          const name = r.propertyName || "Unknown";
          if (!byProp[name]) byProp[name] = [];
          byProp[name].push(r);
        }

        context += "\nRESERVATIONS IN PERIOD (by property):\n";
        for (const [prop, reservations] of Object.entries(byProp)) {
          const totalNights = reservations.reduce((sum, r) => sum + r.nights, 0);
          context += `\n${prop} — ${reservations.length} reservations, ${totalNights} total nights:\n`;
          for (const r of reservations.sort(
            (a, b) => new Date(a.arrivalDate).getTime() - new Date(b.arrivalDate).getTime()
          )) {
            context += `  - ${fmtDate(r.arrivalDate)}–${fmtDate(r.departureDate)}: ${r.guestName} (${r.nights}n, ${r.guestCount} guests) [${r.platformId}]\n`;
          }
        }
      } else {
        context += "\nNo reservations found for this period.\n";
      }

      // Missing data warning
      if (!hasFinancialData) {
        context +=
          "\n⚠️ NOTE: No financial/earnings data available for this period. " +
          "The reservation list above is complete but without monetary values. " +
          "You can manually add earnings data or check the Airbnb Earnings page.";
      }
    }

    // Always include recent inquiries (pre-booking conversations) — these are
    // guests without reservations who may need a response. Without this, the bot
    // only sees reservations and misses inquiry-only conversations.
    if (!context.includes("INQUIRY") && !context.includes("INBOX")) {
      const recentInquiries = await getInquiries({
        propertyIds,
        perPage: 10,
        sort: "-last_message_at",
      }).catch(() => [] as Inquiry[]);

      if (recentInquiries.length) {
        // Fetch messages for the most recent inquiries
        const inquiryBlocks: string[] = [];
        const sorted = [...recentInquiries].sort(
          (a, b) =>
            new Date(b.lastMessageAt || b.inquiryDate).getTime() -
            new Date(a.lastMessageAt || a.inquiryDate).getTime()
        );
        for (const inq of sorted.slice(0, 5)) {
          const dates = `${fmtDate(inq.arrivalDate)}–${fmtDate(inq.departureDate)}`;
          const block = await fetchMessageBlock(
            inq.id,
            inq.guestName,
            inq.propertyName,
            "inquiry",
            dates,
            inq.guestCount,
            "inquiry"
          );
          if (block) inquiryBlocks.push(block);
        }
        if (inquiryBlocks.length) {
          context += "\n\nRECENT INQUIRIES (guests without reservations):\n\n";
          context += inquiryBlocks.join("\n\n");
        }
      }
    }

    // If no specific context was gathered, show a general overview
    if (!context) {
      context =
        "YOUR PROPERTIES:\n" +
        properties
          .map((p) => `- ${p.name} (${p.address})`)
          .join("\n");
    }

    return context;
  } catch (error: any) {
    console.error("Hospitable API error:", error.message);
    if (error.message.includes("401")) {
      return "ERROR: Hospitable authentication failed. Check your HOSPITABLE_API_TOKEN in .env.";
    }
    return `HOSPITABLE ERROR: ${error.message}`;
  }
}
