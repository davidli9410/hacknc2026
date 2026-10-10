// Hidden organizer commands in DEMO=1: /late clive 8, /paid 52, /clock 17:50, /reset.
import { and, desc, eq, inArray } from "drizzle-orm";
import { setClockTimeOfDay } from "../clock.ts";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { recordDemoPayment, reportLate } from "../flows/after.ts";
import { fmtClock, parseClock } from "../lib/time.ts";
import { sendText, type User } from "../messaging.ts";
import { cancelJobs, runDueJobs } from "../scheduler.ts";
import type { DemoKey } from "./data.ts";
import { demoHandles, seedDemo, type DemoChannel } from "./seed.ts";

export const isDemoCommand = (text: string) => /^\/(late|paid|clock|reset)\b/i.test(text);

export function demoKeyForHandle(handle: string): DemoKey | null {
  for (const key of ["organizer", "member", "newcomer"] as const) if (demoHandles(key).includes(handle)) return key;
  return null;
}

async function latestPlan(organizerId: string) {
  const [plan] = await db
    .select()
    .from(schema.plans)
    .where(and(eq(schema.plans.organizerId, organizerId), eq(schema.plans.kind, "group"), inArray(schema.plans.status, ["confirmed", "done"])))
    .orderBy(desc(schema.plans.createdAt))
    .limit(1);
  return plan ?? null;
}

export async function handleDemoCommand(user: User, text: string): Promise<void> {
  if (user.demoKey !== "organizer") return;
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd!.toLowerCase()) {
    case "/clock": {
      const t = parseClock(args.join(" "), false);
      if (!t) {
        await sendText(user, "Usage: /clock 17:50");
        return;
      }
      const at = await setClockTimeOfDay(t.hour, t.minute);
      await sendText(user, `Clock set to ${fmtClock(at, config.timezone)}.`);
      await runDueJobs();
      return;
    }
    case "/reset": {
      await seedDemo(user.channel as DemoChannel);
      const fresh = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
      await sendText(fresh ?? user, "Demo reset.");
      return;
    }
    case "/late": {
      const [name, mins] = args;
      const plan = await latestPlan(user.id);
      const minutes = Number(mins);
      if (!plan || !name || !Number.isFinite(minutes)) {
        await sendText(user, "Usage: /late clive 8 (needs a confirmed plan)");
        return;
      }
      const members = await db.select().from(schema.planMembers).where(eq(schema.planMembers.planId, plan.id));
      const people = await db.select().from(schema.users).where(inArray(schema.users.id, members.map((m) => m.userId)));
      const who = people.find((p) => p.name?.toLowerCase() === name.toLowerCase());
      if (!who) {
        await sendText(user, `No ${name} in the plan.`);
        return;
      }
      await reportLate(plan.id, who.id, minutes);
      return;
    }
    case "/paid": {
      const amount = Number(args[0]?.replace("$", ""));
      const plan = await latestPlan(user.id);
      if (!plan || !Number.isFinite(amount) || amount <= 0) {
        await sendText(user, "Usage: /paid 52 (needs a confirmed plan)");
        return;
      }
      await cancelJobs("split_check", { planId: plan.id });
      await recordDemoPayment(plan.id, user, amount);
      return;
    }
  }
}
