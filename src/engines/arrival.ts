// Arrival engine (spec section 8). Pure functions; no I/O.
import { addMinutes, ceil5, maxDate } from "../lib/time.ts";

export const WALK_THRESHOLD_MIN = 15;

export type TravelMode = "walk" | "drive";

/** Walk when it's 15 minutes or less on foot; otherwise drive. */
export function chooseTravel(walkMin: number | null, driveMin: number | null): { travelMin: number; mode: TravelMode } | null {
  if (walkMin != null && walkMin <= WALK_THRESHOLD_MIN) return { travelMin: walkMin, mode: "walk" };
  if (driveMin != null) return { travelMin: driveMin, mode: "drive" };
  if (walkMin != null) return { travelMin: walkMin, mode: "walk" };
  return null;
}

export type Traveler = { userId: string; freeAt: Date; travelMin: number };

export type MeetResult = {
  meet: Date;
  arrivals: { userId: string; leave: Date; arrive: Date; leaveAt: Date }[];
};

/**
 * leave_i   = max(now, freeAt_i)
 * arrive_i  = leave_i + travel_i
 * meet      = latest arrive_i, rounded up to the next 5 minutes
 * leaveAt_i = meet − travel_i
 */
export function computeMeet(now: Date, travelers: Traveler[]): MeetResult {
  if (travelers.length === 0) throw new Error("computeMeet needs at least one traveler");
  const rows = travelers.map((t) => {
    const leave = maxDate(now, t.freeAt);
    return { userId: t.userId, leave, arrive: addMinutes(leave, t.travelMin), travelMin: t.travelMin };
  });
  const meet = ceil5(maxDate(...rows.map((r) => r.arrive)));
  return {
    meet,
    arrivals: rows.map((r) => ({ userId: r.userId, leave: r.leave, arrive: r.arrive, leaveAt: addMinutes(meet, -r.travelMin) })),
  };
}
