// Setup (9.1) and newcomer setup (9.5): diet → link → (max) → Find My card → budget or plan.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { newcomerReady } from "../agents/coordinator.ts";
import { PersonalAgent } from "../agents/personal-agent.ts";
import { now } from "../clock.ts";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { mealsPerWeekFromHistory, proposeLimits } from "../engines/budget.ts";
import { findMyAvailable, requestLocation, sharedLocation } from "../integrations/findmy.ts";
import { parseDietAnswer, parseMoney } from "../intent.ts";
import { randomCode } from "../lib/crypto.ts";
import { addMinutes, zonedParts } from "../lib/time.ts";
import { sendFindMyCard, sendText, type User } from "../messaging.ts";
import { clearPending, setPending } from "../pending.ts";
import { schedule } from "../scheduler.ts";
import { joinNames } from "../text.ts";

export const CARD_WAIT_MIN = 3;
export const LINK_NUDGE_MIN = 5;
const CARD_POLL_SEC = 15;

const READY_LINE = `Text me when you're hungry, or say "dinner with" and some names.`;

export function linkUrl(user: User): string {
  return `${config.publicBaseUrl}/l/${user.linkToken}`;
}

async function ensureLinkToken(user: User): Promise<User> {
  if (user.linkToken) return user;
  const token = randomCode(16, "abcdefghijkmnpqrstuvwxyz23456789");
  await PersonalAgent.for(user.id).update({ linkToken: token });
  return { ...user, linkToken: token };
}

/** The plan a newcomer joined, if they're still being set up for it. */
async function joiningPlan(userId: string): Promise<string | null> {
  const rows = await db
    .select({ planId: schema.planMembers.planId })
    .from(schema.planMembers)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.planMembers.planId))
    .where(
      and(
        eq(schema.planMembers.userId, userId),
        eq(schema.planMembers.status, "in"),
        isNull(schema.planMembers.constraints),
        inArray(schema.plans.status, ["gathering", "voting", "confirmed"]),
      ),
    );
  return rows[0]?.planId ?? null;
}

export async function startOnboarding(user: User): Promise<void> {
  await sendText(user, "Hey, I'm Foodie. I find you places to eat and plan meals with friends. Anything you don't eat?");
  await PersonalAgent.for(user.id).update({ onboarding: "asked_diet" });
  await setPending(user.id, "diet");
}

export async function startNewcomer(user: User, joined: { planId: string; organizer: User; others: string[] }, mealPhrase: string): Promise<void> {
  const withWho = joined.others.length ? `you and ${joinNames(joined.others)}` : "you";
  await sendText(user, `Hey ${user.name ?? "there"}! ${joined.organizer.name ?? "Your friend"}'s planning ${mealPhrase} with ${withWho}. Anything you don't eat?`);
  await PersonalAgent.for(user.id).update({ onboarding: "asked_diet" });
  await setPending(user.id, "diet", { planId: joined.planId });
}

/** Returns false if the answer wasn't understood. */
export async function answerDiet(user: User, text: string): Promise<boolean> {
  const parsed = parseDietAnswer(text);
  if (!parsed) return false;
  const agent = PersonalAgent.for(user.id);
  await agent.update({ dietTags: parsed.diet, ...(parsed.maxPerMeal ? { mealCap: Math.round(parsed.maxPerMeal) } : {}) });
  await clearPending(user.id, "diet");
  const u = await ensureLinkToken(await agent.user());
  const joining = await joiningPlan(user.id);
  const text2 = joining
    ? u.mealCap != null
      ? `Got it. Tap to connect your calendar: ${linkUrl(u)}`
      : `Got it. Tap to connect your calendar and set a max: ${linkUrl(u)}`
    : `Got it. One tap to connect your calendar, contacts and bank: ${linkUrl(u)}`;
  await sendText(u, text2);
  await agent.update({ onboarding: "link_sent" });
  await schedule("onboarding_link_nudge", addMinutes(now(), LINK_NUDGE_MIN), { userId: user.id });
  return true;
}

export async function linkNudge(userId: string): Promise<void> {
  const u = await PersonalAgent.for(userId).user();
  if (u.onboarding !== "link_sent" || u.paused) return;
  await sendText(u, `Still need this one: ${linkUrl(u)}`);
}

/** The link page finished (Google, bank, max). */
export async function linkDone(userId: string): Promise<void> {
  const agent = PersonalAgent.for(userId);
  const u = await agent.user();
  if (u.onboarding !== "link_sent") return;
  await agent.update({ linkDoneAt: now() });
  if (u.mealCap == null && !u.nessieAccountId) {
    await sendText(u, "Rough max per meal?");
    await agent.update({ onboarding: "asked_max" });
    await setPending(userId, "max_per_meal");
    return;
  }
  await sendCard(await agent.user());
}

export async function answerMax(user: User, text: string): Promise<boolean> {
  const amount = parseMoney(text) ?? (/^\s*\d{1,4}\s*$/.test(text) ? Number(text.trim()) : null);
  if (amount == null || amount <= 0) return false;
  await PersonalAgent.for(user.id).update({ mealCap: Math.round(amount) });
  await clearPending(user.id, "max_per_meal");
  if (user.onboarding === "asked_max") await sendCard(await PersonalAgent.for(user.id).user());
  return true;
}

async function sendCard(user: User): Promise<void> {
  const agent = PersonalAgent.for(user.id);
  const joining = await joiningPlan(user.id);
  // SMS contacts get no Find My; Foodie asks where they're coming from when it matters.
  if (user.findmyStatus === "unavailable" || (user.channel === "imessage" && !findMyAvailable(user))) {
    await agent.update({ findmyStatus: "unavailable" });
    await finish(user.id);
    return;
  }
  await sendText(
    user,
    joining
      ? "Last step: accept the location card and choose Share Indefinitely so I can plan around you."
      : "Last step: accept the location card below and choose Share Indefinitely.",
  );
  if (user.channel === "imessage") {
    const res = await requestLocation(user);
    if (!res.ok) console.warn(`[findmy] request card failed for ${user.id}: ${res.error}`);
  } else {
    await sendFindMyCard(user);
  }
  await agent.update({ onboarding: "card_sent", findmyStatus: "requested" });
  await schedule("onboarding_card_check", addMinutes(now(), CARD_POLL_SEC / 60), {
    userId: user.id,
    deadline: addMinutes(now(), CARD_WAIT_MIN).toISOString(),
  });
}

/** Polls Find My until the share shows up or three minutes pass. */
export async function cardCheck(userId: string, deadline: string): Promise<void> {
  const agent = PersonalAgent.for(userId);
  const u = await agent.user();
  if (u.onboarding !== "card_sent") return;
  if (u.channel === "imessage") {
    const loc = await sharedLocation(u);
    if (loc) {
      await agent.update({ findmyStatus: "sharing", lat: loc.lat, lng: loc.lng, locationSource: "findmy", locationAt: loc.at });
      await finish(userId);
      return;
    }
  }
  if (now().getTime() >= new Date(deadline).getTime()) {
    await finish(userId);
    return;
  }
  await schedule("onboarding_card_check", addMinutes(now(), CARD_POLL_SEC / 60), { userId, deadline });
}

/** Terminal and sim stand-in for accepting or declining the card. */
export async function findMyAnswer(userId: string, accepted: boolean): Promise<void> {
  const agent = PersonalAgent.for(userId);
  const u = await agent.user();
  await agent.update({ findmyStatus: accepted ? "sharing" : "declined" });
  if (u.onboarding === "card_sent") await finish(userId);
}

async function finish(userId: string): Promise<void> {
  const agent = PersonalAgent.for(userId);
  const u = await agent.user();
  if (u.onboarding === "done" || u.onboarding === "asked_budget") return;
  const planId = await joiningPlan(userId);

  let proposal: { monthlyLimit: number; mealCap: number } | null = null;
  let mealsPerWeek: number | null = null;
  if (u.nessieAccountId && u.monthlyLimit == null) {
    const purchases = (await agent.restaurantPurchases()).map((p) => ({ amount: p.amount, date: new Date(`${p.date}T00:00:00Z`) }));
    const p = zonedParts(now(), config.timezone);
    proposal = proposeLimits(purchases, { year: p.year, month: p.month });
    mealsPerWeek = mealsPerWeekFromHistory(purchases, { year: p.year, month: p.month });
  }

  if (planId) {
    // Newcomers go straight to the plan; any bank-based limits are set quietly.
    await agent.update({
      onboarding: "done",
      ...(proposal ? { monthlyLimit: proposal.monthlyLimit, mealCap: u.mealCap ?? proposal.mealCap, mealsPerWeek } : {}),
    });
    await newcomerReady(planId, userId);
    return;
  }
  const hello = u.name ? `All set, ${u.name}.` : "All set.";
  if (proposal) {
    await sendText(u, `${hello} You've averaged $${proposal.monthlyLimit} a month eating out, usually under $${proposal.mealCap} a meal. Use those as your limits?`);
    await agent.update({ onboarding: "asked_budget", mealsPerWeek });
    await setPending(userId, "confirm_budget", { monthlyLimit: proposal.monthlyLimit, mealCap: proposal.mealCap });
    return;
  }
  await agent.update({ onboarding: "done" });
  await sendText(u, `${hello} ${READY_LINE}`);
}

export async function confirmBudget(user: User, yes: boolean, payload: Record<string, unknown>): Promise<void> {
  const agent = PersonalAgent.for(user.id);
  await clearPending(user.id, "confirm_budget");
  if (yes) {
    await agent.update({ monthlyLimit: Number(payload.monthlyLimit), mealCap: Number(payload.mealCap), onboarding: "done" });
    await sendText(user, `Done. ${READY_LINE}`);
    return;
  }
  await sendText(user, `What should they be? Like "$200 a month, $15 a meal".`);
  await setPending(user.id, "set_limits");
}

export async function setLimits(user: User, text: string): Promise<boolean> {
  const monthly = text.match(/\$?\s?(\d{2,5})\s*(?:\/|a|per|each)?\s*(?:month|mo)\b/i);
  const meal = text.match(/\$?\s?(\d{1,4})\s*(?:\/|a|per|each)?\s*(?:meal|dinner|lunch)\b/i);
  const bare = [...text.matchAll(/\$\s?(\d{1,5})/g)].map((m) => Number(m[1]));
  const monthlyLimit = monthly ? Number(monthly[1]) : bare.length === 2 ? Math.max(...bare) : null;
  const mealCap = meal ? Number(meal[1]) : bare.length === 2 ? Math.min(...bare) : bare.length === 1 && !monthly ? bare[0]! : null;
  if (monthlyLimit == null && mealCap == null) return false;
  await PersonalAgent.for(user.id).update({
    ...(monthlyLimit != null ? { monthlyLimit } : {}),
    ...(mealCap != null ? { mealCap } : {}),
    onboarding: "done",
  });
  await clearPending(user.id, "set_limits");
  await sendText(user, `Done. ${READY_LINE}`);
  return true;
}
