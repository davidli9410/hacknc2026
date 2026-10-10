// Google OAuth (one sign-in: Calendar + Contacts), Calendar free/busy + events, People API contact search.
import { eq } from "drizzle-orm";
import { config, hasGoogleOAuth } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { DEMO_BUSY, type DemoKey } from "../demo/data.ts";
import { decrypt, encrypt } from "../lib/crypto.ts";
import { atLocalTime } from "../lib/time.ts";

type User = typeof schema.users.$inferSelect;

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/contacts.readonly",
];

type StoredTokens = { access_token: string; refresh_token?: string; expires_at: number };

export const redirectUri = () => `${config.publicBaseUrl}/auth/google/callback`;

export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<{ tokens: StoredTokens; givenName?: string; email?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId!,
      client_secret: config.google.clientSecret!,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const tokens: StoredTokens = { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + json.expires_in * 1000 };
  type Info = { given_name?: string; email?: string };
  const info: Info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } })
    .then((r) => (r.ok ? (r.json() as Promise<Info>) : {}))
    .catch(() => ({}));
  return { tokens, givenName: info.given_name, email: info.email };
}

export const sealTokens = (t: StoredTokens) => encrypt(JSON.stringify(t));

async function accessToken(user: User): Promise<string | null> {
  if (!user.googleTokens || !hasGoogleOAuth()) return null;
  let tokens: StoredTokens;
  try {
    tokens = JSON.parse(decrypt(user.googleTokens)) as StoredTokens;
  } catch {
    return null;
  }
  if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.google.clientId!,
      client_secret: config.google.clientSecret!,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // Testing-mode refresh tokens expire after 7 days; treat as disconnected.
    console.warn(`[google] refresh failed for ${user.id}: ${res.status}`);
    return null;
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const next: StoredTokens = { ...tokens, access_token: json.access_token, expires_at: Date.now() + json.expires_in * 1000 };
  await db.update(schema.users).set({ googleTokens: sealTokens(next) }).where(eq(schema.users.id, user.id));
  return next.access_token;
}

async function gfetch<T>(user: User, url: string, init?: RequestInit): Promise<T | null> {
  const token = await accessToken(user);
  if (!token) return null;
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!res.ok) {
    console.warn(`[google] ${url.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return res.status === 204 ? ({} as T) : ((await res.json()) as T);
}

// ---------------------------------------------------------------------------------------------
// Calendar

export type Busy = { start: Date; end: Date };

/** True when we can read this person's availability. */
export function hasCalendar(user: User): boolean {
  if (config.demo && user.demoKey) return true;
  return Boolean(user.googleTokens) && hasGoogleOAuth();
}

/** Busy blocks between from and to, or null when there's no calendar. */
export async function busyBlocks(user: User, from: Date, to: Date): Promise<Busy[] | null> {
  if (config.demo && user.demoKey) {
    return (DEMO_BUSY[user.demoKey as DemoKey] ?? []).map(([sh, sm, eh, em]) => ({
      start: atLocalTime(from, sh, sm, config.timezone),
      end: atLocalTime(from, eh, em, config.timezone),
    }));
  }
  const json = await gfetch<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(
    user,
    "https://www.googleapis.com/calendar/v3/freeBusy",
    { method: "POST", body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: config.timezone, items: [{ id: "primary" }] }) },
  );
  if (!json) return null;
  return (json.calendars?.primary?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

/** Earliest time at or after `from` that isn't inside a busy block. */
export function freeAtFrom(blocks: Busy[], from: Date): Date {
  let t = from.getTime();
  const sorted = [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const b of sorted) {
    if (b.start.getTime() <= t && b.end.getTime() > t) t = b.end.getTime();
  }
  return new Date(t);
}

/** Start of the next busy block after `from`, if any. */
export function freeUntilFrom(blocks: Busy[], from: Date): Date | null {
  const next = blocks.filter((b) => b.start.getTime() > from.getTime()).sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  return next?.start ?? null;
}

export type EventResult = { ok: boolean; id?: string; real: boolean };

export async function insertEvent(user: User, ev: { summary: string; start: Date; end: Date; description?: string }): Promise<EventResult> {
  const json = await gfetch<{ id: string }>(user, "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: ev.start.toISOString(), timeZone: config.timezone },
      end: { dateTime: ev.end.toISOString(), timeZone: config.timezone },
    }),
  });
  if (json?.id) return { ok: true, id: json.id, real: true };
  // Demo people without a Google connection get a local stand-in so the flow can continue in the terminal.
  if (config.demo && user.demoKey && !user.googleTokens) return { ok: true, id: `demo-event-${crypto.randomUUID()}`, real: false };
  return { ok: false, real: false };
}

export async function deleteEvent(user: User, eventId: string): Promise<void> {
  if (eventId.startsWith("demo-event-")) return;
  await gfetch(user, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------------------------
// Contacts (People API)

export type FoundContact = { name: string; nicknames: string[]; phones: string[]; emails: string[] };

/** searchContacts needs a warm-up request with an empty query before the first real search. */
export async function warmUpContacts(user: User): Promise<void> {
  await gfetch(user, "https://people.googleapis.com/v1/people:searchContacts?query=&readMask=names");
}

export async function searchContacts(user: User, query: string): Promise<FoundContact[] | null> {
  const params = new URLSearchParams({ query, readMask: "names,nicknames,phoneNumbers,emailAddresses", pageSize: "10" });
  const json = await gfetch<{
    results?: {
      person?: {
        names?: { displayName?: string }[];
        nicknames?: { value?: string }[];
        phoneNumbers?: { canonicalForm?: string; value?: string }[];
        emailAddresses?: { value?: string }[];
      };
    }[];
  }>(user, `https://people.googleapis.com/v1/people:searchContacts?${params.toString()}`);
  if (!json) return null;
  return (json.results ?? [])
    .map((r) => r.person)
    .filter((p): p is NonNullable<typeof p> => Boolean(p?.names?.[0]?.displayName))
    .map((p) => ({
      name: p.names![0]!.displayName!,
      nicknames: (p.nicknames ?? []).map((n) => n.value ?? "").filter(Boolean),
      phones: (p.phoneNumbers ?? []).map((n) => n.canonicalForm ?? n.value ?? "").filter(Boolean),
      emails: (p.emailAddresses ?? []).map((e) => (e.value ?? "").toLowerCase()).filter(Boolean),
    }));
}
