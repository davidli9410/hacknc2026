// One personal agent per user. It owns that user's profile, memory, budget, calendar and location,
// and the only things it hands the coordinator are Constraints and Evaluations.
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { now } from "../clock.ts";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { DEMO_LOCATIONS, type DemoKey } from "../demo/data.ts";
import { matchesTarget } from "../diet.ts";
import { chooseTravel } from "../engines/arrival.ts";
import {
  computeBudget,
  computeBudgetWithoutBank,
  DEFAULT_MEALS_PER_WEEK,
  type BudgetResult,
  type MealKind,
  type Override,
} from "../engines/budget.ts";
import { computeFit } from "../engines/ranking.ts";
import { sharedLocation } from "../integrations/findmy.ts";
import { busyBlocks, deleteEvent, freeAtFrom, freeUntilFrom, hasCalendar, insertEvent } from "../integrations/google.ts";
import { bank, isRestaurant, type NPurchase } from "../integrations/nessie.ts";
import { travelTimes } from "../integrations/routes.ts";
import { daysInMonth, fmtClock, localDateKey, MINUTE, zonedParts } from "../lib/time.ts";
import type { User } from "../messaging.ts";
import {
  agentAddress,
  coordinatorAddress,
  logAgentMessage,
  roundArea,
  type ConstraintRequest,
  type Constraints,
  type Evaluation,
  type Proposal,
} from "../protocol.ts";

export const SOFT_VETO_DAYS = 30;
export const BAD_RATING_SUPPRESS_DAYS = 60;
const DAY = 24 * 60 * MINUTE;

export type NeedInput = { need: "location" | "free" | "budget" };

export class PersonalAgent {
  private static agents = new Map<string, PersonalAgent>();

  static for(userId: string): PersonalAgent {
    let a = PersonalAgent.agents.get(userId);
    if (!a) {
      a = new PersonalAgent(userId);
      PersonalAgent.agents.set(userId, a);
    }
    return a;
  }

  private constructor(readonly userId: string) {}

  async user(): Promise<User> {
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, this.userId) });
    if (!u) throw new Error(`no user ${this.userId}`);
    return u;
  }

  async update(values: Partial<typeof schema.users.$inferInsert>): Promise<void> {
    await db.update(schema.users).set(values).where(eq(schema.users.id, this.userId));
  }

  // -------------------------------------------------------------------------------------------
  // Location (private)

  /** Exact location, or null when we don't have one we trust. Never leaves this agent. */
  async location(): Promise<{ lat: number; lng: number } | null> {
    const u = await this.user();
    if (config.demo && u.demoKey && u.demoKey in DEMO_LOCATIONS) return DEMO_LOCATIONS[u.demoKey as DemoKey];
    if (u.findmyStatus === "sharing") {
      const live = await sharedLocation(u);
      if (live) {
        await this.update({ lat: live.lat, lng: live.lng, locationSource: "findmy", locationAt: live.at });
        return { lat: live.lat, lng: live.lng };
      }
    }
    if (u.lat == null || u.lng == null || !u.locationAt) return null;
    const age = now().getTime() - u.locationAt.getTime();
    if (u.locationSource === "findmy" && age < 2 * 60 * MINUTE) return { lat: u.lat, lng: u.lng };
    // "Where are you coming from?" answers hold for the rest of the day.
    if (u.locationSource === "text" && localDateKey(u.locationAt, config.timezone) === localDateKey(now(), config.timezone))
      return { lat: u.lat, lng: u.lng };
    return null;
  }

  async setTextLocation(lat: number, lng: number): Promise<void> {
    await this.update({ lat, lng, locationSource: "text", locationAt: now() });
  }

  // -------------------------------------------------------------------------------------------
  // Calendar (private)

  async hasCalendar(): Promise<boolean> {
    return hasCalendar(await this.user());
  }

  /** Earliest they can leave at or after `from`, or null without a calendar. */
  async freeAt(from: Date): Promise<Date | null> {
    const u = await this.user();
    const blocks = await busyBlocks(u, new Date(from.getTime() - 12 * 60 * MINUTE), new Date(from.getTime() + 12 * 60 * MINUTE));
    return blocks ? freeAtFrom(blocks, from) : null;
  }

  /** When their next commitment today starts, or null. */
  async freeUntil(from: Date): Promise<Date | null> {
    const u = await this.user();
    const end = new Date(from.getTime() + 12 * 60 * MINUTE);
    const blocks = await busyBlocks(u, from, end);
    if (!blocks) return null;
    const next = freeUntilFrom(blocks, from);
    return next && localDateKey(next, config.timezone) === localDateKey(from, config.timezone) ? next : null;
  }

  /**
   * Puts a meal on the owner's calendar, replacing an earlier event for the same plan.
   * `onCalendar` is true only when it really is there (or in the terminal/sim stand-in).
   */
  async writeMealEvent(ev: { previousEventId: string | null; title: string; meet: Date; leaveAt: Date; minutes: number }): Promise<{ eventId: string | null; onCalendar: boolean }> {
    const u = await this.user();
    if (ev.previousEventId) await deleteEvent(u, ev.previousEventId);
    const res = await insertEvent(u, {
      summary: ev.title,
      start: ev.meet,
      end: new Date(ev.meet.getTime() + ev.minutes * MINUTE),
      description: `Leave at ${fmtClock(ev.leaveAt, config.timezone)}. Planned with Foodie.`,
    });
    return { eventId: res.ok ? (res.id ?? null) : null, onCalendar: res.ok && (res.real || u.channel !== "imessage") };
  }

  // -------------------------------------------------------------------------------------------
  // Budget (private)

  async restaurantPurchases(): Promise<NPurchase[]> {
    const u = await this.user();
    if (!u.nessieAccountId) return [];
    const b = bank();
    const all = await b.purchases(u.nessieAccountId);
    const out: NPurchase[] = [];
    for (const p of all) if (isRestaurant(await b.merchant(p.merchantId))) out.push(p);
    return out;
  }

  async todaysOverride(at = now()): Promise<Override | null> {
    const row = await db.query.overrides.findFirst({
      where: and(eq(schema.overrides.userId, this.userId), eq(schema.overrides.date, localDateKey(at, config.timezone))),
      orderBy: (o, { desc }) => [desc(o.id)],
    });
    return row ? { kind: row.kind as Override["kind"], amount: row.amount } : null;
  }

  async setOverride(kind: Override["kind"], amount: number): Promise<void> {
    await db.insert(schema.overrides).values({ userId: this.userId, date: localDateKey(now(), config.timezone), kind, amount });
  }

  /** This meal's budget, or null when we know nothing about their money. */
  async budget(meal: MealKind, at = now()): Promise<BudgetResult | null> {
    const u = await this.user();
    const override = await this.todaysOverride(at);
    if (u.monthlyLimit != null && u.mealCap != null && u.nessieAccountId) {
      const p = zonedParts(at, config.timezone);
      const monthKey = `${p.year}-${String(p.month).padStart(2, "0")}`;
      const today = localDateKey(at, config.timezone);
      const spent = (await this.restaurantPurchases())
        .filter((x) => x.date.startsWith(monthKey) && x.date <= today)
        .reduce((s, x) => s + x.amount, 0);
      return computeBudget({
        monthlyLimit: u.monthlyLimit,
        mealCap: u.mealCap,
        spentThisMonth: spent,
        mealsPerWeek: u.mealsPerWeek ?? DEFAULT_MEALS_PER_WEEK,
        dayOfMonth: p.day,
        daysInMonth: daysInMonth(p.year, p.month),
        meal,
        override,
      });
    }
    if (u.mealCap != null) return computeBudgetWithoutBank(u.mealCap, override);
    if (override?.kind === "treat") return computeBudgetWithoutBank(override.amount, override);
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Memory (private)

  async tasteScore(cuisine: string): Promise<number> {
    const row = await db.query.taste.findFirst({ where: and(eq(schema.taste.userId, this.userId), eq(schema.taste.cuisine, cuisine.toLowerCase())) });
    return row?.score ?? 0;
  }

  async adjustTaste(cuisine: string, delta: number): Promise<void> {
    const key = cuisine.toLowerCase();
    const next = Math.max(-1, Math.min(1, (await this.tasteScore(key)) + delta));
    await db
      .insert(schema.taste)
      .values({ userId: this.userId, cuisine: key, score: next })
      .onConflictDoUpdate({ target: [schema.taste.userId, schema.taste.cuisine], set: { score: next } });
  }

  async placeMemory(placeId: string) {
    return db.query.placeMemory.findFirst({ where: and(eq(schema.placeMemory.userId, this.userId), eq(schema.placeMemory.placeId, placeId)) });
  }

  /** Picking a place: +0.1 to that cuisine. Not picking something is not a signal. */
  async learnChoice(place: { cuisine: string }): Promise<void> {
    await this.adjustTaste(place.cuisine, 0.1);
  }

  async recordVisit(place: { placeId: string; name: string; cuisine: string }, at = now()): Promise<void> {
    await db
      .insert(schema.placeMemory)
      .values({ userId: this.userId, placeId: place.placeId, name: place.name, cuisine: place.cuisine, visits: 1, lastVisit: at })
      .onConflictDoUpdate({
        target: [schema.placeMemory.userId, schema.placeMemory.placeId],
        set: { visits: sql`${schema.placeMemory.visits} + 1`, lastVisit: at, name: place.name, cuisine: place.cuisine },
      });
  }

  /** Positive: rating +1 and +0.2 to the cuisine. Negative: rating −1, hidden for 60 days. */
  async rate(place: { placeId: string; name: string; cuisine: string }, sentiment: "positive" | "negative"): Promise<void> {
    const rating = sentiment === "positive" ? 1 : -1;
    await db
      .insert(schema.placeMemory)
      .values({ userId: this.userId, placeId: place.placeId, name: place.name, cuisine: place.cuisine, rating, ratedAt: now() })
      .onConflictDoUpdate({ target: [schema.placeMemory.userId, schema.placeMemory.placeId], set: { rating, ratedAt: now() } });
    if (rating === 1) await this.adjustTaste(place.cuisine, 0.2);
  }

  async addVeto(target: string, never: boolean, label?: string): Promise<void> {
    const t = target.toLowerCase().trim();
    const scope = t.startsWith("demo-") || /^ChIJ/.test(target) ? "place" : "cuisine";
    await db.insert(schema.vetoes).values({
      userId: this.userId,
      scope,
      target: scope === "place" ? target : t,
      label: label ?? target,
      kind: never ? "never" : "soft",
      expiresAt: never ? null : new Date(now().getTime() + SOFT_VETO_DAYS * DAY),
    });
  }

  async activeVetoes() {
    return db.query.vetoes.findMany({
      where: and(eq(schema.vetoes.userId, this.userId), or(isNull(schema.vetoes.expiresAt), gt(schema.vetoes.expiresAt, now()))),
    });
  }

  /** Vetoes, dislikes and recently disliked places. Reasons never leave the agent. */
  async isVetoed(place: { placeId: string; name: string; cuisine: string; primaryType?: string }): Promise<boolean> {
    const u = await this.user();
    for (const v of await this.activeVetoes()) {
      if (v.scope === "place" ? v.target === place.placeId : matchesTarget(v.target, place)) return true;
    }
    if (u.dislikes.some((d) => matchesTarget(d, place))) return true;
    const mem = await this.placeMemory(place.placeId);
    if (mem?.rating === -1 && mem.ratedAt && now().getTime() - mem.ratedAt.getTime() < BAD_RATING_SUPPRESS_DAYS * DAY) return true;
    return false;
  }

  async fit(place: { placeId: string; cuisine: string }): Promise<number> {
    const mem = await this.placeMemory(place.placeId);
    return computeFit(await this.tasteScore(place.cuisine), mem?.rating);
  }

  // -------------------------------------------------------------------------------------------
  // Protocol

  /** Round 1. Returns what this agent needs from its owner when it can't answer yet. */
  async constraints(req: ConstraintRequest, opts: { freeAtOverride?: Date | null; meal: MealKind }): Promise<Constraints | NeedInput> {
    const earliest = new Date(req.window.earliest);
    const from = new Date(Math.max(now().getTime(), earliest.getTime() - 90 * MINUTE));
    const loc = await this.location();
    if (!loc) return { need: "location" };
    let freeAt = opts.freeAtOverride ?? (await this.freeAt(from));
    if (!freeAt) return { need: "free" };
    if (freeAt.getTime() < now().getTime()) freeAt = now();
    const budget = await this.budget(opts.meal, earliest);
    const u = await this.user();
    const answer: Constraints = {
      planId: req.planId,
      userId: this.userId,
      freeAt: freeAt.toISOString(),
      maxPrice: budget ? budget.hardMax : 999,
      dietTags: u.dietTags,
      area: { lat: roundArea(loc.lat), lng: roundArea(loc.lng) },
    };
    await logAgentMessage(req.planId, agentAddress(this.userId), coordinatorAddress(req.planId), "Constraints", answer);
    return answer;
  }

  /** Round 2. Travel from the private location, fit from private memory, veto with no reason. */
  async evaluate(proposal: Proposal, freeAt: Date): Promise<Evaluation> {
    const u = await this.user();
    const loc = (await this.location()) ?? { lat: u.lat ?? 0, lng: u.lng ?? 0 };
    const departure = new Date(Math.max(now().getTime(), freeAt.getTime()));
    const travel = await travelTimes(loc, proposal.meetCandidates, departure, u.demoKey);
    const perCandidate: Evaluation["perCandidate"] = [];
    for (const c of proposal.meetCandidates) {
      const t = travel.get(c.placeId);
      const choice = chooseTravel(t?.walkMin ?? null, t?.driveMin ?? null) ?? { travelMin: 999, mode: "drive" as const };
      const place = { placeId: c.placeId, name: c.name, cuisine: c.cuisine, primaryType: c.tags[0] };
      perCandidate.push({
        placeId: c.placeId,
        travelMin: choice.travelMin,
        mode: choice.mode,
        fit: Number((await this.fit(place)).toFixed(3)),
        veto: await this.isVetoed(place),
      });
    }
    const evaluation: Evaluation = { planId: proposal.planId, userId: this.userId, perCandidate };
    await logAgentMessage(proposal.planId, agentAddress(this.userId), coordinatorAddress(proposal.planId), "Evaluation", evaluation);
    return evaluation;
  }

  /** "What do you know about me?" — only this user's own data. */
  async summary(): Promise<string> {
    const u = await this.user();
    const parts: string[] = [];
    if (u.dietTags.length) parts.push(u.dietTags.join(", "));
    if (u.monthlyLimit != null) parts.push(`$${u.monthlyLimit} a month`);
    if (u.mealCap != null) parts.push(`under $${u.mealCap} a meal`);
    const likes = await db.query.taste.findMany({ where: and(eq(schema.taste.userId, this.userId), gt(schema.taste.score, 0.25)) });
    if (likes.length) parts.push(`you like ${likes.map((l) => l.cuisine).sort().slice(0, 3).join(", ")}`);
    const vetoes = await this.activeVetoes();
    if (vetoes.length || u.dislikes.length) parts.push(`no ${[...u.dislikes, ...vetoes.map((v) => v.label ?? v.target)].slice(0, 3).join(", ")}`);
    const connected = [u.googleTokens ? "calendar" : null, u.nessieAccountId ? "bank" : null, u.findmyStatus === "sharing" ? "location" : null].filter(Boolean);
    if (connected.length) parts.push(`connected: ${connected.join(", ")}`);
    if (parts.length === 0) return `I don't know much yet. Text me when you're hungry.`;
    return `Here's what I know: ${parts.join("; ")}.\nSay "forget" and a thing to delete it.`;
  }
}
