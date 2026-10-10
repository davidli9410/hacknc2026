// What a personal agent does with a message from its owner: answer the open question if the reply fits,
// otherwise parse an intent (Gemini, or rules) and act on it.
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  activePlanFor,
  bookingFailed,
  goWithout,
  markBooked,
  memberAvailability,
  memberIn,
  memberLocationReady,
  memberOut,
  recordVote,
  runnerUpAnswer,
  vetoDuringPlan,
} from "../agents/coordinator.ts";
import { PersonalAgent } from "../agents/personal-agent.ts";
import { now } from "../clock.ts";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { parseIntent } from "../integrations/gemini.ts";
import { geocode } from "../integrations/places.ts";
import {
  parseAvailability,
  parseDietAnswer,
  parseMoney,
  parseNumberChoice,
  parseRules,
  parseSentiment,
  parseYesNo,
  tapbackSentiment,
  type Intent,
  type Mood,
} from "../intent.ts";
import { atLocalTime, fmtClock, zonedParts } from "../lib/time.ts";
import { react, sendText, type Inbound, type User } from "../messaging.ts";
import { clearPending, getPending, type Pending } from "../pending.ts";
import { applyFeedback, confirmSplit, markPaidOther, proposeSplit, sendShare, whoPaid } from "./after.ts";
import { answerContactCard, answerWhich, continueDraft } from "./friends.ts";
import { answerDiet, answerMax, confirmBudget, setLimits } from "./onboarding.ts";
import { chooseSolo, showOptions, startSolo } from "./solo.ts";

const TZ = () => config.timezone;

function availabilityDate(t: { hour: number; minute: number }): Date {
  return atLocalTime(now(), t.hour, t.minute, TZ());
}

const QUESTION: Partial<Record<Pending["kind"], string>> = {
  diet: "Anything you don't eat?",
  mood: "Light or filling?",
  invite_in: "In?",
  where_from: "Where are you coming from?",
  when_free: "When are you free?",
  confirm_booked: "Booked?",
  who_paid: "Who paid?",
  feedback: "How was it?",
};

/** Tries to answer the open question. Returns true if the message was consumed. */
async function answerPending(user: User, p: Pending, text: string, msg: Inbound): Promise<boolean> {
  const t = text.trim();
  const yn = parseYesNo(t);
  const rules = parseRules(t);
  const planId = p.planId ?? (p.payload.planId as string | undefined) ?? null;

  switch (p.kind) {
    case "diet": {
      if (await answerDiet(user, t)) return true;
      const intent = await parseIntent(t, { lastQuestion: QUESTION.diet });
      if (intent.type === "set_pref" && intent.diet?.length) return answerDiet(user, intent.diet.join(", ") + (intent.maxPerMeal ? `, $${intent.maxPerMeal}` : ""));
      return false;
    }
    case "max_per_meal":
      return answerMax(user, t);
    case "confirm_budget":
      if (yn === null) return false;
      await confirmBudget(user, yn, p.payload);
      return true;
    case "set_limits":
      return setLimits(user, t);
    case "mood": {
      const mood: Mood | undefined =
        rules.type === "set_pref" ? rules.mood : rules.type === "hungry_solo" ? rules.mood : undefined;
      if (!mood) return false;
      await clearPending(user.id, "mood");
      await showOptions(user, mood);
      return true;
    }
    case "choose_solo": {
      const n = parseNumberChoice(t, 3);
      if (!n || !planId) return false;
      return chooseSolo(user, planId, n);
    }
    case "where_from": {
      if (rules.type !== "other" && rules.type !== "location" && rules.type !== "set_pref") return false;
      const point = await geocode(t);
      if (!point) {
        await sendText(user, "I couldn't find that. A street, building or landmark?");
        return true;
      }
      await PersonalAgent.for(user.id).setTextLocation(point.lat, point.lng);
      await clearPending(user.id, "where_from");
      if (p.payload.resume === "solo") await startSolo(user, (p.payload.mood as Mood | null) ?? undefined);
      else if (planId) await memberLocationReady(planId, user.id, p.payload.freeAt ? new Date(String(p.payload.freeAt)) : null);
      return true;
    }
    case "when_free": {
      if (!planId) return false;
      if (rules.type === "availability" && rules.unavailable) {
        await memberOut(planId, user.id);
        return true;
      }
      if (/^(now|right now|anytime|whenever|free now)\.?$/i.test(t)) {
        await memberIn(planId, user.id, now());
        return true;
      }
      const time = parseAvailability(t);
      if (!time) return false;
      await memberIn(planId, user.id, availabilityDate(time));
      return true;
    }
    case "invite_in": {
      if (!planId) return false;
      if ((rules.type === "confirm" && rules.yes) || yn === true) {
        await memberIn(planId, user.id);
        return true;
      }
      if ((rules.type === "availability" && rules.unavailable) || yn === false) {
        await memberOut(planId, user.id);
        return true;
      }
      if (rules.type === "availability" && rules.freeAt) {
        await memberIn(planId, user.id, availabilityDate(rules.freeAt));
        return true;
      }
      return false;
    }
    case "vote": {
      if (!planId) return false;
      const n = parseNumberChoice(t, 3);
      if (n) return recordVote(planId, user.id, { index: n - 1 });
      if (t.length <= 30 && rules.type === "other") return recordVote(planId, user.id, { title: t });
      return false;
    }
    case "confirm_booked": {
      if (!planId) return false;
      if (rules.type === "booked" || yn === true) {
        await markBooked(planId);
        return true;
      }
      if (rules.type === "cant_book" || yn === false) {
        await bookingFailed(planId);
        return true;
      }
      return false;
    }
    case "runner_up":
      if (yn === null || !planId) return false;
      await runnerUpAnswer(planId, yn);
      return true;
    case "go_without":
      if (yn === null || !planId) return false;
      await clearPending(user.id, "go_without");
      await goWithout(planId, yn);
      return true;
    case "choose_contact":
      return answerWhich(user, p.payload, t);
    case "contact_card": {
      const phones = t.match(/\+?\d[\d\s().-]{8,}\d/g) ?? [];
      const emails = t.match(/[^\s@]+@[^\s@]+\.[^\s@]+/g) ?? [];
      if (!phones.length && !emails.length) return false;
      await answerContactCard(user, p.payload, { phones, emails });
      return true;
    }
    case "who_paid":
      if (!planId) return false;
      if (!(await whoPaid(planId, user, t))) return false;
      return true;
    case "how_much": {
      const amount = parseMoney(t) ?? (/^\s*\d+(\.\d{1,2})?\s*$/.test(t) ? Number(t) : null);
      if (!amount || !planId) return false;
      await clearPending(user.id, "how_much");
      await proposeSplit(planId, user, Math.round(amount * 100), null, false);
      return true;
    }
    case "confirm_split":
      if (yn === null) return false;
      await clearPending(user.id, "confirm_split");
      await confirmSplit(Number(p.payload.splitId), yn);
      if (yn) await react(user, msg.messageId, "👍");
      return true;
    case "send_share":
      if (rules.type === "paid") {
        await clearPending(user.id, "send_share");
        await markPaidOther(Number(p.payload.shareId));
        return true;
      }
      if (yn === null) return false;
      await clearPending(user.id, "send_share");
      await sendShare(Number(p.payload.shareId), yn);
      return true;
    case "paid_other":
      if (rules.type !== "paid" && yn !== true) return false;
      await clearPending(user.id, "paid_other");
      await markPaidOther(Number(p.payload.shareId));
      return true;
    case "feedback": {
      const s = parseSentiment(t) ?? (yn === true ? "positive" : null);
      if (!s) return false;
      await clearPending(user.id, "feedback");
      await applyFeedback(user.id, String(p.payload.placeId), planId, s);
      await sendText(user, s === "positive" ? "Good to know. I'll keep it in the rotation." : "Sorry to hear it. I'll skip it for a while.");
      return true;
    }
  }
  return false;
}

/** The last place this user ate, for feedback that arrives without an open question. */
async function lastMeal(userId: string): Promise<{ planId: string; placeId: string } | null> {
  const rows = await db
    .select({ id: schema.plans.id, placeId: schema.plans.placeId })
    .from(schema.plans)
    .innerJoin(schema.planMembers, eq(schema.planMembers.planId, schema.plans.id))
    .where(and(eq(schema.planMembers.userId, userId), eq(schema.planMembers.status, "in"), isNotNull(schema.plans.placeId), inArray(schema.plans.status, ["chosen", "confirmed", "done"])))
    .orderBy(desc(schema.plans.meetTime))
    .limit(1);
  const r = rows[0];
  return r?.placeId ? { planId: r.id, placeId: r.placeId } : null;
}

async function forget(user: User, target: string): Promise<string> {
  const agent = PersonalAgent.for(user.id);
  const t = target.toLowerCase().replace(/^(about |my |the )+/, "").trim();
  if (/^(everything|me|all|all of it|it all)$/.test(t)) {
    await agent.update({
      dietTags: [],
      dislikes: [],
      monthlyLimit: null,
      mealCap: null,
      mealsPerWeek: null,
      googleTokens: null,
      googleEmail: null,
      nessieCustomerId: null,
      nessieAccountId: null,
      lat: null,
      lng: null,
      locationSource: null,
      locationAt: null,
      findmyStatus: "none",
    });
    for (const table of [schema.taste, schema.placeMemory, schema.vetoes, schema.overrides] as const) {
      await db.delete(table).where(eq(table.userId, user.id));
    }
    return "Done, I forgot everything about you.";
  }
  if (/budget|limit|spending|money|max/.test(t)) {
    await agent.update({ monthlyLimit: null, mealCap: null, mealsPerWeek: null });
    await db.delete(schema.overrides).where(eq(schema.overrides.userId, user.id));
    return "Done, I forgot your limits.";
  }
  if (/bank|nessie|capital one/.test(t)) {
    await agent.update({ nessieCustomerId: null, nessieAccountId: null });
    return "Done, your bank is disconnected.";
  }
  if (/calendar|google|contacts/.test(t)) {
    await agent.update({ googleTokens: null, googleEmail: null });
    return "Done, your Google account is disconnected.";
  }
  if (/location|where i am|find my/.test(t)) {
    await agent.update({ lat: null, lng: null, locationSource: null, locationAt: null, findmyStatus: "declined" });
    return "Done, I forgot your location.";
  }
  if (user.dietTags.some((d) => d.toLowerCase() === t) || /diet/.test(t)) {
    await agent.update({ dietTags: /diet/.test(t) ? [] : user.dietTags.filter((d) => d.toLowerCase() !== t) });
    return `Done, I forgot ${/diet/.test(t) ? "your diet" : t}.`;
  }
  const vetoes = await agent.activeVetoes();
  const hit = vetoes.filter((v) => v.target === t || (v.label ?? "").toLowerCase() === t);
  if (hit.length || user.dislikes.includes(t)) {
    for (const v of hit) await db.delete(schema.vetoes).where(eq(schema.vetoes.id, v.id));
    await agent.update({ dislikes: user.dislikes.filter((d) => d !== t) });
    return `Done, ${t} is back on the table.`;
  }
  const tastes = await db.query.taste.findMany({ where: eq(schema.taste.userId, user.id) });
  const taste = tastes.find((x) => x.cuisine === t);
  const places = await db.query.placeMemory.findMany({ where: eq(schema.placeMemory.userId, user.id) });
  const place = places.find((x) => x.name.toLowerCase().includes(t));
  if (taste || place) {
    if (taste) await db.delete(schema.taste).where(and(eq(schema.taste.userId, user.id), eq(schema.taste.cuisine, taste.cuisine)));
    if (place) await db.delete(schema.placeMemory).where(and(eq(schema.placeMemory.userId, user.id), eq(schema.placeMemory.placeId, place.placeId)));
    return `Done, I forgot ${t}.`;
  }
  return `I don't have anything about ${target}.`;
}

async function act(user: User, intent: Intent): Promise<void> {
  const agent = PersonalAgent.for(user.id);
  switch (intent.type) {
    case "hungry_solo":
      await startSolo(user, intent.mood);
      return;
    case "plan_group": {
      const meal = intent.meal ?? (zonedParts(now(), TZ()).hour < 15 ? "lunch" : "dinner");
      await continueDraft(user, { names: intent.names, resolved: [], meal, when: intent.when });
      return;
    }
    case "set_pref": {
      const updates: Partial<typeof schema.users.$inferInsert> = {};
      const said: string[] = [];
      if (intent.diet?.length) {
        updates.dietTags = [...new Set([...user.dietTags, ...intent.diet.map((d) => d.toLowerCase())])];
        said.push(intent.diet.join(", "));
      }
      if (intent.dislikes?.length) {
        updates.dislikes = [...new Set([...user.dislikes, ...intent.dislikes.map((d) => d.toLowerCase())])];
        said.push(`no ${intent.dislikes.join(", ")}`);
      }
      if (intent.maxPerMeal) {
        updates.mealCap = Math.round(intent.maxPerMeal);
        said.push(`under $${Math.round(intent.maxPerMeal)} a meal`);
      }
      if (intent.mood && said.length === 0) {
        await startSolo(user, intent.mood);
        return;
      }
      if (said.length === 0) break;
      await agent.update(updates);
      await sendText(user, `Got it, ${said.join(", ")}.`);
      return;
    }
    case "veto": {
      const target = intent.target.replace(/^(the|any|more)\s+/i, "").trim();
      await agent.addVeto(target, intent.never, target);
      await sendText(user, intent.never ? `Got it, never ${target}.` : `Got it, no ${target} for a while.`);
      const plan = await activePlanFor(user.id);
      if (plan) await vetoDuringPlan(plan.id, user.id);
      return;
    }
    case "budget_override": {
      const u = await agent.user();
      if (intent.kind === "treat") {
        const amount = Math.round(intent.amount ?? Math.ceil(((u.mealCap ?? 20) * 1.5) / 5) * 5);
        await agent.setOverride("treat", amount);
        await sendText(user, `Treat night, up to $${amount} today.`);
      } else {
        const amount = Math.round(intent.amount ?? 10);
        await agent.setOverride("cheap", amount);
        await sendText(user, `Keeping it cheap, about $${amount} today.`);
      }
      return;
    }
    case "availability": {
      const plan = await activePlanFor(user.id);
      if (!plan) break;
      if (intent.unavailable) await memberOut(plan.id, user.id);
      else if (intent.freeAt) await memberAvailability(plan.id, user.id, availabilityDate(intent.freeAt));
      return;
    }
    case "feedback": {
      if (intent.sentiment === "neutral") break;
      const last = await lastMeal(user.id);
      if (!last) break;
      await applyFeedback(user.id, last.placeId, last.planId, intent.sentiment);
      await sendText(user, intent.sentiment === "positive" ? "Good to know. I'll keep it in the rotation." : "Sorry to hear it. I'll skip it for a while.");
      return;
    }
    case "what_do_you_know":
      await sendText(user, await agent.summary());
      return;
    case "forget":
      await sendText(user, await forget(user, intent.target));
      return;
    case "start":
      await agent.update({ paused: false });
      await sendText(user, "Welcome back. Text me when you're hungry.");
      return;
    case "booked": {
      const plan = await activePlanFor(user.id);
      if (plan?.organizerId === user.id && plan.status === "confirmed") {
        await markBooked(plan.id);
        return;
      }
      break;
    }
    case "cant_book": {
      const plan = await activePlanFor(user.id);
      if (plan?.organizerId === user.id && plan.status === "confirmed") {
        await bookingFailed(plan.id);
        return;
      }
      break;
    }
    case "paid": {
      const share = await db.query.splitShares.findFirst({
        where: and(eq(schema.splitShares.userId, user.id), inArray(schema.splitShares.status, ["asked", "failed"])),
        orderBy: (s, { desc: d }) => [d(s.id)],
      });
      if (share) {
        await markPaidOther(share.id);
        return;
      }
      break;
    }
    default:
      break;
  }
  await sendText(user, "I can find you somewhere to eat now, or plan a meal with friends. Hungry?");
}

export async function handleText(user: User, text: string, msg: Inbound): Promise<void> {
  const pending = await getPending(user.id);
  if (pending && (await answerPending(user, pending, text, msg))) return;
  const intent = await parseIntent(text, {
    lastQuestion: pending ? QUESTION[pending.kind] : undefined,
    localTime: fmtClock(now(), TZ()),
  });
  // A bare number or yes/no with no matching open question has nothing to act on.
  if ((intent.type === "choose" || intent.type === "confirm") && pending) {
    await sendText(user, pending.kind === "vote" ? "Tap an option in the poll, or reply 1, 2 or 3." : "Sorry, I didn't catch that.");
    return;
  }
  await act(user, intent);
}

export async function handleTapback(user: User, emoji: string, targetMessageId: string): Promise<void> {
  const sentiment = tapbackSentiment(emoji);
  if (!sentiment) return;
  const sent = await db.query.sentMessages.findFirst({
    where: and(eq(schema.sentMessages.userId, user.id), eq(schema.sentMessages.providerMessageId, targetMessageId)),
  });
  const pending = await getPending(user.id);
  const target =
    sent?.purpose === "feedback" && sent.placeId
      ? { placeId: sent.placeId, planId: sent.planId }
      : pending?.kind === "feedback"
        ? { placeId: String(pending.payload.placeId), planId: pending.planId ?? (pending.payload.planId as string | null) ?? null }
        : null;
  if (!target) return;
  await applyFeedback(user.id, target.placeId, target.planId, sentiment);
  await clearPending(user.id, "feedback");
}

export async function handlePollVote(user: User, optionTitle: string): Promise<void> {
  const poll = await db.query.polls.findFirst({
    where: and(eq(schema.polls.userId, user.id), eq(schema.polls.open, true)),
    orderBy: (p, { desc: d }) => [d(p.id)],
  });
  if (!poll) return;
  await recordVote(poll.planId, user.id, { title: optionTitle });
}

export async function handleContactCard(user: User, card: { name?: string; phones: string[]; emails: string[] }): Promise<void> {
  const pending = await getPending(user.id);
  if (pending?.kind === "contact_card") {
    await answerContactCard(user, pending.payload, card);
  }
}

