// Outbound messaging. Every user is reached through the transport for their channel
// (iMessage via Spectrum, the Spectrum terminal provider, or the in-memory sim).
import { eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";

export type User = typeof schema.users.$inferSelect;

export type Outbound =
  | { kind: "text"; text: string }
  | { kind: "poll"; title: string; options: string[] }
  | { kind: "findmy" }
  | { kind: "react"; targetMessageId: string; emoji: string };

export type SendResult = { ok: boolean; messageId?: string; error?: string };

export interface Transport {
  readonly channel: string;
  send(user: User, content: Outbound): Promise<SendResult>;
}

const transports = new Map<string, Transport>();

export function registerTransport(t: Transport): void {
  transports.set(t.channel, t);
}

export function transportFor(channel: string): Transport | undefined {
  return transports.get(channel);
}

/** Optional: post one poll into a real group chat (GROUP_CHAT_MODE, dedicated iMessage lines only). */
export type GroupPoller = (users: User[], title: string, options: string[]) => Promise<SendResult>;
let groupPoller: GroupPoller | null = null;
export function registerGroupPoller(fn: GroupPoller): void {
  groupPoller = fn;
}
export async function sendGroupPoll(users: User[], title: string, options: string[]): Promise<SendResult> {
  if (!groupPoller) return { ok: false, error: "group chats unavailable" };
  try {
    return await groupPoller(users, title, options);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type Inbound = {
  channel: string;
  /** Normalized sender handle: E.164 phone, lowercase email, term:<space>, sim:<name>. */
  handle: string;
  /** Provider conversation id to reply into. */
  spaceId: string;
  /** Photon line (phone) the conversation is routed through. */
  line?: string;
  messageId: string;
  service?: string;
  /** True for a group chat. Group messages never change where private DMs go. */
  group?: boolean;
  at: Date;
} & (
  | { kind: "text"; text: string }
  | { kind: "reaction"; emoji: string; targetMessageId: string }
  | { kind: "poll_vote"; optionTitle: string; selected: boolean; pollMessageId?: string }
  | { kind: "contact"; name?: string; phones: string[]; emails: string[] }
);

async function loadUser(userOrId: User | string): Promise<User | undefined> {
  if (typeof userOrId !== "string") return userOrId;
  return db.query.users.findFirst({ where: eq(schema.users.id, userOrId) });
}

async function deliver(userOrId: User | string, content: Outbound): Promise<SendResult> {
  const user = await loadUser(userOrId);
  if (!user) return { ok: false, error: "no such user" };
  const t = transports.get(user.channel);
  if (!t) {
    console.warn(`[messaging] no transport for channel ${user.channel} (user ${user.id})`);
    return { ok: false, error: `no transport ${user.channel}` };
  }
  try {
    return await t.send(user, content);
  } catch (e) {
    console.error(`[messaging] send to ${user.id} failed:`, e);
    return { ok: false, error: (e as Error).message };
  }
}

export async function sendText(user: User | string, text: string, meta?: { purpose: string; planId?: string; placeId?: string }): Promise<SendResult> {
  const res = await deliver(user, { kind: "text", text });
  if (meta && res.ok && res.messageId) {
    await db.insert(schema.sentMessages).values({
      userId: typeof user === "string" ? user : user.id,
      providerMessageId: res.messageId,
      purpose: meta.purpose,
      planId: meta.planId,
      placeId: meta.placeId,
    });
  }
  return res;
}

/** Sends a poll; falls back to a numbered list if polls aren't available. */
export async function sendPoll(user: User | string, title: string, options: string[]): Promise<SendResult & { fallback: boolean }> {
  const res = await deliver(user, { kind: "poll", title, options });
  if (res.ok) return { ...res, fallback: false };
  const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const numbers = options.map((_, i) => String(i + 1));
  const choices = numbers.length > 1 ? `${numbers.slice(0, -1).join(", ")} or ${numbers.at(-1)}` : "1";
  const text = await deliver(user, { kind: "text", text: `${list}\nReply ${choices}.` });
  return { ...text, fallback: true };
}

export async function sendFindMyCard(user: User | string): Promise<SendResult> {
  return deliver(user, { kind: "findmy" });
}

export async function react(user: User | string, targetMessageId: string, emoji: string): Promise<void> {
  await deliver(user, { kind: "react", targetMessageId, emoji });
}
