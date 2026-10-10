// The only source of "now". Real time plus an offset that /clock (and the sim) can set.
import { eq } from "drizzle-orm";
import { config } from "./config.ts";
import { db, schema } from "./db/index.ts";
import { atLocalTime, MINUTE, zonedDate, zonedParts } from "./lib/time.ts";

const KEY = "clock_offset_ms";
let offsetMs = 0;
const listeners = new Set<() => void>();

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

export function realNow(): Date {
  return new Date();
}

export async function loadClock(): Promise<void> {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, KEY) });
  if (row && typeof row.value === "number") {
    offsetMs = row.value;
  } else if (config.demo) {
    // Demo runs on DEMO_DATE at the current wall-clock time.
    const [y, m, d] = config.demoDate.split("-").map(Number) as [number, number, number];
    const p = zonedParts(new Date(), config.timezone);
    await setClock(zonedDate(y, m, d, p.hour, p.minute, config.timezone));
  }
}

export async function setClock(target: Date): Promise<void> {
  offsetMs = target.getTime() - Date.now();
  await db
    .insert(schema.settings)
    .values({ key: KEY, value: offsetMs })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: offsetMs } });
  for (const l of listeners) l();
}

/** Sets the time of day on the current (possibly simulated) date. */
export async function setClockTimeOfDay(hour: number, minute: number): Promise<Date> {
  const target = atLocalTime(now(), hour, minute, config.timezone);
  await setClock(target);
  return target;
}

export async function advanceClock(minutes: number): Promise<void> {
  await setClock(new Date(now().getTime() + minutes * MINUTE));
}

export function onClockChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Routes rejects traffic-aware requests that depart in the past. If `t` is in the real past (the demo clock
 * can be), use the next real future occurrence of the same weekday and time of day.
 */
export function routesDepartureTime(t: Date): Date {
  const real = Date.now() + MINUTE;
  let ms = t.getTime();
  const week = 7 * 24 * 60 * MINUTE;
  while (ms < real) ms += week;
  return new Date(ms);
}
