// The one open question per user. A new question replaces the old one.
import { eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";

export type PendingKind =
  | "diet"
  | "max_per_meal"
  | "confirm_budget"
  | "set_limits"
  | "mood"
  | "choose_solo"
  | "where_from"
  | "when_free"
  | "invite_in"
  | "vote"
  | "confirm_booked"
  | "runner_up"
  | "go_without"
  | "choose_contact"
  | "contact_card"
  | "who_paid"
  | "how_much"
  | "confirm_split"
  | "send_share"
  | "paid_other"
  | "feedback";

export type Pending = { kind: PendingKind; planId: string | null; payload: Record<string, unknown>; question?: string };

export async function getPending(userId: string): Promise<Pending | null> {
  const row = await db.query.pending.findFirst({ where: eq(schema.pending.userId, userId) });
  if (!row) return null;
  return { kind: row.kind as PendingKind, planId: row.planId, payload: row.payload };
}

/** `payload.planId`, when present, also ties the question to that plan. */
export async function setPending(userId: string, kind: PendingKind, payload: Record<string, unknown> = {}): Promise<void> {
  const planId = typeof payload.planId === "string" ? payload.planId : null;
  const values = { userId, kind, planId, payload, createdAt: new Date() };
  await db.insert(schema.pending).values(values).onConflictDoUpdate({ target: schema.pending.userId, set: values });
}

export async function clearPending(userId: string, kind?: PendingKind): Promise<void> {
  if (!kind) {
    await db.delete(schema.pending).where(eq(schema.pending.userId, userId));
    return;
  }
  const row = await getPending(userId);
  if (row?.kind === kind) await db.delete(schema.pending).where(eq(schema.pending.userId, userId));
}
