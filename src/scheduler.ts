// Durable delayed work. Every product timer is a row in `jobs`; a worker runs due jobs every 5 seconds,
// so nothing is lost on restart and /clock moves everything consistently.
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { now } from "./clock.ts";
import { db, schema } from "./db/index.ts";

export type JobKind =
  | "onboarding_link_nudge"
  | "onboarding_card_check"
  | "invite_timeout"
  | "go_without_timeout"
  | "poll_close"
  | "late_watch"
  | "after_meal"
  | "split_check"
  | "solo_feedback"
  | "plan_done";

type Handler = (payload: Record<string, unknown>) => Promise<void>;
const handlers = new Map<JobKind, Handler>();

export function onJob(kind: JobKind, handler: Handler): void {
  handlers.set(kind, handler);
}

export async function schedule(kind: JobKind, runAt: Date, payload: Record<string, unknown> = {}): Promise<number> {
  const [row] = await db.insert(schema.jobs).values({ kind, runAt, payload }).returning({ id: schema.jobs.id });
  return row!.id;
}

/** Cancels queued jobs of `kind` whose payload contains `match`. */
export async function cancelJobs(kind: JobKind, match: Record<string, unknown>): Promise<void> {
  await db
    .update(schema.jobs)
    .set({ status: "cancelled" })
    .where(and(eq(schema.jobs.kind, kind), eq(schema.jobs.status, "queued"), sql`${schema.jobs.payload} @> ${JSON.stringify(match)}::jsonb`));
}

export async function hasQueued(kind: JobKind, match: Record<string, unknown>): Promise<boolean> {
  const rows = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.kind, kind), eq(schema.jobs.status, "queued"), sql`${schema.jobs.payload} @> ${JSON.stringify(match)}::jsonb`))
    .limit(1);
  return rows.length > 0;
}

let running: Promise<number> | null = null;

/** Runs every due job once, oldest first. Returns how many ran. Safe to call concurrently. */
export function runDueJobs(): Promise<number> {
  if (running) return running.then(() => runDueJobs());
  running = (async () => {
    let count = 0;
    for (let guard = 0; guard < 500; guard++) {
      const [job] = await db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.status, "queued"), lte(schema.jobs.runAt, now())))
        .orderBy(asc(schema.jobs.runAt), asc(schema.jobs.id))
        .limit(1);
      if (!job) break;
      const claimed = await db
        .update(schema.jobs)
        .set({ status: "running", attempts: job.attempts + 1 })
        .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, "queued")))
        .returning({ id: schema.jobs.id });
      if (claimed.length === 0) continue;
      const handler = handlers.get(job.kind as JobKind);
      try {
        if (!handler) throw new Error(`no handler for ${job.kind}`);
        await handler(job.payload);
        await db.update(schema.jobs).set({ status: "done" }).where(eq(schema.jobs.id, job.id));
      } catch (e) {
        console.error(`[scheduler] job ${job.id} ${job.kind} failed:`, e);
        await db.update(schema.jobs).set({ status: "failed", lastError: String((e as Error).stack ?? e) }).where(eq(schema.jobs.id, job.id));
      }
      count++;
    }
    return count;
  })().finally(() => {
    running = null;
  });
  return running;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(intervalMs = 5000): void {
  if (timer) return;
  timer = setInterval(() => void runDueJobs().catch((e) => console.error("[scheduler]", e)), intervalMs);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
