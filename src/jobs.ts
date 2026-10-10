// Wires each scheduled job kind to its handler.
import { eq } from "drizzle-orm";
import { goWithoutTimeout, inviteTimeout, planDone, pollTimeout } from "./agents/coordinator.ts";
import { PersonalAgent } from "./agents/personal-agent.ts";
import { db, schema } from "./db/index.ts";
import { afterMeal, askFeedback, lateWatchTick, splitCheck } from "./flows/after.ts";
import { cardCheck, linkNudge } from "./flows/onboarding.ts";
import { onJob } from "./scheduler.ts";

export function registerJobs(): void {
  onJob("onboarding_link_nudge", async (p) => linkNudge(String(p.userId)));
  onJob("onboarding_card_check", async (p) => cardCheck(String(p.userId), String(p.deadline)));
  onJob("invite_timeout", async (p) => inviteTimeout(String(p.planId)));
  onJob("go_without_timeout", async (p) => goWithoutTimeout(String(p.planId)));
  onJob("poll_close", async (p) => pollTimeout(String(p.planId)));
  onJob("late_watch", async (p) => lateWatchTick(String(p.planId)));
  onJob("after_meal", async (p) => afterMeal(String(p.planId)));
  onJob("split_check", async (p) => splitCheck(String(p.planId)));
  onJob("plan_done", async (p) => planDone(String(p.planId)));
  onJob("solo_feedback", async (p) => {
    const plan = await db.query.plans.findFirst({ where: eq(schema.plans.id, String(p.planId)) });
    if (!plan?.place) return;
    const user = await PersonalAgent.for(String(p.userId)).user();
    await askFeedback(user, plan.place, plan.id);
    await db.update(schema.plans).set({ status: "done" }).where(eq(schema.plans.id, plan.id));
  });
}
