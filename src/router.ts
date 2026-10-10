// Every inbound message from any provider lands here: resolve the sender, then hand it to their personal agent.
// Messages from one person are handled one at a time, in order.
import { arrayContains, eq } from "drizzle-orm";
import { memberIn, newcomerJoined } from "./agents/coordinator.ts";
import { PersonalAgent } from "./agents/personal-agent.ts";
import { config } from "./config.ts";
import { db, schema } from "./db/index.ts";
import { demoKeyForHandle, handleDemoCommand, isDemoCommand } from "./demo/commands.ts";
import { handleContactCard, handlePollVote, handleTapback, handleText } from "./flows/conversation.ts";
import { findMyAnswer, startNewcomer, startOnboarding } from "./flows/onboarding.ts";
import { withLock } from "./lib/mutex.ts";
import { localDateKey } from "./lib/time.ts";
import { now } from "./clock.ts";
import { sendText, type Inbound, type User } from "./messaging.ts";
import { clearPending } from "./pending.ts";

const CODE = /\bcode[:\s]*([A-Za-z0-9]{4})\b/i;

export async function findUserByHandle(handle: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: arrayContains(schema.users.handles, [handle]) });
}

async function createUser(msg: Inbound, name: string | null): Promise<User> {
  const id = crypto.randomUUID();
  const [u] = await db
    .insert(schema.users)
    .values({
      id,
      name,
      handles: [msg.handle],
      channel: msg.channel,
      spaceId: msg.spaceId,
      foodieLine: msg.line ?? null,
      findmyStatus: msg.service === "SMS" ? "unavailable" : "none",
      demoKey: config.demo ? demoKeyForHandle(msg.handle) : null,
    })
    .returning();
  return u!;
}

export function routeInbound(msg: Inbound): Promise<void> {
  return withLock(`user:${msg.handle}`, async () => {
    try {
      await route(msg);
    } catch (e) {
      console.error(`[router] failed handling message from ${msg.handle}:`, e);
    }
  });
}

async function route(msg: Inbound): Promise<void> {
  let user = await findUserByHandle(msg.handle);

  // Keep the reply path current (shared-pool lines can differ per person).
  if (msg.group && !user) return; // Only known people's poll votes come from group chats.
  if (user && !msg.group && (user.spaceId !== msg.spaceId || (msg.line && user.foodieLine !== msg.line) || user.channel !== msg.channel)) {
    await PersonalAgent.for(user.id).update({ spaceId: msg.spaceId, foodieLine: msg.line ?? user.foodieLine, channel: msg.channel });
    user = { ...user, spaceId: msg.spaceId, foodieLine: msg.line ?? user.foodieLine, channel: msg.channel };
  }

  if (msg.kind === "text") {
    const text = msg.text.trim();

    // 1. Hidden demo commands (DEMO=1, organizer only).
    if (config.demo && user && isDemoCommand(text)) {
      await handleDemoCommand(user, text);
      return;
    }
    // Terminal/sim stand-in for the Find My card.
    if (user && msg.channel !== "imessage" && /^\/findmy\s+(yes|no)$/i.test(text)) {
      await findMyAnswer(user.id, /yes/i.test(text));
      return;
    }
    // 2. stop, without the LLM.
    if (user && /^stop\.?$/i.test(text)) {
      await PersonalAgent.for(user.id).update({ paused: true });
      await clearPending(user.id);
      await sendText(user, `Paused. I won't watch your location or message you first. Text "start" to undo.`);
      return;
    }
    // 3. Plan codes, before any LLM call.
    const code = text.match(CODE)?.[1];
    if (code) {
      const invite = await db.query.invites.findFirst({ where: eq(schema.invites.code, code.toUpperCase()) });
      if (invite) {
        const isNew = !user;
        if (!user) user = await createUser(msg, invite.inviteeName);
        const joined = await newcomerJoined(code, user.id);
        if (joined) {
          const plan = await db.query.plans.findFirst({ where: eq(schema.plans.id, joined.planId) });
          const today = plan?.windowEarliest && localDateKey(plan.windowEarliest, config.timezone) === localDateKey(now(), config.timezone);
          const meal = plan?.meal === "lunch" ? "lunch" : "dinner";
          const phrase = today ? (meal === "dinner" ? "dinner tonight" : "lunch today") : `${meal} tomorrow`;
          if (isNew || user.onboarding !== "done") {
            await startNewcomer(user, joined, phrase);
          } else {
            await sendText(user, `You're in for ${phrase} with ${joined.organizer.name ?? "your friend"}.`);
            await memberIn(joined.planId, user.id);
          }
          return;
        }
        if (isNew) {
          await startOnboarding(user);
          return;
        }
      }
    }
  }

  // New person, no code: setup.
  if (!user) {
    user = await createUser(msg, null);
    await startOnboarding(user);
    return;
  }

  // 4. Tapbacks, polls, contact cards.
  if (msg.kind === "reaction") {
    await handleTapback(user, msg.emoji, msg.targetMessageId);
    return;
  }
  if (msg.kind === "poll_vote") {
    if (msg.selected) await handlePollVote(user, msg.optionTitle);
    return;
  }
  if (msg.kind === "contact") {
    await handleContactCard(user, msg);
    return;
  }
  // 5–6. Pending question, then intent.
  await handleText(user, msg.text, msg);
}
