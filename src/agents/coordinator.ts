// One coordinator per group plan. It asks every personal agent for constraints, proposes candidates,
// aggregates evaluations, runs the vote and confirms. It never sees coordinates, calendars or budgets —
// only what the agents send back.
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { now } from "../clock.ts";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import type { PlanOption } from "../db/schema.ts";
import { dietOk } from "../diet.ts";
import type { MealKind } from "../engines/budget.ts";
import { crewNovelty, rankGroup, TRAVEL_CAP_RELAXED_MIN, type GroupCandidate, type Relaxation } from "../engines/ranking.ts";
import { distanceKm, isOpenBetween, searchNearby, type Place } from "../integrations/places.ts";
import { randomCode } from "../lib/crypto.ts";
import { withLock } from "../lib/mutex.ts";
import { addMinutes, atLocalTime, ceil5, fmtClock, localDateKey, MINUTE } from "../lib/time.ts";
import { sendGroupPoll, sendPoll, sendText, type User } from "../messaging.ts";
import { clearPending, getPending, setPending } from "../pending.ts";
import {
  agentAddress,
  coordinatorAddress,
  logAgentMessage,
  type ConstraintRequest,
  type Constraints,
  type Proposal,
  type ProposalCandidate,
} from "../protocol.ts";
import { cancelJobs, schedule } from "../scheduler.ts";
import { dollars, joinNames } from "../text.ts";
import { PersonalAgent } from "./personal-agent.ts";

const TZ = () => config.timezone;
export const INVITE_TIMEOUT_MIN = 15;
export const GO_WITHOUT_WAIT_MIN = 10;
export const POLL_MIN = 10;
export const CREW_COOLDOWN_DAYS = 14;
export const MAX_GROUP = 8;
const MEAL_LENGTH_MIN = 90;

type Plan = typeof schema.plans.$inferSelect;
type Member = typeof schema.planMembers.$inferSelect & { user: User };

export type Invitee = { name: string; userId: string | null; contactId: number | null; handle: string | null };

// ---------------------------------------------------------------------------------------------
// Reading state

async function getPlan(planId: string): Promise<Plan> {
  const p = await db.query.plans.findFirst({ where: eq(schema.plans.id, planId) });
  if (!p) throw new Error(`no plan ${planId}`);
  return p;
}

async function getMembers(planId: string): Promise<Member[]> {
  const rows = await db.select().from(schema.planMembers).where(eq(schema.planMembers.planId, planId));
  if (rows.length === 0) return [];
  const users = await db.select().from(schema.users).where(inArray(schema.users.id, rows.map((r) => r.userId)));
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows
    .filter((r) => byId.has(r.userId))
    .map((r) => ({ ...r, user: byId.get(r.userId)! }))
    .sort((a, b) => (a.role === "organizer" ? -1 : b.role === "organizer" ? 1 : a.addedAt.getTime() - b.addedAt.getTime()));
}

async function updateMember(planId: string, userId: string, values: Partial<typeof schema.planMembers.$inferInsert>): Promise<void> {
  await db
    .update(schema.planMembers)
    .set(values)
    .where(and(eq(schema.planMembers.planId, planId), eq(schema.planMembers.userId, userId)));
}

/** Invites nobody has used yet and that haven't expired (going without someone expires theirs). */
async function openInvites(planId: string) {
  return db.query.invites.findMany({
    where: and(eq(schema.invites.planId, planId), isNull(schema.invites.usedBy), gt(schema.invites.expiresAt, now())),
  });
}

const firstName = (u: User) => u.name ?? "Your friend";

function mealPhrase(plan: Plan): string {
  const today = localDateKey(now(), TZ()) === localDateKey(plan.windowEarliest ?? now(), TZ());
  const meal = plan.meal === "lunch" ? "lunch" : "dinner";
  if (!today) return `${meal} tomorrow`;
  return meal === "dinner" ? "dinner tonight" : "lunch today";
}

/** Active group plans this user is part of, newest first. */
export async function activePlanFor(userId: string): Promise<Plan | null> {
  const rows = await db
    .select({ plan: schema.plans })
    .from(schema.plans)
    .innerJoin(schema.planMembers, eq(schema.planMembers.planId, schema.plans.id))
    .where(and(eq(schema.planMembers.userId, userId), inArray(schema.plans.status, ["gathering", "voting", "confirmed"]), eq(schema.plans.kind, "group")))
    .orderBy(schema.plans.createdAt);
  return rows.at(-1)?.plan ?? null;
}

// ---------------------------------------------------------------------------------------------
// Starting a plan

export function planWindow(meal: MealKind, when: string | undefined, at: Date): { earliest: Date; latest: Date } {
  const base = when === "tomorrow" ? addMinutes(at, 24 * 60) : at;
  const [eh, em, lh, lm] = meal === "lunch" ? [11, 30, 14, 0] : [17, 30, 21, 0];
  let earliest = atLocalTime(base, eh, em, TZ());
  const latest = atLocalTime(base, lh, lm, TZ());
  if (earliest.getTime() < at.getTime()) earliest = at;
  return { earliest, latest };
}

export async function startGroupPlan(organizer: User, invitees: Invitee[], meal: MealKind, when?: string): Promise<string> {
  const planId = crypto.randomUUID();
  const window = planWindow(meal, when, now());
  return withLock(`plan:${planId}`, async () => {
    await db.insert(schema.plans).values({
      id: planId,
      organizerId: organizer.id,
      kind: "group",
      status: "gathering",
      meal,
      windowEarliest: window.earliest,
      windowLatest: window.latest,
    });
    await db.insert(schema.planMembers).values({ planId, userId: organizer.id, role: "organizer", status: "in" });

    const onFoodie = invitees.filter((i) => i.userId && i.userId !== organizer.id);
    const newcomers = invitees.filter((i) => !i.userId);
    for (const i of onFoodie) await db.insert(schema.planMembers).values({ planId, userId: i.userId!, role: "member", status: "invited" }).onConflictDoNothing();
    const links: { name: string; url: string }[] = [];
    for (const n of newcomers) {
      const code = randomCode(4);
      await db.insert(schema.invites).values({
        code,
        planId,
        inviterId: organizer.id,
        inviteeName: n.name,
        inviteeHandle: n.handle,
        contactId: n.contactId,
        expiresAt: addMinutes(now(), 24 * 60),
      });
      links.push({ name: n.name, url: `${config.publicBaseUrl}/i/${code}` });
    }

    // Organizer hears who's on Foodie and gets a link to forward for anyone who isn't.
    const parts: string[] = ["On it."];
    const names = onFoodie.map((i) => i.name);
    if (names.length === 1) parts.push(`${names[0]}'s on Foodie${links.length ? "." : ", so I'm asking now."}`);
    else if (names.length > 1) parts.push(`${joinNames(names)} are on Foodie${links.length ? "." : ", so I'm asking now."}`);
    if (links.length === 1) {
      parts.push(`${links[0]!.name} isn't yet, so send ${links[0]!.name} this: ${links[0]!.url}`);
    } else if (links.length > 1) {
      parts.push(`${joinNames(links.map((l) => l.name))} aren't yet, so send ${joinNames(links.map((l) => `${l.name} this: ${l.url}`))}`);
    }
    await sendText(organizer, parts.join(" "));

    await gatherConstraints(planId, organizer.id);
    const organizerFree = await knownFreeAts(planId);
    for (const i of onFoodie) await inviteExistingMember(planId, i.userId!, organizerFree);
    await schedule("invite_timeout", addMinutes(now(), INVITE_TIMEOUT_MIN), { planId });
    await maybeProceed(planId);
    return planId;
  });
}

async function knownFreeAts(planId: string): Promise<Date[]> {
  const members = await getMembers(planId);
  return members.filter((m) => m.constraints).map((m) => new Date((m.constraints as Constraints).freeAt));
}

/** The invited member's agent writes the invite, using its own private free time. */
async function inviteExistingMember(planId: string, userId: string, othersFree: Date[]): Promise<void> {
  const plan = await getPlan(planId);
  const members = await getMembers(planId);
  const me = members.find((m) => m.userId === userId)!;
  const organizer = members.find((m) => m.role === "organizer")!;
  const others = [
    ...members.filter((m) => m.role !== "organizer" && m.userId !== userId).map((m) => firstName(m.user)),
    ...(await openInvites(planId)).map((i) => i.inviteeName),
  ];
  const withWho = others.length ? `you and ${joinNames(others)}` : "you";
  const lead = `${firstName(organizer.user)}'s planning ${mealPhrase(plan)} with ${withWho}.`;
  const agent = PersonalAgent.for(userId);
  const free = await agent.freeAt(new Date(Math.max(now().getTime(), plan.windowEarliest!.getTime() - 90 * MINUTE)));
  if (!free) {
    await sendText(me.user, `${lead} When are you free?`);
    await setPending(userId, "when_free", { planId });
    return;
  }
  const mine = free.getTime() < now().getTime() ? now() : free;
  const latestOther = othersFree.reduce((m, d) => Math.max(m, d.getTime()), 0);
  const aim = ceil5(addMinutes(new Date(Math.max(latestOther, mine.getTime())), 10));
  await sendText(me.user, `${lead} You're free at ${fmtClock(mine, TZ())}, so I'm aiming for about ${fmtClock(aim, TZ())}. In?`);
  await setPending(userId, "invite_in", { planId });
}

// ---------------------------------------------------------------------------------------------
// Round 1: constraints

/** Asks a member's agent for constraints. If the agent needs something from its owner, it asks them. */
async function gatherConstraints(planId: string, userId: string, freeAtOverride?: Date | null): Promise<boolean> {
  const plan = await getPlan(planId);
  const req: ConstraintRequest = {
    planId,
    window: { earliest: plan.windowEarliest!.toISOString(), latest: plan.windowLatest!.toISOString() },
  };
  await logAgentMessage(planId, coordinatorAddress(planId), agentAddress(userId), "ConstraintRequest", req);
  const existing = (await getMembers(planId)).find((m) => m.userId === userId);
  const result = await PersonalAgent.for(userId).constraints(req, { meal: plan.meal as MealKind, freeAtOverride: freeAtOverride ?? null });
  if ("need" in result) {
    const user = existing?.user ?? (await PersonalAgent.for(userId).user());
    if (result.need === "location") {
      await sendText(user, "Where are you coming from?");
      await setPending(userId, "where_from", { planId, resume: "plan", freeAt: freeAtOverride?.toISOString() ?? null });
    } else if (result.need === "free") {
      await sendText(user, "When are you free?");
      await setPending(userId, "when_free", { planId });
    }
    return false;
  }
  await updateMember(planId, userId, { constraints: result });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Member responses (each entry point takes the plan lock)

export function memberIn(planId: string, userId: string, freeAt?: Date | null): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    await clearPending(userId, "invite_in");
    await clearPending(userId, "when_free");
    await updateMember(planId, userId, { status: "in" });
    const ok = await gatherConstraints(planId, userId, freeAt ?? null);
    if (ok) await maybeProceed(planId);
  });
}

export function memberOut(planId: string, userId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    await clearPending(userId);
    await updateMember(planId, userId, { status: "out" });
    const user = await PersonalAgent.for(userId).user();
    await sendText(plan.organizerId, `${firstName(user)} can't make it.`);
    if (plan.status === "voting") {
      const stillIn = (await getMembers(planId)).filter((m) => m.status === "in");
      if (stillIn.length < 2) await callOff(planId);
      else await rerun(planId, "update");
    } else await maybeProceed(planId);
  });
}

/** "after 7" — a ConstraintsUpdate from the member's agent. */
export function memberAvailability(planId: string, userId: string, freeAt: Date): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    const member = (await getMembers(planId)).find((m) => m.userId === userId);
    if (!member) return;
    if (member.status !== "in") {
      await updateMember(planId, userId, { status: "in" });
    }
    await clearPending(userId, "invite_in");
    await clearPending(userId, "when_free");
    const prior = member.constraints as Constraints | null;
    if (prior) {
      const update: Constraints = { ...prior, freeAt: freeAt.toISOString() };
      await logAgentMessage(planId, agentAddress(userId), coordinatorAddress(planId), "ConstraintsUpdate", update);
      await updateMember(planId, userId, { constraints: update });
    } else {
      const ok = await gatherConstraints(planId, userId, freeAt);
      if (!ok) return;
    }
    if (plan.status === "voting") await rerun(planId, "update");
    else if (plan.status === "confirmed") {
      await sendText(userId, "Got it. I'll let everyone know if you'll be late.");
    } else await maybeProceed(planId);
  });
}

/** The member's private location answer arrived; finish their constraints. */
export function memberLocationReady(planId: string, userId: string, freeAt?: Date | null): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const ok = await gatherConstraints(planId, userId, freeAt ?? null);
    if (ok) await maybeProceed(planId);
  });
}

/** A newcomer used an invite code. */
export function newcomerJoined(code: string, userId: string): Promise<{ planId: string; organizer: User; others: string[] } | null> {
  return (async () => {
    const invite = await db.query.invites.findFirst({ where: eq(schema.invites.code, code.toUpperCase()) });
    if (!invite || invite.expiresAt.getTime() < now().getTime()) return null;
    return withLock(`plan:${invite.planId}`, async () => {
      const plan = await getPlan(invite.planId);
      if (plan.status === "done" || plan.status === "cancelled") return null;
      if (!invite.usedBy) await db.update(schema.invites).set({ usedBy: userId }).where(eq(schema.invites.code, invite.code));
      await db
        .insert(schema.planMembers)
        .values({ planId: plan.id, userId, role: "member", status: "in" })
        .onConflictDoUpdate({ target: [schema.planMembers.planId, schema.planMembers.userId], set: { status: "in" } });
      if (invite.contactId) await db.update(schema.contacts).set({ foodieUserId: userId }).where(eq(schema.contacts.id, invite.contactId));
      const members = await getMembers(plan.id);
      const organizer = members.find((m) => m.role === "organizer")!.user;
      const others = [
        ...members.filter((m) => m.role !== "organizer" && m.userId !== userId && m.status !== "out").map((m) => firstName(m.user)),
        ...(await openInvites(plan.id)).map((i) => i.inviteeName),
      ];
      return { planId: plan.id, organizer, others };
    });
  })();
}

/** A newcomer finished onboarding. */
export function newcomerReady(planId: string, userId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    if (plan.status === "cancelled" || plan.status === "done") return;
    await updateMember(planId, userId, { status: "in" }); // may have been planned without while finishing setup
    const ok = await gatherConstraints(planId, userId);
    if (!ok) return;
    const member = (await getMembers(planId)).find((m) => m.userId === userId)!;
    const c = member.constraints as Constraints;
    const lead = `You're set and free at ${fmtClock(new Date(c.freeAt), TZ())}.`;
    if (plan.status === "gathering") {
      await updateMember(planId, userId, { lead });
      await maybeProceed(planId);
      const after = await getPlan(planId);
      if (after.status === "gathering") {
        await sendText(userId, `${lead} I'll send options once everyone's in.`);
        await updateMember(planId, userId, { lead: null });
      }
    } else if (plan.status === "voting") {
      await joinVoting(planId, userId, lead);
    } else if (plan.status === "confirmed") {
      await joinConfirmed(planId, userId);
    }
  });
}

/** Organizer answered "Go without them?" */
export function goWithout(planId: string, yes: boolean): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    if (yes) await dropWaiting(planId);
    else await schedule("go_without_timeout", addMinutes(now(), GO_WITHOUT_WAIT_MIN), { planId });
    await maybeProceed(planId);
  });
}

async function dropWaiting(planId: string): Promise<void> {
  const members = await getMembers(planId);
  for (const m of members) {
    // Not answered yet, or still finishing setup. They can still join later.
    if (m.status === "invited" || (m.status === "in" && !m.constraints && m.role !== "organizer")) {
      await updateMember(planId, m.userId, { status: "out" });
      await clearPending(m.userId, "invite_in");
    }
  }
  for (const i of await openInvites(planId)) {
    await db.update(schema.invites).set({ expiresAt: now() }).where(eq(schema.invites.code, i.code));
  }
}

export function inviteTimeout(planId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    if (plan.status !== "gathering" || plan.nudged) return;
    const members = await getMembers(planId);
    const waiting = [
      ...members.filter((m) => m.status === "invited").map((m) => firstName(m.user)),
      ...(await openInvites(planId)).map((i) => i.inviteeName),
      ...members.filter((m) => m.status === "in" && !m.constraints).map((m) => firstName(m.user)),
    ];
    if (waiting.length === 0) return;
    await db.update(schema.plans).set({ nudged: true }).where(eq(schema.plans.id, planId));
    await sendText(plan.organizerId, `Still waiting on ${joinNames(waiting)}. Go without ${waiting.length === 1 ? waiting[0] : "them"}? yes/no`);
    await setPending(plan.organizerId, "go_without", { planId });
    await schedule("go_without_timeout", addMinutes(now(), GO_WITHOUT_WAIT_MIN), { planId });
  });
}

export function goWithoutTimeout(planId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    if (plan.status !== "gathering") return;
    await clearPending(plan.organizerId, "go_without");
    await dropWaiting(planId);
    await maybeProceed(planId);
  });
}

// ---------------------------------------------------------------------------------------------
// Rounds

async function maybeProceed(planId: string): Promise<void> {
  const plan = await getPlan(planId);
  if (plan.status !== "gathering") return;
  const members = await getMembers(planId);
  if (members.some((m) => m.status === "invited")) return;
  if ((await openInvites(planId)).length > 0) return;
  const inMembers = members.filter((m) => m.status === "in");
  if (inMembers.some((m) => !m.constraints)) return;
  if (inMembers.length < 2) {
    await callOff(planId);
    return;
  }
  await cancelJobs("invite_timeout", { planId });
  await cancelJobs("go_without_timeout", { planId });
  await clearPending(plan.organizerId, "go_without");
  await runRounds(planId, "first");
}

async function callOff(planId: string): Promise<void> {
  const plan = await getPlan(planId);
  await db.update(schema.plans).set({ status: "cancelled" }).where(eq(schema.plans.id, planId));
  for (const kind of ["invite_timeout", "go_without_timeout", "poll_close"] as const) await cancelJobs(kind, { planId });
  for (const m of await getMembers(planId)) {
    const p = await getPending(m.userId);
    if (p?.planId === planId) await clearPending(m.userId);
  }
  await sendText(plan.organizerId, "Nobody else can make it, so I called it off. Text me if you want somewhere for just you.");
}

type RunReason = "first" | "update" | "join";

async function rerun(planId: string, reason: RunReason): Promise<void> {
  await db.update(schema.planMembers).set({ vote: null }).where(eq(schema.planMembers.planId, planId));
  await db.update(schema.polls).set({ open: false }).where(eq(schema.polls.planId, planId));
  await runRounds(planId, reason);
}

/** Pre-filter the coordinator can apply itself: price ceiling, diet, crew cooldown, open sometime in the window. */
async function candidatePlaces(plan: Plan, constraints: Constraints[], ceiling: number, crewKey: string): Promise<Place[]> {
  const centroid = {
    lat: constraints.reduce((s, c) => s + c.area.lat, 0) / constraints.length,
    lng: constraints.reduce((s, c) => s + c.area.lng, 0) / constraints.length,
  };
  const spread = Math.max(...constraints.map((c) => distanceKm(centroid, c.area)));
  const places = await searchNearby(centroid, (spread + 8) * 1000);
  const diet = [...new Set(constraints.flatMap((c) => c.dietTags))];
  const recent = await db.query.crewHistory.findMany({
    where: and(eq(schema.crewHistory.crewKey, crewKey), gt(schema.crewHistory.at, addMinutes(now(), -CREW_COOLDOWN_DAYS * 24 * 60))),
  });
  const cooling = new Set(recent.map((r) => r.placeId));
  const earliest = plan.windowEarliest!;
  const latest = addMinutes(plan.windowLatest!, 30);
  const openSometime = (p: Place) => {
    for (let t = earliest.getTime(); t <= latest.getTime(); t += 15 * MINUTE) {
      if (isOpenBetween(p.periods, new Date(t), new Date(t + 75 * MINUTE))) return true;
    }
    return false;
  };
  return places.filter((p) => p.priceEach <= ceiling && dietOk(p, diet) && !cooling.has(p.placeId) && openSometime(p)).slice(0, 20);
}

const crewKeyFor = (userIds: string[]) => [...userIds].sort().join("+");

async function runRounds(planId: string, reason: RunReason): Promise<void> {
  const plan = await getPlan(planId);
  const members = (await getMembers(planId)).filter((m) => m.status === "in" && m.constraints);
  const constraints = members.map((m) => m.constraints as Constraints);
  const ceiling = Math.min(...constraints.map((c) => c.maxPrice));
  const crewKey = crewKeyFor(members.map((m) => m.userId));
  await db.update(schema.plans).set({ crewKey }).where(eq(schema.plans.id, planId));

  const places = await candidatePlaces(plan, constraints, ceiling, crewKey);
  const byId = new Map(places.map((p) => [p.placeId, p]));
  const proposal: Proposal = {
    planId,
    meetCandidates: places.map(
      (p): ProposalCandidate => ({ placeId: p.placeId, name: p.name, lat: p.lat, lng: p.lng, priceEach: p.priceEach, cuisine: p.cuisine, tags: [p.primaryType, ...p.tags] }),
    ),
  };

  // Round 2: every personal agent evaluates privately.
  const evaluations: { member: Member; constraints: Constraints; evaluation: Awaited<ReturnType<PersonalAgent["evaluate"]>> }[] = [];
  for (const m of members) {
    await logAgentMessage(planId, coordinatorAddress(planId), agentAddress(m.userId), "Proposal", proposal);
    const c = m.constraints as Constraints;
    evaluations.push({ member: m, constraints: c, evaluation: await PersonalAgent.for(m.userId).evaluate(proposal, new Date(c.freeAt)) });
  }

  const history = await db.query.crewHistory.findMany({ where: eq(schema.crewHistory.crewKey, crewKey) });
  const lastVisit = (placeId: string) => {
    const visits = history.filter((h) => h.placeId === placeId).map((h) => h.at.getTime());
    return visits.length ? new Date(Math.max(...visits)) : null;
  };

  const candidates: GroupCandidate[] = places.map((p) => ({
    placeId: p.placeId,
    cuisine: p.cuisine,
    priceEach: p.priceEach,
    dietOk: true, // already filtered above
    isOpen: (from, to) => isOpenBetween(p.periods, from, to),
    members: evaluations.map(({ member, constraints: c, evaluation }) => {
      const e = evaluation.perCandidate.find((x) => x.placeId === p.placeId)!;
      return { userId: member.userId, freeAt: new Date(c.freeAt), travelMin: e.travelMin, mode: e.mode, fit: e.fit, veto: e.veto };
    }),
  }));

  const { options, relaxed } = rankGroup({
    now: now(),
    windowEarliest: plan.windowEarliest!,
    windowLatest: plan.windowLatest!,
    ceiling,
    candidates,
    novelty: (placeId) => crewNovelty(lastVisit(placeId), now()),
  });

  const organizer = members.find((m) => m.role === "organizer")!;
  if (options.length === 0) {
    await db.update(schema.plans).set({ status: "cancelled" }).where(eq(schema.plans.id, planId));
    await sendText(organizer.user, `Nothing fits everyone ${plan.meal === "lunch" ? "for lunch" : "tonight"}, even with longer drives. Want to try another day?`);
    for (const m of members) if (m.role !== "organizer") await sendText(m.user, `Couldn't find a spot that works for everyone, so ${firstName(organizer.user)}'s plan is off.`);
    return;
  }

  const planOptions: PlanOption[] = options.map((o) => {
    const p = byId.get(o.candidate.placeId)!;
    return {
      place: {
        placeId: p.placeId,
        name: p.name,
        refName: p.refName,
        shortName: p.shortName,
        lat: p.lat,
        lng: p.lng,
        priceEach: p.priceEach,
        cuisine: p.cuisine,
        mapsUrl: p.mapsUrl,
        bookingUrl: p.bookingUrl,
        primaryType: p.primaryType,
        types: p.types,
        servesVegetarianFood: p.servesVegetarianFood,
      },
      meet: o.meet.toISOString(),
      arrivals: o.arrivals.map((a) => {
        const m = o.candidate.members.find((x) => x.userId === a.userId)!;
        return { userId: a.userId, leaveAt: a.leaveAt.toISOString(), travelMin: m.travelMin, mode: m.mode };
      }),
      score: o.score,
    };
  });
  const pollClosesAt = addMinutes(now(), POLL_MIN);
  await db.update(schema.plans).set({ status: "voting", options: planOptions, pollClosesAt }).where(eq(schema.plans.id, planId));

  // Organizer: header + three lines, then the poll.
  const header =
    relaxMessage(relaxed, plan, planOptions) ??
    (reason === "update" ? "Times changed:" : (await everyoneCame(planId, members.length)) ? "Everyone's in:" : "Here's what works:");
  const orgArrivals = (o: PlanOption) => o.arrivals.find((a) => a.userId === organizer.userId)!;
  let lastMode: string | null = null;
  const lines = planOptions.map((o) => {
    const a = orgArrivals(o);
    const mode = a.mode === lastMode ? "" : ` ${a.mode}`;
    lastMode = a.mode;
    return `${o.place.name} · ${fmtClock(new Date(o.meet), TZ())} · ~${dollars(o.place.priceEach)} · ${a.travelMin} min${mode}`;
  });
  const bindsCeiling = (m: Member) => (m.constraints as Constraints).maxPrice === ceiling && ceiling < 200;

  // GROUP_CHAT_MODE: one shared poll in a real group chat when the line supports it; DMs otherwise.
  let group: { ok: boolean; messageId?: string } = { ok: false };
  if (config.groupChatMode && members.every((m) => m.user.channel === "imessage")) {
    group = await sendGroupPoll(members.map((m) => m.user), "Where to?", planOptions.map((o) => o.place.shortName));
    if (!group.ok) console.warn("[coordinator] group poll unavailable, using direct messages");
  }
  const voteWord = group.ok ? "Vote in the group chat." : "Vote:";

  let orgHeader = bindsCeiling(organizer) && header === "Everyone's in:" ? `Everyone's in. Kept it under ${dollars(ceiling)} for you:` : header;
  if (group.ok) orgHeader = orgHeader.replace(/:$/, `. ${voteWord}`);
  await sendText(organizer.user, [orgHeader, ...lines].join("\n"));
  if (group.ok) await recordGroupPoll(planId, organizer, planOptions, group.messageId);
  else await sendMemberPoll(planId, organizer, planOptions, planOptions.map((o) => o.place.shortName));

  for (const m of members) {
    if (m.role === "organizer") continue;
    const parts: string[] = [];
    if (m.lead) parts.push(m.lead);
    if (reason === "update") parts.push("Times changed.");
    if (bindsCeiling(m)) parts.push(`Kept it under ${dollars(ceiling)} for you.`);
    if (parts.length === 0) parts.push("Options are in.");
    parts.push(voteWord);
    await sendText(m.user, parts.join(" "));
    await updateMember(planId, m.userId, { lead: null });
    if (group.ok) {
      await recordGroupPoll(planId, m, planOptions, group.messageId);
      continue;
    }
    await sendMemberPoll(
      planId,
      m,
      planOptions,
      planOptions.map((o) => `${o.place.shortName} · ${o.arrivals.find((a) => a.userId === m.userId)!.travelMin} min`),
    );
  }
  await cancelJobs("poll_close", { planId });
  await schedule("poll_close", pollClosesAt, { planId });
}

/** True when nobody invited dropped out or was planned without. */
async function everyoneCame(planId: string, inCount: number): Promise<boolean> {
  const all = await getMembers(planId);
  const dropped = await db.query.invites.findMany({ where: eq(schema.invites.planId, planId) });
  return all.length === inCount && dropped.every((i) => i.usedBy);
}

function relaxMessage(relaxed: Relaxation[], plan: Plan, options: PlanOption[]): string | null {
  const last = relaxed.at(-1);
  const best = options[0];
  if (!last || !best) return null;
  switch (last) {
    case "window":
      return `Nothing fit ${fmtClock(plan.windowLatest!, TZ())}, so I moved it to ${fmtClock(new Date(best.meet), TZ())}:`;
    case "diversity":
      return "Not many spots fit, so two are the same kind of food:";
    case "travelCap":
      return "Nothing closer fit everyone, so some drives are longer:";
    case "gap":
      return "Drive times are a bit uneven tonight:";
  }
}

async function recordGroupPoll(planId: string, member: Member, options: PlanOption[], messageId?: string): Promise<void> {
  await db.insert(schema.polls).values({
    planId,
    userId: member.userId,
    providerMessageId: messageId ?? null,
    optionPlaceIds: options.map((o) => o.place.placeId),
    optionTitles: options.map((o) => o.place.shortName),
    sentAt: now(),
  });
  await setPending(member.userId, "vote", { planId });
}

async function sendMemberPoll(planId: string, member: Member, options: PlanOption[], titles: string[]): Promise<void> {
  const res = await sendPoll(member.user, "Where to?", titles);
  await db.insert(schema.polls).values({
    planId,
    userId: member.userId,
    providerMessageId: res.messageId ?? null,
    optionPlaceIds: options.map((o) => o.place.placeId),
    optionTitles: titles,
    sentAt: now(),
  });
  await setPending(member.userId, "vote", { planId });
}

// ---------------------------------------------------------------------------------------------
// Voting

/** Returns true if the vote was understood. */
export function recordVote(planId: string, userId: string, choice: { index?: number; title?: string }): Promise<boolean> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    if (plan.status !== "voting") return false;
    const poll = await db.query.polls.findFirst({
      where: and(eq(schema.polls.planId, planId), eq(schema.polls.userId, userId), eq(schema.polls.open, true)),
      orderBy: (p, { desc }) => [desc(p.id)],
    });
    if (!poll) return false;
    let idx = choice.index ?? -1;
    if (idx < 0 && choice.title) {
      const t = choice.title.trim().toLowerCase();
      idx = poll.optionTitles.findIndex((o) => o.toLowerCase() === t);
      if (idx < 0) idx = poll.optionTitles.findIndex((o) => o.toLowerCase().split(" · ")[0] === t || o.toLowerCase().startsWith(t));
      if (idx < 0) {
        const opts = plan.options ?? [];
        idx = opts.findIndex((o) => o.place.name.toLowerCase().includes(t) || o.place.shortName.toLowerCase() === t);
      }
    }
    const placeId = poll.optionPlaceIds[idx];
    if (!placeId) return false;
    await updateMember(planId, userId, { vote: placeId });
    await clearPending(userId, "vote");
    const members = (await getMembers(planId)).filter((m) => m.status === "in");
    if (members.every((m) => m.vote)) await closePoll(planId);
    return true;
  });
}

export function pollTimeout(planId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    if (plan.status !== "voting") return;
    if (plan.pollClosesAt && plan.pollClosesAt.getTime() > now().getTime() + 1000) return; // a newer poll is running
    await closePoll(planId);
  });
}

async function closePoll(planId: string): Promise<void> {
  const plan = await getPlan(planId);
  const options = plan.options ?? [];
  const members = (await getMembers(planId)).filter((m) => m.status === "in");
  const counts = new Map<string, number>();
  for (const m of members) if (m.vote) counts.set(m.vote, (counts.get(m.vote) ?? 0) + 1);
  const top = Math.max(0, ...counts.values());
  let tied = options.filter((o) => (counts.get(o.place.placeId) ?? 0) === top);
  const organizerVote = members.find((m) => m.role === "organizer")?.vote;
  if (tied.length > 1 && organizerVote && tied.some((o) => o.place.placeId === organizerVote)) {
    tied = tied.filter((o) => o.place.placeId === organizerVote);
  }
  const winner = tied[0] ?? options[0]!; // options are in score order
  await db.update(schema.polls).set({ open: false }).where(eq(schema.polls.planId, planId));
  for (const m of members) await clearPending(m.userId, "vote");
  await cancelJobs("poll_close", { planId });
  await confirm(planId, winner, { learnFromVotes: true });
}

// ---------------------------------------------------------------------------------------------
// Confirmation, booking, runner-up

/** Each person's calendar event is written by their own agent, to their own calendar. */
async function writeCalendar(member: Member, plan: Plan, option: PlanOption, leaveAt: Date): Promise<boolean> {
  const res = await PersonalAgent.for(member.userId).writeMealEvent({
    previousEventId: member.calendarEventId,
    title: `${plan.meal === "lunch" ? "Lunch" : "Dinner"} at ${option.place.name}`,
    meet: new Date(option.meet),
    leaveAt,
    minutes: MEAL_LENGTH_MIN,
  });
  await updateMember(plan.id, member.userId, { calendarEventId: res.eventId });
  return res.onCalendar;
}

async function confirm(planId: string, option: PlanOption, opts: { learnFromVotes: boolean; changed?: boolean }): Promise<void> {
  const plan = await getPlan(planId);
  const members = (await getMembers(planId)).filter((m) => m.status === "in");
  const meet = new Date(option.meet);
  const remaining = (plan.options ?? []).filter((o) => o.place.placeId !== option.place.placeId);
  await db
    .update(schema.plans)
    .set({ status: "confirmed", placeId: option.place.placeId, place: option.place, meetTime: meet, runnerUps: opts.changed ? (plan.runnerUps ?? []).filter((o) => o.place.placeId !== option.place.placeId) : remaining, booked: false })
    .where(eq(schema.plans.id, planId));
  if (!opts.changed) await db.insert(schema.crewHistory).values({ crewKey: plan.crewKey ?? crewKeyFor(members.map((m) => m.userId)), placeId: option.place.placeId, at: now() });

  const organizer = members.find((m) => m.role === "organizer")!;
  const when = fmtClock(meet, TZ());
  for (const m of members) {
    const a = option.arrivals.find((x) => x.userId === m.userId)!;
    const leaveAt = new Date(a.leaveAt);
    await updateMember(planId, m.userId, { leaveAt, travelMin: a.travelMin, travelMode: a.mode, eta: meet, lateNotifiedMin: null, arrived: false });
    const agent = PersonalAgent.for(m.userId);
    if (opts.learnFromVotes && m.vote === option.place.placeId) await agent.learnChoice(option.place);
    await agent.recordVisit(option.place, meet);
    const onCalendar = await writeCalendar(m, plan, option, leaveAt);
    if (m.role === "organizer") {
      await updateMember(planId, m.userId, { lead: onCalendar ? "calendar" : null });
      continue;
    }
    const prefix = opts.changed ? `Change of plan: ${option.place.shortName} at ${when}.` : `${option.place.shortName} at ${when}.`;
    await sendText(m.user, `${prefix} Leave at ${fmtClock(leaveAt, TZ())}${onCalendar ? ", it's on your calendar" : ""}.`);
  }
  await sendText(
    organizer.user,
    `${option.place.shortName} at ${when} it is. Tap to book a table for ${members.length}: ${option.place.bookingUrl}. Booked?`,
  );
  await setPending(organizer.userId, "confirm_booked", { planId });

  for (const kind of ["late_watch", "after_meal", "split_check", "plan_done"] as const) await cancelJobs(kind, { planId });
  const watchFrom = addMinutes(meet, -30);
  await schedule("late_watch", watchFrom.getTime() > now().getTime() ? watchFrom : now(), { planId });
  await schedule("after_meal", addMinutes(meet, 90), { planId });
  await schedule("split_check", addMinutes(meet, 95), { planId });
  await schedule("plan_done", addMinutes(meet, 180), { planId });
}

/** A newcomer finished setup while the others are voting: they vote on the same options if those work for them. */
async function joinVoting(planId: string, userId: string, lead: string): Promise<void> {
  const plan = await getPlan(planId);
  const member = (await getMembers(planId)).find((m) => m.userId === userId)!;
  const c = member.constraints as Constraints;
  const options = plan.options ?? [];
  const proposal: Proposal = {
    planId,
    meetCandidates: options.map((o) => ({ placeId: o.place.placeId, name: o.place.name, lat: o.place.lat, lng: o.place.lng, priceEach: o.place.priceEach, cuisine: o.place.cuisine, tags: [] })),
  };
  await logAgentMessage(planId, coordinatorAddress(planId), agentAddress(userId), "Proposal", proposal);
  const ev = await PersonalAgent.for(userId).evaluate(proposal, new Date(c.freeAt));
  const workable = options.filter((o) => {
    const e = ev.perCandidate.find((x) => x.placeId === o.place.placeId);
    if (!e || e.veto || o.place.priceEach > c.maxPrice || e.travelMin > TRAVEL_CAP_RELAXED_MIN) return false;
    if (!dietOk({ ...o.place, primaryType: o.place.primaryType ?? "", types: o.place.types ?? [] }, c.dietTags)) return false;
    // They must make the meet time the others already have.
    const arrive = addMinutes(new Date(Math.max(now().getTime(), new Date(c.freeAt).getTime())), e.travelMin);
    return arrive.getTime() <= new Date(o.meet).getTime();
  });
  if (workable.length === 0) {
    // The current options don't work for them: re-plan with everyone.
    await updateMember(planId, userId, { lead });
    await rerun(planId, "join");
    return;
  }
  const withTravel = options.map((o) => {
    const e = ev.perCandidate.find((x) => x.placeId === o.place.placeId)!;
    return { ...o, arrivals: [...o.arrivals.filter((a) => a.userId !== userId), { userId, leaveAt: addMinutes(new Date(o.meet), -e.travelMin).toISOString(), travelMin: e.travelMin, mode: e.mode }] };
  });
  await db.update(schema.plans).set({ options: withTravel }).where(eq(schema.plans.id, planId));
  await sendText(member.user, `${lead} Vote:`);
  await sendMemberPoll(planId, member, withTravel, withTravel.map((o) => `${o.place.shortName} · ${o.arrivals.find((a) => a.userId === userId)!.travelMin} min`));
}

/** A newcomer finished setup after the vote: give them the plan with their own leave time. */
async function joinConfirmed(planId: string, userId: string): Promise<void> {
  const plan = await getPlan(planId);
  const option = [...(plan.options ?? []), ...(plan.runnerUps ?? [])].find((o) => o.place.placeId === plan.placeId);
  const member = (await getMembers(planId)).find((m) => m.userId === userId)!;
  const c = member.constraints as Constraints;
  if (!option || !plan.meetTime) return;
  const proposal: Proposal = {
    planId,
    meetCandidates: [{ placeId: option.place.placeId, name: option.place.name, lat: option.place.lat, lng: option.place.lng, priceEach: option.place.priceEach, cuisine: option.place.cuisine, tags: [] }],
  };
  await logAgentMessage(planId, coordinatorAddress(planId), agentAddress(userId), "Proposal", proposal);
  const ev = await PersonalAgent.for(userId).evaluate(proposal, new Date(c.freeAt));
  const e = ev.perCandidate[0]!;
  const leaveAt = addMinutes(plan.meetTime, -e.travelMin);
  await updateMember(planId, userId, { leaveAt, travelMin: e.travelMin, travelMode: e.mode, eta: plan.meetTime });
  const withLeave: PlanOption = { ...option, arrivals: [...option.arrivals.filter((a) => a.userId !== userId), { userId, leaveAt: leaveAt.toISOString(), travelMin: e.travelMin, mode: e.mode }] };
  const onCalendar = await writeCalendar(member, plan, withLeave, leaveAt);
  await sendText(member.user, `You're set. ${option.place.shortName} at ${fmtClock(plan.meetTime, TZ())}. Leave at ${fmtClock(leaveAt, TZ())}${onCalendar ? ", it's on your calendar" : ""}.`);
}

export function markBooked(planId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    if (plan.status !== "confirmed") return;
    await db.update(schema.plans).set({ booked: true }).where(eq(schema.plans.id, planId));
    await clearPending(plan.organizerId, "confirm_booked");
    const members = (await getMembers(planId)).filter((m) => m.status === "in");
    const organizer = members.find((m) => m.role === "organizer")!;
    const others = members.filter((m) => m.role !== "organizer");
    const leave = organizer.leaveAt ? ` Leave at ${fmtClock(organizer.leaveAt, TZ())}${organizer.lead === "calendar" ? ", it's on your calendar" : ""}.` : "";
    await sendText(organizer.user, `Nice, I told ${joinNames(others.map((m) => firstName(m.user)))}.${leave}`);
    await updateMember(planId, organizer.userId, { lead: null });
    for (const m of others) await sendText(m.user, `Table's booked under ${firstName(organizer.user)}.`);
  });
}

/** Booking failed or the place is closed: offer the runner-up to the organizer. */
export function bookingFailed(planId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    const next = (plan.runnerUps ?? [])[0];
    if (!next) {
      await clearPending(plan.organizerId);
      await sendText(plan.organizerId, "That was the last spot that fit everyone tonight. Want me to try another day?");
      return;
    }
    await sendText(plan.organizerId, `${next.place.name} at ${fmtClock(new Date(next.meet), TZ())} instead? yes/no`);
    await setPending(plan.organizerId, "runner_up", { planId, placeId: next.place.placeId });
  });
}

export function runnerUpAnswer(planId: string, yes: boolean): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    const [next, ...rest] = plan.runnerUps ?? [];
    await clearPending(plan.organizerId, "runner_up");
    if (!next) return;
    if (yes) {
      await confirm(planId, next, { learnFromVotes: false, changed: true });
      return;
    }
    await db.update(schema.plans).set({ runnerUps: rest }).where(eq(schema.plans.id, planId));
    const after = rest[0];
    if (!after) {
      await sendText(plan.organizerId, "That was the last spot that fit everyone tonight. Want me to try another day?");
      return;
    }
    await sendText(plan.organizerId, `${after.place.name} at ${fmtClock(new Date(after.meet), TZ())} instead? yes/no`);
    await setPending(plan.organizerId, "runner_up", { planId, placeId: after.place.placeId });
  });
}

/** A veto during voting: re-run silently if it touches a current option. */
export function vetoDuringPlan(planId: string, userId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    if (plan.status !== "voting") return;
    const agent = PersonalAgent.for(userId);
    for (const o of plan.options ?? []) {
      if (await agent.isVetoed({ placeId: o.place.placeId, name: o.place.name, cuisine: o.place.cuisine })) {
        await rerun(planId, "update");
        return;
      }
    }
  });
}

export function planDone(planId: string): Promise<void> {
  return withLock(`plan:${planId}`, async () => {
    const plan = await getPlan(planId);
    if (plan.status === "confirmed") await db.update(schema.plans).set({ status: "done" }).where(eq(schema.plans.id, planId));
  });
}

export const coordinatorInternals = { getPlan, getMembers };

export async function pendingPlanQuestion(userId: string) {
  return getPending(userId);
}
