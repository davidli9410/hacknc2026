import { describe, expect, test } from "bun:test";
import { chooseTravel, computeMeet } from "../src/engines/arrival.ts";
import { computeFit, crewNovelty, rankGroup, rankSolo, type GroupCandidate, type SoloCandidate } from "../src/engines/ranking.ts";
import { addMinutes, fmtClock, zonedDate } from "../src/lib/time.ts";

const TZ = "America/New_York";
const at = (h: number, m: number) => zonedDate(2026, 10, 10, h, m, TZ);
const clock = (d: Date) => fmtClock(d, TZ);
const now = at(17, 50);
const free = { ronald: at(18, 0), clive: at(18, 20), eric: at(18, 0) };

const alwaysOpen = () => true;

function candidate(placeId: string, cuisine: string, price: number, travel: [number, number, number], fits: [number, number, number]): GroupCandidate {
  const ids = ["ronald", "clive", "eric"] as const;
  return {
    placeId,
    cuisine,
    priceEach: price,
    dietOk: true,
    isOpen: alwaysOpen,
    members: ids.map((id, i) => ({ userId: id, freeAt: free[id], travelMin: travel[i]!, mode: "drive" as const, fit: fits[i]!, veto: false })),
  };
}

// Section 8 table. Thai's average fit is 0.7 (0.8, 0.8, 0.5); the others 0.5.
const thai = () => candidate("thai", "Thai", 14, [30, 10, 15], [0.8, 0.8, 0.5]);
const pizza = () => candidate("pizza", "Pizza", 12, [25, 15, 10], [0.5, 0.5, 0.5]);
const taqueria = () => candidate("taqueria", "Mexican", 11, [35, 10, 20], [0.5, 0.5, 0.5]);
const rankInput = (candidates: GroupCandidate[]) => ({
  now,
  windowEarliest: at(17, 30),
  windowLatest: at(21, 0),
  ceiling: 15,
  candidates,
  novelty: () => 0,
});
const leaveTimes = (o: { arrivals: { userId: string; leaveAt: Date }[] }) =>
  Object.fromEntries(o.arrivals.map((a) => [a.userId, clock(a.leaveAt)]));

describe("arrival engine (spec section 8)", () => {
  test("demo timings: meet 6:30, leave 6:00 / 6:20 / 6:15", () => {
    const r = computeMeet(now, [
      { userId: "ronald", freeAt: free.ronald, travelMin: 30 },
      { userId: "clive", freeAt: free.clive, travelMin: 10 },
      { userId: "eric", freeAt: free.eric, travelMin: 15 },
    ]);
    expect(clock(r.meet)).toBe("6:30");
    expect(leaveTimes(r)).toEqual({ ronald: "6:00", clive: "6:20", eric: "6:15" });
  });

  test("meet rounds up to the next 5 minutes", () => {
    const r = computeMeet(now, [{ userId: "a", freeAt: at(18, 0), travelMin: 12 }]);
    expect(clock(r.meet)).toBe("6:15");
    expect(clock(r.arrivals[0]!.leaveAt)).toBe("6:03");
  });

  test("leave is never before now", () => {
    const r = computeMeet(at(18, 10), [{ userId: "a", freeAt: at(18, 0), travelMin: 10 }]);
    expect(clock(r.meet)).toBe("6:20");
  });

  test("walk when 15 minutes or less on foot", () => {
    expect(chooseTravel(15, 5)).toEqual({ travelMin: 15, mode: "walk" });
    expect(chooseTravel(16, 5)).toEqual({ travelMin: 5, mode: "drive" });
    expect(chooseTravel(null, 7)).toEqual({ travelMin: 7, mode: "drive" });
  });
});

describe("group ranking (spec section 8)", () => {
  test("Thai, Pizza, Taqueria in that order with the table's meets, leave times and scores", () => {
    const { options, relaxed } = rankGroup(rankInput([taqueria(), pizza(), thai()]));
    expect(relaxed).toEqual([]);
    expect(options.map((o) => o.candidate.placeId)).toEqual(["thai", "pizza", "taqueria"]);
    const [t, p, q] = options;
    expect(clock(t!.meet)).toBe("6:30");
    expect(leaveTimes(t!)).toEqual({ ronald: "6:00", clive: "6:20", eric: "6:15" });
    expect(clock(p!.meet)).toBe("6:35");
    expect(leaveTimes(p!)).toEqual({ ronald: "6:10", clive: "6:20", eric: "6:25" });
    expect(clock(q!.meet)).toBe("6:35");
    expect(leaveTimes(q!)).toEqual({ ronald: "6:00", clive: "6:25", eric: "6:15" });
    expect(t!.score).toBeCloseTo(16.5, 5);
    expect(p!.score).toBeCloseTo(20.5, 5);
    expect(q!.score).toBeCloseTo(32, 5);
  });

  test("Thai and Pizza tie at 30.5 before fit", () => {
    const flat = (c: GroupCandidate) => ({ ...c, members: c.members.map((m) => ({ ...m, fit: 0 })) });
    const { options } = rankGroup(rankInput([flat(thai()), flat(pizza()), flat(taqueria())]));
    const byId = Object.fromEntries(options.map((o) => [o.candidate.placeId, o.score]));
    expect(byId.thai).toBeCloseTo(30.5, 5);
    expect(byId.pizza).toBeCloseTo(30.5, 5);
    expect(byId.taqueria).toBeCloseTo(42, 5);
  });

  test("a 36-minute drive fails until the travel cap is relaxed", () => {
    const far = candidate("far", "Indian", 12, [36, 20, 20], [0.5, 0.5, 0.5]);
    const strict = rankGroup(rankInput([thai(), pizza(), taqueria(), far]));
    expect(strict.options.map((o) => o.candidate.placeId)).not.toContain("far");
    const relaxed = rankGroup(rankInput([thai(), pizza(), far]));
    expect(relaxed.relaxed).toEqual(["gap", "travelCap"]);
    expect(relaxed.options.map((o) => o.candidate.placeId)).toContain("far");
  });

  test("a 26-minute gap fails until the gap limit is relaxed", () => {
    const uneven = candidate("uneven", "Indian", 12, [35, 9, 20], [0.5, 0.5, 0.5]);
    expect(rankGroup(rankInput([thai(), pizza(), taqueria(), uneven])).options.map((o) => o.candidate.placeId)).not.toContain("uneven");
    const r = rankGroup(rankInput([thai(), pizza(), uneven]));
    expect(r.relaxed).toEqual(["gap"]);
    expect(r.options.map((o) => o.candidate.placeId)).toContain("uneven");
  });

  test("price and veto never relax", () => {
    const pricey = candidate("pricey", "French", 16, [10, 10, 10], [1, 1, 1]);
    const vetoed = candidate("ramen", "Ramen", 12, [10, 10, 10], [1, 1, 1]);
    vetoed.members[1]!.veto = true;
    const notVeg = { ...candidate("steak", "Steak", 12, [10, 10, 10], [1, 1, 1]), dietOk: false };
    const r = rankGroup(rankInput([pricey, vetoed, notVeg]));
    expect(r.options).toEqual([]);
    expect(r.relaxed).toEqual(["gap", "travelCap", "diversity", "window"]);
  });

  test("cuisine diversity relaxes before the time window", () => {
    const thai2 = candidate("thai2", "Thai", 12, [28, 12, 15], [0.5, 0.5, 0.5]);
    const r = rankGroup(rankInput([thai(), thai2, pizza()]));
    expect(r.relaxed).toEqual(["gap", "travelCap", "diversity"]);
    expect(r.options.length).toBe(3);
  });

  test("must be open from meet until 75 minutes after", () => {
    const closesEarly = { ...thai(), isOpen: (_from: Date, to: Date) => to.getTime() <= at(19, 30).getTime() };
    const r = rankGroup(rankInput([closesEarly, pizza(), taqueria()]));
    expect(r.options.map((o) => o.candidate.placeId)).not.toContain("thai");
  });

  test("time window relaxes by 30 minutes, last", () => {
    const late = { ...rankInput([thai(), pizza(), taqueria()]), windowLatest: at(18, 30) };
    const r = rankGroup(late);
    expect(r.relaxed).toEqual(["gap", "travelCap", "diversity", "window"]);
    expect(r.options.length).toBe(3);
  });

  test("meet is never before the window opens", () => {
    const r = rankGroup({ ...rankInput([thai(), pizza(), taqueria()]), windowEarliest: at(19, 0) });
    expect(clock(r.options[0]!.meet)).toBe("7:00");
    expect(leaveTimes(r.options.find((o) => o.candidate.placeId === "thai")!)).toEqual({ ronald: "6:30", clive: "6:50", eric: "6:45" });
  });
});

describe("solo ranking", () => {
  const soloNow = at(12, 5);
  const solo = (placeId: string, cuisine: string, price: number, travel: number, fit: number, novelty: number): SoloCandidate => ({
    placeId, cuisine, priceEach: price, dietOk: true, veto: false, isOpen: alwaysOpen, travelMin: travel, mode: "walk", fit, novelty, moodMatch: true,
  });

  test("burrito (loved), noodle bar (new match), falafel", () => {
    const r = rankSolo({
      now: soloNow,
      hardMax: 16,
      candidates: [solo("falafel", "Middle Eastern", 9, 4, 0.5, 3), solo("noodle", "Noodles", 13, 9, 0.7, 3), solo("burrito", "Mexican", 11, 6, 0.9, 0)],
    });
    expect(r.map((o) => o.candidate.placeId)).toEqual(["burrito", "noodle", "falafel"]);
  });

  test("hard max filters pricier places", () => {
    const r = rankSolo({ now: soloNow, hardMax: 12, candidates: [solo("noodle", "Noodles", 13, 9, 0.7, 3)] });
    expect(r).toEqual([]);
  });
});

describe("fit and novelty", () => {
  test("fit formula", () => {
    expect(computeFit(0, null)).toBe(0.5);
    expect(computeFit(0.6, null)).toBeCloseTo(0.8, 5);
    expect(computeFit(0.4, 1)).toBeCloseTo(0.9, 5);
    expect(computeFit(1, 1)).toBe(1);
    expect(computeFit(-1, -1)).toBe(0);
  });

  test("crew novelty is 3 after 60 days", () => {
    expect(crewNovelty(null, now)).toBe(3);
    expect(crewNovelty(addMinutes(now, -10 * 24 * 60), now)).toBe(0);
    expect(crewNovelty(addMinutes(now, -61 * 24 * 60), now)).toBe(3);
  });
});
