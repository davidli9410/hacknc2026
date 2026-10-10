import { describe, expect, test } from "bun:test";
import { dietOk, matchesTarget } from "../src/diet.ts";
import { parseAvailability, parseDietAnswer, parseNames, parseRules, tapbackSentiment } from "../src/intent.ts";
import { isOpenBetween, mapsDirectionsUrl } from "../src/integrations/places.ts";
import { fmtClock, parseClock, zonedDate } from "../src/lib/time.ts";
import { roundArea } from "../src/protocol.ts";
import { normalizeHandle } from "../src/router-util.ts";

const TZ = "America/New_York";

describe("rules parser", () => {
  test("transcript phrases", () => {
    expect(parseRules("I'm hungry")).toEqual({ type: "hungry_solo", mood: undefined });
    expect(parseRules("I'm starving")).toEqual({ type: "hungry_solo", mood: "filling" });
    expect(parseRules("filling")).toEqual({ type: "set_pref", mood: "filling" });
    expect(parseRules("dinner tonight with Clive and Eric")).toEqual({ type: "plan_group", names: ["Clive", "Eric"], when: "tonight", meal: "dinner" });
    expect(parseRules("lunch tomorrow w/ Sam, Ana & Bo")).toEqual({ type: "plan_group", names: ["Sam", "Ana", "Bo"], when: "tomorrow", meal: "lunch" });
    expect(parseRules("1")).toEqual({ type: "choose", n: 1 });
    expect(parseRules("yes")).toEqual({ type: "confirm", yes: true });
    expect(parseRules("in")).toEqual({ type: "confirm", yes: true });
    expect(parseRules("can't")).toEqual({ type: "availability", unavailable: true });
    expect(parseRules("after 7")).toEqual({ type: "availability", freeAt: { hour: 19, minute: 0 } });
    expect(parseRules("booked")).toEqual({ type: "booked" });
    expect(parseRules("paid")).toEqual({ type: "paid" });
    expect(parseRules("stop")).toEqual({ type: "stop" });
  });

  test("vetoes", () => {
    expect(parseRules("not ramen")).toEqual({ type: "veto", target: "ramen", never: false });
    expect(parseRules("never ramen")).toEqual({ type: "veto", target: "ramen", never: true });
  });

  test("transparency", () => {
    expect(parseRules("What do you know about me?")).toEqual({ type: "what_do_you_know" });
    expect(parseRules("forget my budget")).toEqual({ type: "forget", target: "budget" });
  });

  test("budget overrides", () => {
    expect(parseRules("treat night, up to $40")).toEqual({ type: "budget_override", kind: "treat", amount: 40 });
    expect(parseRules("keep it cheap")).toEqual({ type: "budget_override", kind: "cheap", amount: undefined });
  });

  test("diet answers", () => {
    expect(parseDietAnswer("vegetarian")).toEqual({ diet: ["vegetarian"], noRestrictions: false, maxPerMeal: undefined });
    expect(parseDietAnswer("no seafood, $20")).toEqual({ diet: ["no seafood"], noRestrictions: false, maxPerMeal: 20 });
    expect(parseDietAnswer("nothing")).toEqual({ diet: [], noRestrictions: true, maxPerMeal: undefined });
    expect(parseDietAnswer("no mushrooms")).toEqual({ diet: ["no mushrooms"], noRestrictions: false, maxPerMeal: undefined });
    expect(parseDietAnswer("what?")).toBeNull();
  });

  test("availability times read as evening for small hours", () => {
    expect(parseAvailability("6:30")).toEqual({ hour: 18, minute: 30 });
    expect(parseAvailability("free at 11am")).toEqual({ hour: 11, minute: 0 });
    expect(parseAvailability("7pm")).toEqual({ hour: 19, minute: 0 });
  });

  test("names", () => {
    expect(parseNames("Clive and Eric")).toEqual(["Clive", "Eric"]);
    expect(parseNames("the usual")).toEqual(["the usual"]);
  });

  test("tapbacks", () => {
    expect(tapbackSentiment("❤️")).toBe("positive");
    expect(tapbackSentiment("👍")).toBe("positive");
    expect(tapbackSentiment("👎")).toBe("negative");
    expect(tapbackSentiment("😂")).toBeNull();
  });
});

describe("diet rules (section 6 table)", () => {
  const place = (primaryType: string, servesVegetarianFood?: boolean) => ({ name: "X", cuisine: "X", primaryType, types: [primaryType], servesVegetarianFood });
  test("vegetarian excludes only an explicit no", () => {
    expect(dietOk(place("thai_restaurant", true), ["vegetarian"])).toBe(true);
    expect(dietOk(place("thai_restaurant"), ["vegetarian"])).toBe(true);
    expect(dietOk(place("steak_house", false), ["vegetarian"])).toBe(false);
  });
  test("vegan also excludes meat-heavy types", () => {
    expect(dietOk(place("barbecue_restaurant", true), ["vegan"])).toBe(false);
  });
  test("no seafood excludes seafood and sushi", () => {
    expect(dietOk(place("sushi_restaurant", true), ["no seafood"])).toBe(false);
    expect(dietOk(place("seafood_restaurant", true), ["no seafood"])).toBe(false);
    expect(dietOk(place("pizza_restaurant", true), ["no seafood"])).toBe(true);
  });
  test("other tags only exclude a named cuisine", () => {
    expect(dietOk({ ...place("ramen_restaurant"), cuisine: "Ramen" }, ["no ramen"])).toBe(false);
    expect(dietOk(place("pizza_restaurant"), ["halal", "no pork"])).toBe(true);
  });
  test("veto targets", () => {
    expect(matchesTarget("ramen", { placeId: "x", name: "Ramen house", cuisine: "Ramen" })).toBe(true);
    expect(matchesTarget("burritos", { placeId: "x", name: "Burrito place", cuisine: "Burritos" })).toBe(true);
    expect(matchesTarget("thai", { placeId: "x", name: "Pizza spot", cuisine: "Pizza" })).toBe(false);
  });
});

describe("opening hours", () => {
  const daily = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 11, minute: 0 }, close: { day, hour: 22, minute: 0 } }));
  const at = (h: number, m: number) => zonedDate(2026, 10, 10, h, m, TZ);
  test("inside and outside", () => {
    expect(isOpenBetween(daily, at(18, 30), at(19, 45), TZ)).toBe(true);
    expect(isOpenBetween(daily, at(21, 0), at(22, 15), TZ)).toBe(false);
    expect(isOpenBetween(daily, at(10, 30), at(11, 30), TZ)).toBe(false);
  });
  test("past midnight", () => {
    const late = [{ open: { day: 6, hour: 18, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } }];
    expect(isOpenBetween(late, at(23, 30), at(23, 59), TZ)).toBe(true); // Oct 10 2026 is a Saturday
  });
  test("unknown hours count as open; 24/7 is open", () => {
    expect(isOpenBetween(null, at(3, 0), at(4, 0), TZ)).toBe(true);
    expect(isOpenBetween([{ open: { day: 0, hour: 0, minute: 0 } }], at(3, 0), at(4, 0), TZ)).toBe(true);
  });
});

describe("helpers", () => {
  test("handles", () => {
    expect(normalizeHandle("(919) 555-0101")).toBe("+19195550101");
    expect(normalizeHandle("+1 919 555 0101")).toBe("+19195550101");
    expect(normalizeHandle("Eric@Example.com")).toBe("eric@example.com");
    expect(normalizeHandle("term:ronald")).toBe("term:ronald");
    expect(normalizeHandle("abc")).toBeNull();
  });
  test("clock formatting and parsing", () => {
    expect(fmtClock(zonedDate(2026, 10, 10, 18, 5, TZ), TZ)).toBe("6:05");
    expect(fmtClock(zonedDate(2026, 10, 10, 12, 0, TZ), TZ)).toBe("12:00");
    expect(parseClock("17:50", false)).toEqual({ hour: 17, minute: 50 });
    expect(parseClock("5:50pm")).toEqual({ hour: 17, minute: 50 });
  });
  test("DST is handled when building local times", () => {
    expect(zonedDate(2026, 3, 8, 12, 0, TZ).toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(zonedDate(2026, 11, 1, 12, 0, TZ).toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });
  test("area rounding is about 2 km and never exact", () => {
    expect(roundArea(35.9101)).toBe(35.92);
    expect(roundArea(-79.0533)).toBe(-79.06);
  });
  test("walking directions link", () => {
    expect(mapsDirectionsUrl({ lat: 1, lng: 2, placeId: "ChIJx", name: "A" }, "walk")).toContain("travelmode=walking");
  });
});
