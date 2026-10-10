// Every section 9 transcript, end to end through the router, coordinator and personal agents.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { prepareSimEnv } from "../src/sim/env.ts";

let checks: Awaited<ReturnType<typeof import("../src/sim/scenarios.ts").runScenarios>> = [];

beforeAll(async () => {
  await prepareSimEnv("foodie_test");
  const { runScenarios } = await import("../src/sim/scenarios.ts");
  checks = await runScenarios(false);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import("../src/db/index.ts");
  await closeDb();
});

const names = ["9.1 Setup", "9.2 Solo", "9.2 Solo, mood already given", "9.3–9.7 Group dinner", "9.4 Invited member can't make it", "9.4 Invited member is free later", "Go without, tie, runner-up, who paid", "Memory and transparency"];

for (const name of names) {
  test(`transcript: ${name}`, () => {
    const mine = checks.filter((c) => c.scenario === name);
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) expect({ who: c.who, messages: c.actual }).toEqual({ who: c.who, messages: c.expected });
  });
}
