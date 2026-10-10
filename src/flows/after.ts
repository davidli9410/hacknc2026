// Running late (9.6), feedback (6), and the bill split (9.7).
import { and, eq, inArray } from "drizzle-orm";
import { PersonalAgent } from "../agents/personal-agent.ts";
import { now } from "../clock.ts";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { sharedLocation } from "../integrations/findmy.ts";
import { bank, type NPurchase } from "../integrations/nessie.ts";
import { distanceKm } from "../integrations/places.ts";
import { travelTimes } from "../integrations/routes.ts";
import { chooseTravel } from "../engines/arrival.ts";
import { withLock } from "../lib/mutex.ts";
import { addMinutes, fmtClock, localDateKey, MINUTE } from "../lib/time.ts";
import { sendText, type User } from "../messaging.ts";
import { setPending } from "../pending.ts";
import { schedule } from "../scheduler.ts";
import { cents } from "../text.ts";

const TZ = () => config.timezone;
const LATE_THRESHOLD_MIN = 5;
const WATCH_AFTER_MEET_MIN = 15;
const WATCH_TICK_MIN = 2;

type Plan = typeof schema.plans.$inferSelect;

async function planWithMembers(planId: string) {
  const plan = await db.query.plans.findFirst({ where: eq(schema.plans.id, planId) });
  if (!plan) return null;
  const rows = await db.select().from(schema.planMembers).where(and(eq(schema.planMembers.planId, planId), eq(schema.planMembers.status, "in")));
  const users = rows.length ? await db.select().from(schema.users).where(inArray(schema.users.id, rows.map((r) => r.userId))) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return { plan, members: rows.map((r) => ({ ...r, user: byId.get(r.userId)! })).filter((m) => m.user) };
}

const first = (u: User) => u.name ?? "Someone";

// ---------------------------------------------------------------------------------------------
// Running late

/** Tells everyone else, if the slip is new and more than 5 minutes. Only the ETA is shared. */
export function reportLate(planId: string, userId: string, lateMin: number): Promise<boolean> {
  return withLock(`late:${planId}`, async () => {
    const data = await planWithMembers(planId);
    if (!data?.plan.meetTime) return false;
    const me = data.members.find((m) => m.userId === userId);
    if (!me) return false;
    const already = me.lateNotifiedMin ?? 0;
    if (lateMin <= LATE_THRESHOLD_MIN || lateMin - already < LATE_THRESHOLD_MIN) return false;
    const eta = addMinutes(data.plan.meetTime, lateMin);
    await db
      .update(schema.planMembers)
      .set({ lateNotifiedMin: lateMin, eta })
      .where(and(eq(schema.planMembers.planId, planId), eq(schema.planMembers.userId, userId)));
    for (const m of data.members) {
      if (m.userId === userId || m.user.paused) continue;
      await sendText(m.user, `${first(me.user)}'s about ${lateMin} min behind, now ${fmtClock(eta, TZ())}.`);
    }
    return true;
  });
}

/** One watch tick: from 30 min before the meet until everyone arrives or 15 min after. */
export async function lateWatchTick(planId: string): Promise<void> {
  const data = await planWithMembers(planId);
  if (!data || data.plan.status !== "confirmed" || !data.plan.meetTime || !data.plan.place) return;
  const meet = data.plan.meetTime;
  if (now().getTime() > addMinutes(meet, WATCH_AFTER_MEET_MIN).getTime()) return;
  let watching = false;
  for (const m of data.members) {
    if (m.arrived || m.user.paused || m.user.findmyStatus !== "sharing") continue;
    // Demo people sit in the same room; their lateness comes from /late.
    if (config.demo && m.user.demoKey) continue;
    const loc = await sharedLocation(m.user);
    if (!loc) {
      watching = true;
      continue;
    }
    const place = data.plan.place;
    if (distanceKm(loc, place) < 0.15) {
      await db.update(schema.planMembers).set({ arrived: true }).where(and(eq(schema.planMembers.planId, planId), eq(schema.planMembers.userId, m.userId)));
      continue;
    }
    watching = true;
    const t = (await travelTimes(loc, [place], now(), null)).get(place.placeId);
    const choice = chooseTravel(t?.walkMin ?? null, t?.driveMin ?? null);
    if (!choice) continue;
    const eta = addMinutes(now(), choice.travelMin);
    const late = Math.round((eta.getTime() - meet.getTime()) / MINUTE);
    await reportLate(planId, m.userId, late);
  }
  if (watching) await schedule("late_watch", addMinutes(now(), WATCH_TICK_MIN), { planId });
}

// ---------------------------------------------------------------------------------------------
// Feedback

export async function askFeedback(user: User, place: { placeId: string; refName: string }, planId: string): Promise<void> {
  if (user.paused) return;
  await sendText(user, `How was ${place.refName}?`, { purpose: "feedback", planId, placeId: place.placeId });
  await setPending(user.id, "feedback", { planId, placeId: place.placeId });
}

export async function afterMeal(planId: string): Promise<void> {
  const data = await planWithMembers(planId);
  if (!data?.plan.place || data.plan.status === "cancelled") return;
  for (const m of data.members) await askFeedback(m.user, data.plan.place, planId);
}

export async function applyFeedback(userId: string, placeId: string, planId: string | null, sentiment: "positive" | "negative"): Promise<void> {
  const plan = planId ? await db.query.plans.findFirst({ where: eq(schema.plans.id, planId) }) : null;
  const mem = await PersonalAgent.for(userId).placeMemory(placeId);
  const place = plan?.place ?? (mem ? { placeId, name: mem.name, cuisine: mem.cuisine } : null);
  if (!place) return;
  await PersonalAgent.for(userId).rate({ placeId, name: place.name, cuisine: place.cuisine }, sentiment);
}

// ---------------------------------------------------------------------------------------------
// Bill split

const money = (c: number) => (c % 100 === 0 ? `$${c / 100}` : cents(c));

function matchesPlace(merchant: { name: string; lat?: number; lng?: number } | null, place: { name: string; lat: number; lng: number }): boolean {
  if (!merchant) return false;
  if (merchant.name.trim().toLowerCase() === place.name.trim().toLowerCase()) return true;
  return merchant.lat != null && merchant.lng != null && distanceKm({ lat: merchant.lat, lng: merchant.lng }, place) < 0.15;
}

async function findBill(plan: Plan, members: { user: User }[]): Promise<{ payer: User; purchase: NPurchase } | null> {
  if (!plan.place || !plan.meetTime) return null;
  const day = localDateKey(plan.meetTime, TZ());
  const b = bank();
  for (const m of members) {
    if (!m.user.nessieAccountId) continue;
    const purchases = await b.purchases(m.user.nessieAccountId);
    for (const p of purchases.filter((x) => x.date === day).reverse()) {
      if (matchesPlace(await b.merchant(p.merchantId), plan.place)) return { payer: m.user, purchase: p };
    }
  }
  return null;
}

export function splitCheck(planId: string): Promise<void> {
  return withLock(`split:${planId}`, async () => {
    const data = await planWithMembers(planId);
    if (!data?.plan.place || data.plan.status === "cancelled") return;
    if (await db.query.splits.findFirst({ where: eq(schema.splits.planId, planId) })) return;
    const bill = await findBill(data.plan, data.members);
    if (bill) {
      await proposeSplit(planId, bill.payer, Math.round(bill.purchase.amount * 100), bill.purchase.id, true);
      return;
    }
    const organizer = data.members.find((m) => m.role === "organizer")?.user;
    if (!organizer || organizer.paused) return;
    await sendText(organizer, "Who paid?");
    await setPending(organizer.id, "who_paid", { planId });
  });
}

/** Demo /paid 52: record the organizer's purchase at the restaurant, then split. */
export async function recordDemoPayment(planId: string, payer: User, amount: number): Promise<void> {
  const data = await planWithMembers(planId);
  if (!data?.plan.place) return;
  const b = bank();
  let purchaseId: string | null = null;
  if (payer.nessieAccountId) {
    const merchant = await b.createMerchant(data.plan.place.name, ["Food", "Restaurant"], data.plan.place.lat, data.plan.place.lng);
    const p = await b.createPurchase(payer.nessieAccountId, merchant.id, amount, localDateKey(data.plan.meetTime ?? now(), TZ()), `Dinner at ${data.plan.place.name}`);
    purchaseId = p.id;
  }
  await db.delete(schema.splits).where(eq(schema.splits.planId, planId));
  await proposeSplit(planId, payer, Math.round(amount * 100), purchaseId, true);
}

export async function proposeSplit(planId: string, payer: User, totalCents: number, purchaseId: string | null, fromBank: boolean): Promise<void> {
  const data = await planWithMembers(planId);
  if (!data?.plan.place) return;
  const n = data.members.length;
  const each = Math.floor(totalCents / n);
  const [row] = await db.insert(schema.splits).values({ planId, payerId: payer.id, totalCents, nessiePurchaseId: purchaseId }).returning();
  const lead = fromBank ? `Saw ${money(totalCents)} at ${data.plan.place.refName}.` : `Got it, ${money(totalCents)}.`;
  await sendText(payer, `${lead} Split ${n} ways, ${money(each)} each?`);
  await setPending(payer.id, "confirm_split", { planId, splitId: row!.id });
}

const canTransfer = (u: User) => Boolean(u.nessieAccountId) && (bank().real || u.channel !== "imessage");

export async function confirmSplit(splitId: number, yes: boolean): Promise<void> {
  const split = await db.query.splits.findFirst({ where: eq(schema.splits.id, splitId) });
  if (!split || split.status !== "proposed") return;
  const data = await planWithMembers(split.planId);
  if (!data) return;
  const payer = data.members.find((m) => m.userId === split.payerId)?.user ?? (await PersonalAgent.for(split.payerId).user());
  if (!yes) {
    await db.update(schema.splits).set({ status: "declined" }).where(eq(schema.splits.id, splitId));
    await sendText(payer, "OK, I won't split it.");
    return;
  }
  await db.update(schema.splits).set({ status: "confirmed" }).where(eq(schema.splits.id, splitId));
  const each = Math.floor(split.totalCents / data.members.length);
  const meal = data.plan.meal === "lunch" ? "lunch" : "dinner";
  for (const m of data.members) {
    if (m.userId === split.payerId) continue;
    const [share] = await db.insert(schema.splitShares).values({ splitId, userId: m.userId, amountCents: each }).returning();
    const lead = `${first(payer)} covered ${meal}, your share is ${money(each)}.`;
    if (canTransfer(m.user) && canTransfer(payer)) {
      await sendText(m.user, `${lead} Send it?`);
      await setPending(m.userId, "send_share", { shareId: share!.id, planId: split.planId });
    } else {
      await sendText(m.user, `${lead} Paid another way? Reply 'paid'.`);
      await setPending(m.userId, "paid_other", { shareId: share!.id, planId: split.planId });
    }
  }
}

export async function sendShare(shareId: number, yes: boolean): Promise<void> {
  const share = await db.query.splitShares.findFirst({ where: eq(schema.splitShares.id, shareId) });
  if (!share || share.status === "sent" || share.status === "paid_other") return;
  const split = await db.query.splits.findFirst({ where: eq(schema.splits.id, share.splitId) });
  if (!split) return;
  const member = await PersonalAgent.for(share.userId).user();
  const payer = await PersonalAgent.for(split.payerId).user();
  if (!yes) {
    await sendText(member, "No problem. Reply 'paid' if you settle up another way.");
    await setPending(member.id, "paid_other", { shareId, planId: split.planId });
    return;
  }
  const res = await bank().transfer(member.nessieAccountId!, payer.nessieAccountId!, share.amountCents / 100, localDateKey(now(), TZ()), `Foodie split`);
  if (!res.ok) {
    await db.update(schema.splitShares).set({ status: "failed" }).where(eq(schema.splitShares.id, shareId));
    await sendText(member, "That didn't go through. Try again? yes/no");
    await setPending(member.id, "send_share", { shareId, planId: split.planId });
    return;
  }
  await db.update(schema.splitShares).set({ status: "sent", nessieTransferId: res.id ?? null }).where(eq(schema.splitShares.id, shareId));
  await sendText(member, "Sent.");
  if (!payer.paused) await sendText(payer, `${first(member)} sent you ${money(share.amountCents)}.`);
}

export async function markPaidOther(shareId: number): Promise<void> {
  const share = await db.query.splitShares.findFirst({ where: eq(schema.splitShares.id, shareId) });
  if (!share || share.status === "sent" || share.status === "paid_other") return;
  const split = await db.query.splits.findFirst({ where: eq(schema.splits.id, share.splitId) });
  if (!split) return;
  await db.update(schema.splitShares).set({ status: "paid_other" }).where(eq(schema.splitShares.id, shareId));
  const member = await PersonalAgent.for(share.userId).user();
  const payer = await PersonalAgent.for(split.payerId).user();
  await sendText(member, `Thanks, I'll let ${first(payer)} know.`);
  if (!payer.paused) await sendText(payer, `${first(member)} paid you back ${money(share.amountCents)} another way.`);
}

/** Organizer answered "Who paid?". */
export async function whoPaid(planId: string, organizer: User, answer: string): Promise<boolean> {
  const data = await planWithMembers(planId);
  if (!data) return false;
  const t = answer.trim().toLowerCase();
  const payer = /^(me|i did|i paid|i do|myself|mine)\b/.test(t)
    ? organizer
    : data.members.find((m) => m.user.name && t.includes(m.user.name.toLowerCase()))?.user;
  if (!payer) return false;
  const bill = await findBill(data.plan, [{ user: payer }]);
  if (bill) {
    await proposeSplit(planId, payer, Math.round(bill.purchase.amount * 100), bill.purchase.id, true);
    return true;
  }
  if (payer.paused) return true;
  await sendText(payer, `How much was ${data.plan.meal === "lunch" ? "lunch" : "dinner"}?`);
  await setPending(payer.id, "how_much", { planId });
  return true;
}

