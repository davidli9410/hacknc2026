// Ranking (spec section 8): hard filters, score, top three, relaxation. Pure functions; no I/O.
import { addMinutes, ceil5, maxDate, minutesBetween } from "../lib/time.ts";
import { computeMeet, type MeetResult, type TravelMode } from "./arrival.ts";

export const TRAVEL_CAP_MIN = 35;
export const TRAVEL_CAP_RELAXED_MIN = TRAVEL_CAP_MIN + 10;
export const GAP_CAP_MIN = 25;
export const OPEN_AFTER_MEET_MIN = 75;
export const WINDOW_RELAX_MIN = 30;

export type MemberEval = {
  userId: string;
  freeAt: Date;
  travelMin: number;
  mode: TravelMode;
  fit: number;
  veto: boolean;
};

export type GroupCandidate = {
  placeId: string;
  cuisine: string;
  priceEach: number;
  /** Every member's diet tags are satisfied (checked by the coordinator). */
  dietOk: boolean;
  isOpen: (from: Date, to: Date) => boolean;
  members: MemberEval[];
};

export type Relaxation = "gap" | "travelCap" | "diversity" | "window";

export type RankedGroupOption = {
  candidate: GroupCandidate;
  meet: Date;
  arrivals: MeetResult["arrivals"];
  totalTravel: number;
  gap: number;
  avgFit: number;
  score: number;
};

export type GroupRankInput = {
  now: Date;
  /** Earliest acceptable meet time. */
  windowEarliest: Date;
  /** Latest acceptable meet time. */
  windowLatest: Date;
  /** Lowest maxPrice across members. Never relaxed. */
  ceiling: number;
  candidates: GroupCandidate[];
  novelty: (placeId: string) => number;
};

type Limits = { travelCap: number; gapCap: number; diversity: boolean; windowExtra: number };

const RELAX_STEPS: { relax: Relaxation; apply: (l: Limits) => Limits }[] = [
  { relax: "gap", apply: (l) => ({ ...l, gapCap: Infinity }) },
  { relax: "travelCap", apply: (l) => ({ ...l, travelCap: TRAVEL_CAP_RELAXED_MIN }) },
  { relax: "diversity", apply: (l) => ({ ...l, diversity: false }) },
  { relax: "window", apply: (l) => ({ ...l, windowExtra: WINDOW_RELAX_MIN }) },
];

export function rankGroup(input: GroupRankInput): { options: RankedGroupOption[]; relaxed: Relaxation[] } {
  let limits: Limits = { travelCap: TRAVEL_CAP_MIN, gapCap: GAP_CAP_MIN, diversity: true, windowExtra: 0 };
  const relaxed: Relaxation[] = [];
  let options = pickGroup(input, limits);
  for (const step of RELAX_STEPS) {
    if (options.length >= 3) break;
    limits = step.apply(limits);
    relaxed.push(step.relax);
    options = pickGroup(input, limits);
  }
  return { options, relaxed };
}

function pickGroup(input: GroupRankInput, limits: Limits): RankedGroupOption[] {
  const latest = addMinutes(input.windowLatest, limits.windowExtra);
  const notBefore = ceil5(input.windowEarliest);
  const feasible: Omit<RankedGroupOption, "score">[] = [];

  for (const c of input.candidates) {
    if (c.members.length === 0) continue;
    if (c.priceEach > input.ceiling) continue;
    if (!c.dietOk) continue;
    if (c.members.some((m) => m.veto)) continue;
    const travels = c.members.map((m) => m.travelMin);
    const longest = Math.max(...travels);
    const shortest = Math.min(...travels);
    if (longest > limits.travelCap) continue;
    if (longest - shortest > limits.gapCap) continue;

    const raw = computeMeet(input.now, c.members.map((m) => ({ userId: m.userId, freeAt: m.freeAt, travelMin: m.travelMin })));
    const meet = maxDate(raw.meet, notBefore);
    if (meet.getTime() > latest.getTime()) continue;
    if (!c.isOpen(meet, addMinutes(meet, OPEN_AFTER_MEET_MIN))) continue;

    const travelOf = new Map(c.members.map((m) => [m.userId, m.travelMin]));
    const arrivals = raw.arrivals.map((a) => ({ ...a, leaveAt: addMinutes(meet, -(travelOf.get(a.userId) ?? 0)) }));
    feasible.push({
      candidate: c,
      meet,
      arrivals,
      totalTravel: travels.reduce((s, t) => s + t, 0),
      gap: longest - shortest,
      avgFit: c.members.reduce((s, m) => s + m.fit, 0) / c.members.length,
    });
  }
  if (feasible.length === 0) return [];

  const earliestMeet = Math.min(...feasible.map((f) => f.meet.getTime()));
  const scored: RankedGroupOption[] = feasible.map((f) => ({
    ...f,
    score:
      1.0 * minutesBetween(new Date(earliestMeet), f.meet) +
      0.3 * f.totalTravel +
      0.7 * f.gap -
      20 * f.avgFit -
      input.novelty(f.candidate.placeId),
  }));
  scored.sort((a, b) => a.score - b.score || a.candidate.placeId.localeCompare(b.candidate.placeId));
  return topThree(scored, (o) => o.candidate.cuisine, limits.diversity);
}

/** Top three by score. Strict diversity keeps only distinct cuisines; otherwise distinct first, then fill. */
export function topThree<T>(sorted: T[], cuisineOf: (t: T) => string, strictDiversity: boolean): T[] {
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const o of sorted) {
    if (picked.length === 3) break;
    const cuisine = cuisineOf(o).toLowerCase();
    if (seen.has(cuisine)) continue;
    seen.add(cuisine);
    picked.push(o);
  }
  if (!strictDiversity) {
    for (const o of sorted) {
      if (picked.length === 3) break;
      if (!picked.includes(o)) picked.push(o);
    }
    // Keep score order after filling.
    picked.sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b));
  }
  return picked;
}

// ---------------------------------------------------------------------------------------------
// Solo

export const SOLO_STAY_MIN = 45;
export const MOOD_BONUS = 5;

export type SoloCandidate = {
  placeId: string;
  cuisine: string;
  priceEach: number;
  dietOk: boolean;
  veto: boolean;
  isOpen: (from: Date, to: Date) => boolean;
  travelMin: number;
  mode: TravelMode;
  fit: number;
  novelty: number;
  moodMatch: boolean;
};

export type RankedSoloOption = { candidate: SoloCandidate; arrive: Date; score: number };

export function rankSolo(input: { now: Date; hardMax: number; candidates: SoloCandidate[] }): RankedSoloOption[] {
  const scored: RankedSoloOption[] = [];
  for (const c of input.candidates) {
    if (c.priceEach > input.hardMax) continue;
    if (!c.dietOk || c.veto) continue;
    if (c.travelMin > TRAVEL_CAP_MIN) continue;
    const arrive = addMinutes(input.now, c.travelMin);
    if (!c.isOpen(arrive, addMinutes(arrive, SOLO_STAY_MIN))) continue;
    const score = 0.3 * c.travelMin - 20 * c.fit - c.novelty - (c.moodMatch ? MOOD_BONUS : 0);
    scored.push({ candidate: c, arrive, score });
  }
  scored.sort((a, b) => a.score - b.score || a.candidate.placeId.localeCompare(b.candidate.placeId));
  return topThree(scored, (o) => o.candidate.cuisine, false);
}

/** fit = clamp(0.5 + taste/2 + (rating === 1 ? 0.2 : 0), 0, 1) — computed by each personal agent. */
export function computeFit(taste: number, placeRating: number | null | undefined): number {
  const t = Math.max(-1, Math.min(1, taste));
  return Math.max(0, Math.min(1, 0.5 + t / 2 + (placeRating === 1 ? 0.2 : 0)));
}

/** Crew novelty bonus: 3 if the crew hasn't been there in 60 days. */
export function crewNovelty(lastVisit: Date | null | undefined, now: Date): number {
  if (!lastVisit) return 3;
  return minutesBetween(lastVisit, now) > 60 * 24 * 60 ? 3 : 0;
}
