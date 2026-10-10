// Solo (9.2): "I'm hungry" → (mood) → three options → directions → feedback an hour later.
import { eq } from "drizzle-orm";
import { PersonalAgent } from "../agents/personal-agent.ts";
import { now } from "../clock.ts";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import type { PlanOption } from "../db/schema.ts";
import { dietOk } from "../diet.ts";
import { chooseTravel } from "../engines/arrival.ts";
import { rankSolo, type SoloCandidate } from "../engines/ranking.ts";
import { writeReason } from "../integrations/gemini.ts";
import { isOpenBetween, mapsDirectionsUrl, searchNearby } from "../integrations/places.ts";
import { travelTimes } from "../integrations/routes.ts";
import type { Mood } from "../intent.ts";
import { addMinutes, fmtClock, minutesBetween, zonedParts } from "../lib/time.ts";
import { sendText, type User } from "../messaging.ts";
import { clearPending, setPending } from "../pending.ts";
import { schedule } from "../scheduler.ts";
import { dollars } from "../text.ts";

const TZ = () => config.timezone;
const SOLO_RADIUS_M = 3000;
const SOLO_MEAL_MIN = 30;
const NEW_MATCH_TASTE = 0.2;

const mealNow = () => (zonedParts(now(), TZ()).hour < 15 ? "lunch" : "dinner");

async function lead(user: User): Promise<string> {
  const agent = PersonalAgent.for(user.id);
  const until = await agent.freeUntil(now());
  const budget = await agent.budget(mealNow());
  const target = budget ? `about ${dollars(budget.target)} today` : null;
  if (until && target) return `You're free until ${fmtClock(until, TZ())} and at ${target}.`;
  if (until) return `You're free until ${fmtClock(until, TZ())}.`;
  if (target) return `You're at ${target}.`;
  return "";
}

export async function startSolo(user: User, mood?: Mood): Promise<void> {
  const agent = PersonalAgent.for(user.id);
  if (!(await agent.location())) {
    await sendText(user, "Where are you coming from?");
    await setPending(user.id, "where_from", { resume: "solo", mood: mood ?? null });
    return;
  }
  const intro = await lead(user);
  if (!mood) {
    await sendText(user, intro ? `${intro} Light or filling?` : "Light or filling?");
    await setPending(user.id, "mood");
    return;
  }
  await showOptions(user, mood, intro);
}

/** Sends three numbered options. `intro` (when the mood came with the first message) goes on top. */
export async function showOptions(user: User, mood: Mood, intro = ""): Promise<void> {
  const agent = PersonalAgent.for(user.id);
  const loc = await agent.location();
  if (!loc) return startSolo(user, mood);
  const u = await agent.user();
  const budget = await agent.budget(mealNow());
  const places = await searchNearby(loc, SOLO_RADIUS_M);
  const travel = await travelTimes(loc, places, now(), u.demoKey);

  const candidates: SoloCandidate[] = [];
  for (const p of places) {
    const t = travel.get(p.placeId);
    const choice = chooseTravel(t?.walkMin ?? null, t?.driveMin ?? null);
    if (!choice) continue;
    const mem = await agent.placeMemory(p.placeId);
    candidates.push({
      placeId: p.placeId,
      cuisine: p.cuisine,
      priceEach: p.priceEach,
      dietOk: dietOk(p, u.dietTags),
      veto: await agent.isVetoed(p),
      isOpen: (from, to) => isOpenBetween(p.periods, from, to),
      travelMin: choice.travelMin,
      mode: choice.mode,
      fit: await agent.fit(p),
      novelty: mem?.visits ? 0 : 3,
      moodMatch: p.tags.includes(mood),
    });
  }
  const ranked = rankSolo({ now: now(), hardMax: budget?.hardMax ?? Infinity, candidates });
  if (ranked.length === 0) {
    await sendText(user, "Nothing nearby fits right now. Want me to look again in a bit?");
    await clearPending(user.id);
    return;
  }

  const byId = new Map(places.map((p) => [p.placeId, p]));
  const lines: string[] = [];
  const options: PlanOption[] = [];
  for (const [i, r] of ranked.entries()) {
    const p = byId.get(r.candidate.placeId)!;
    const mem = await agent.placeMemory(p.placeId);
    // Memory shows up only when it's the reason for the suggestion.
    let reason = "";
    if (mem?.rating === 1) reason = "you loved it last time";
    else if (!mem?.visits && (await agent.tasteScore(p.cuisine)) > NEW_MATCH_TASTE) reason = "new, matches what you like";
    if (reason) reason = await writeReason(reason, p.name);
    const parts = [`${i + 1}. ${p.name}`, `${r.candidate.travelMin} min ${r.candidate.mode}`, `~${dollars(p.priceEach)}`];
    if (reason) parts.push(reason);
    lines.push(parts.join(" · "));
    options.push({
      place: { placeId: p.placeId, name: p.name, refName: p.refName, shortName: p.shortName, lat: p.lat, lng: p.lng, priceEach: p.priceEach, cuisine: p.cuisine, mapsUrl: p.mapsUrl, bookingUrl: p.bookingUrl },
      meet: r.arrive.toISOString(),
      arrivals: [{ userId: user.id, leaveAt: now().toISOString(), travelMin: r.candidate.travelMin, mode: r.candidate.mode }],
      score: r.score,
    });
  }
  const planId = crypto.randomUUID();
  await db.insert(schema.plans).values({ id: planId, organizerId: user.id, kind: "solo", status: "choosing", meal: mealNow(), options });
  await db.insert(schema.planMembers).values({ planId, userId: user.id, role: "organizer", status: "in" });
  const header = intro ? [intro.replace(/\.$/, ":")] : [];
  await sendText(user, [...header, ...lines].join("\n"));
  await setPending(user.id, "choose_solo", { planId });
}

export async function chooseSolo(user: User, planId: string, n: number): Promise<boolean> {
  const plan = await db.query.plans.findFirst({ where: eq(schema.plans.id, planId) });
  const option = plan?.options?.[n - 1];
  if (!plan || !option) return false;
  const agent = PersonalAgent.for(user.id);
  await agent.learnChoice(option.place);
  await agent.recordVisit(option.place);
  await db.update(schema.plans).set({ status: "chosen", placeId: option.place.placeId, place: option.place, meetTime: new Date(option.meet) }).where(eq(schema.plans.id, planId));
  await clearPending(user.id, "choose_solo");

  const a = option.arrivals[0]!;
  const directions = mapsDirectionsUrl(option.place, a.mode);
  const until = await agent.freeUntil(now());
  let tail = "Enjoy.";
  if (until) {
    const back = addMinutes(now(), a.travelMin * 2 + SOLO_MEAL_MIN);
    const spare = minutesBetween(back, until);
    const at = fmtClock(until, TZ());
    tail = spare >= 10 ? `You'll be back well before ${at}.` : spare >= 0 ? `You'll be back just before ${at}.` : `Heads up, it's tight before ${at}.`;
  }
  await sendText(user, `Good call. Directions: ${directions}. ${tail}`);
  await schedule("solo_feedback", addMinutes(now(), 60), { planId, userId: user.id });
  return true;
}
