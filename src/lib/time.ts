// Time helpers. Everything user-facing is in the configured TIMEZONE; everything stored is a UTC instant.

export const MINUTE = 60_000;

export type ZonedParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
};

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function zonedParts(date: Date, tz: string): ZonedParts & { second: number } {
  const parts = partsFormatter(tz).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

/** Offset of `tz` from UTC at `date`, in minutes (e.g. -240 for EDT). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / MINUTE);
}

/** The UTC instant for a wall-clock time in `tz`. */
export function zonedDate(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes handle the hour around DST changes.
  let offset = tzOffsetMinutes(new Date(guess), tz);
  let result = guess - offset * MINUTE;
  offset = tzOffsetMinutes(new Date(result), tz);
  result = guess - offset * MINUTE;
  return new Date(result);
}

/** Same calendar day as `date` in `tz`, at hour:minute. */
export function atLocalTime(date: Date, hour: number, minute: number, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedDate(p.year, p.month, p.day, hour, minute, tz);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MINUTE;
}

/** Rounds up to the next 5-minute mark; a time already on a mark stays put. */
export function ceil5(date: Date): Date {
  const step = 5 * MINUTE;
  return new Date(Math.ceil(date.getTime() / step) * step);
}

export function maxDate(...dates: Date[]): Date {
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/** "6:30", "12:05" — the transcripts use a 12-hour clock without am/pm. */
export function fmtClock(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h}:${String(p.minute).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "YYYY-MM-DD" in `tz`. */
export function localDateKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Parses "17:50", "5:50pm", "6", "6:30 pm" into 24h hour/minute. Bare small hours are read as pm (dinner context). */
export function parseClock(input: string, assumePm = true): { hour: number; minute: number } | null {
  const m = input.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3];
  if (hour > 23 || minute > 59) return null;
  if (mer?.startsWith("p") && hour < 12) hour += 12;
  else if (mer?.startsWith("a") && hour === 12) hour = 0;
  else if (!mer && assumePm && hour >= 1 && hour <= 9) hour += 12;
  return { hour, minute };
}
