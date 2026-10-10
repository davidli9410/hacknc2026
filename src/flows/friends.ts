// Turning "Clive and Eric" into people: known contacts, then Google Contacts, then a shared contact card.
import { and, arrayOverlaps, eq } from "drizzle-orm";
import { MAX_GROUP, startGroupPlan, type Invitee } from "../agents/coordinator.ts";
import { db, schema } from "../db/index.ts";
import type { MealKind } from "../engines/budget.ts";
import { searchContacts, warmUpContacts } from "../integrations/google.ts";
import { sendText, type User } from "../messaging.ts";
import { setPending } from "../pending.ts";
import { normalizeHandle } from "../router-util.ts";

type Contact = typeof schema.contacts.$inferSelect;

export type PlanDraft = {
  names: string[];
  resolved: Invitee[];
  meal: MealKind;
  when?: string;
};

const firstWord = (s: string) => s.trim().split(/\s+/)[0]!;

async function foodieUserFor(handles: string[]): Promise<string | null> {
  if (handles.length === 0) return null;
  const u = await db.query.users.findFirst({ where: arrayOverlaps(schema.users.handles, handles) });
  return u?.id ?? null;
}

async function toInvitee(c: Contact): Promise<Invitee> {
  let userId = c.foodieUserId;
  if (!userId) {
    userId = await foodieUserFor(c.handles);
    if (userId) await db.update(schema.contacts).set({ foodieUserId: userId }).where(eq(schema.contacts.id, c.id));
  }
  return { name: firstWord(c.name), userId, contactId: c.id, handle: c.handles.find((h) => h.startsWith("+")) ?? c.handles[0] ?? null };
}

function matches(c: Contact, name: string): boolean {
  const n = name.toLowerCase().trim();
  const full = c.name.toLowerCase();
  return full === n || firstWord(full) === n || c.nicknames.some((k) => k.toLowerCase() === n);
}

/** Continues resolving names; asks one question if needed, otherwise starts the plan. */
export async function continueDraft(organizer: User, draft: PlanDraft): Promise<void> {
  if (draft.resolved.length + draft.names.length + 1 > MAX_GROUP) {
    await sendText(organizer, `I can plan for up to ${MAX_GROUP} people. Who should I leave out?`);
    return;
  }
  while (draft.names.length > 0) {
    const name = draft.names[0]!;

    if (/^(the usual|usual|the crew|the gang)$/i.test(name)) {
      const crew = await db.query.crews.findFirst({ where: and(eq(schema.crews.ownerId, organizer.id), eq(schema.crews.name, "the usual")) });
      draft.names.shift();
      if (crew) {
        const contacts = await db.query.contacts.findMany({ where: eq(schema.contacts.ownerId, organizer.id) });
        for (const id of crew.memberIds) {
          const c = contacts.find((x) => String(x.id) === id);
          if (c && !draft.resolved.some((r) => r.contactId === c.id)) draft.resolved.push(await toInvitee(c));
        }
      }
      continue;
    }

    const known = (await db.query.contacts.findMany({ where: eq(schema.contacts.ownerId, organizer.id) })).filter((c) => matches(c, name));
    if (known.length === 1) {
      draft.resolved.push(await toInvitee(known[0]!));
      draft.names.shift();
      continue;
    }
    if (known.length > 1) {
      await askWhich(organizer, draft, known.map((c) => ({ name: c.name, contactId: c.id })));
      return;
    }

    // Not known yet: Google Contacts.
    if (organizer.googleTokens) {
      await warmUpContacts(organizer);
      const found = ((await searchContacts(organizer, name)) ?? []).filter((f) => f.phones.length || f.emails.length);
      if (found.length === 1) {
        const c = await saveContact(organizer.id, found[0]!.name, found[0]!.nicknames, [...found[0]!.phones, ...found[0]!.emails]);
        draft.resolved.push(await toInvitee(c));
        draft.names.shift();
        continue;
      }
      if (found.length > 1) {
        const saved: { name: string; contactId: number }[] = [];
        for (const f of found.slice(0, 3)) {
          const c = await saveContact(organizer.id, f.name, f.nicknames, [...f.phones, ...f.emails]);
          saved.push({ name: c.name, contactId: c.id });
        }
        await askWhich(organizer, draft, saved);
        return;
      }
    }
    await sendText(organizer, `I don't have ${name}'s number. Share the contact card?`);
    await setPending(organizer.id, "contact_card", { draft });
    return;
  }

  // Remember the crew so "the usual" works next time.
  const memberIds = draft.resolved.map((r) => String(r.contactId)).filter((x) => x !== "null");
  if (memberIds.length) {
    const existing = await db.query.crews.findFirst({ where: and(eq(schema.crews.ownerId, organizer.id), eq(schema.crews.name, "the usual")) });
    if (existing) await db.update(schema.crews).set({ memberIds }).where(eq(schema.crews.id, existing.id));
    else await db.insert(schema.crews).values({ ownerId: organizer.id, name: "the usual", memberIds });
  }
  await startGroupPlan(organizer, draft.resolved, draft.meal, draft.when);
}

async function askWhich(organizer: User, draft: PlanDraft, options: { name: string; contactId: number }[]): Promise<void> {
  const names = options.map((o) => o.name);
  const q = names.length === 2 ? `${names[0]} or ${names[1]}?` : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}?`;
  await sendText(organizer, q);
  await setPending(organizer.id, "choose_contact", { draft, options });
}

export async function saveContact(ownerId: string, name: string, nicknames: string[], rawHandles: string[]): Promise<Contact> {
  const handles = [...new Set(rawHandles.map((h) => normalizeHandle(h)).filter((h): h is string => Boolean(h)))];
  const existing = handles.length
    ? await db.query.contacts.findFirst({ where: and(eq(schema.contacts.ownerId, ownerId), arrayOverlaps(schema.contacts.handles, handles)) })
    : undefined;
  if (existing) return existing;
  const [row] = await db
    .insert(schema.contacts)
    .values({ ownerId, name, nicknames, handles, foodieUserId: await foodieUserFor(handles) })
    .returning();
  return row!;
}

/** Answer to "Eric Chen or Eric Park?" */
export async function answerWhich(organizer: User, payload: Record<string, unknown>, text: string): Promise<boolean> {
  const draft = payload.draft as PlanDraft;
  const options = payload.options as { name: string; contactId: number }[];
  const t = text.trim().toLowerCase();
  const n = Number(t);
  const pick =
    (Number.isInteger(n) && options[n - 1]) ||
    options.find((o) => o.name.toLowerCase() === t) ||
    options.find((o) => o.name.toLowerCase().split(/\s+/).some((w) => w.length > 1 && t.split(/\s+/).includes(w) && w !== firstWord(o.name).toLowerCase()));
  if (!pick) return false;
  const c = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, pick.contactId) });
  if (!c) return false;
  draft.resolved.push(await toInvitee(c));
  draft.names.shift();
  await continueDraft(organizer, draft);
  return true;
}

/** A shared contact card for the name we couldn't find. */
export async function answerContactCard(organizer: User, payload: Record<string, unknown>, card: { name?: string; phones: string[]; emails: string[] }): Promise<void> {
  const draft = payload.draft as PlanDraft;
  const name = draft.names[0] ?? card.name ?? "Friend";
  const c = await saveContact(organizer.id, card.name ?? name, card.name && firstWord(card.name).toLowerCase() !== name.toLowerCase() ? [name] : [], [...card.phones, ...card.emails]);
  draft.resolved.push({ ...(await toInvitee(c)), name: firstWord(name.charAt(0).toUpperCase() + name.slice(1)) });
  draft.names.shift();
  await continueDraft(organizer, draft);
}
