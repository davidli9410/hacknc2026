import { describe, expect, test } from "bun:test";
import { computeBudget, computeBudgetWithoutBank, mealsPerWeekFromHistory, proposeLimits, type Purchase } from "../src/engines/budget.ts";

const base = { monthlyLimit: 240, mealCap: 20, spentThisMonth: 100, mealsPerWeek: 3, dayOfMonth: 10, daysInMonth: 31 };

describe("budget engine (spec section 7)", () => {
  test("$240 limit, $100 spent by day 10, 3 meals a week: about nine meals left, base near $15", () => {
    const r = computeBudget({ ...base, meal: "dinner" });
    expect(r.weeksLeft).toBeCloseTo(3.0, 5);
    expect(r.mealsLeft).toBeCloseTo(9, 5);
    expect(r.base).toBeCloseTo(15.56, 2);
  });

  test("dinner: target $18.67, hard max $20", () => {
    const r = computeBudget({ ...base, meal: "dinner" });
    expect(r.target).toBeCloseTo(18.67, 2);
    expect(r.hardMax).toBe(20);
  });

  test("lunch: target $12.44, hard max $16", () => {
    const r = computeBudget({ ...base, meal: "lunch" });
    expect(r.target).toBeCloseTo(12.44, 2);
    expect(r.hardMax).toBe(16);
  });

  test("Clive's seed: $200 limit, $115 spent, cap $25 gives base $9.44, dinner target $11.33, hard max $15", () => {
    const r = computeBudget({ ...base, monthlyLimit: 200, mealCap: 25, spentThisMonth: 115, meal: "dinner" });
    expect(r.base).toBeCloseTo(9.44, 2);
    expect(r.target).toBeCloseTo(11.33, 2);
    expect(r.hardMax).toBe(15);
  });

  test("remaining ≤ 0 gives target $8 and hard max $10", () => {
    const r = computeBudget({ ...base, spentThisMonth: 260, meal: "dinner" });
    expect(r.target).toBe(8);
    expect(r.hardMax).toBe(10);
  });

  test("target never exceeds meal_cap", () => {
    const r = computeBudget({ ...base, spentThisMonth: 0, monthlyLimit: 2000, meal: "dinner" });
    expect(r.target).toBe(20);
    expect(r.hardMax).toBe(20);
  });

  test("treat override goes above meal_cap for that meal", () => {
    const r = computeBudget({ ...base, meal: "dinner", override: { kind: "treat", amount: 40 } });
    expect(r.hardMax).toBe(40);
  });

  test("cheap override only lowers the max", () => {
    const r = computeBudget({ ...base, meal: "dinner", override: { kind: "cheap", amount: 10 } });
    expect(r.hardMax).toBe(10);
    expect(r.target).toBe(10);
  });

  test("last day of the month still has at least one meal", () => {
    const r = computeBudget({ ...base, dayOfMonth: 31, meal: "dinner" });
    expect(r.mealsLeft).toBe(1);
  });

  test("without a bank connection the stated max is the hard max", () => {
    expect(computeBudgetWithoutBank(20).hardMax).toBe(20);
    expect(computeBudgetWithoutBank(20, { kind: "treat", amount: 35 }).hardMax).toBe(35);
  });
});

describe("setup proposal", () => {
  const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
  // Ronald's demo history: 39 meals over Jul–Sep totalling $720.
  const history: Purchase[] = [];
  const months = [7, 8, 9];
  let i = 0;
  for (const m of months) {
    for (let k = 0; k < 13; k++) {
      history.push({ amount: i % 13 < 4 ? 19.5 : 18, date: d(2026, m, 1 + k * 2) });
      i++;
    }
  }

  test("history totals as designed", () => {
    expect(history.length).toBe(39);
    expect(history.reduce((s, p) => s + p.amount, 0)).toBe(720);
  });

  test("average $240 a month and a $20 meal cap", () => {
    expect(proposeLimits(history, { year: 2026, month: 10 })).toEqual({ monthlyLimit: 240, mealCap: 20 });
  });

  test("ignores the current month and anything older than three months", () => {
    const extra = [...history, { amount: 500, date: d(2026, 10, 3) }, { amount: 500, date: d(2026, 6, 3) }];
    expect(proposeLimits(extra, { year: 2026, month: 10 })).toEqual({ monthlyLimit: 240, mealCap: 20 });
  });

  test("no history gives no proposal", () => {
    expect(proposeLimits([], { year: 2026, month: 10 })).toBeNull();
  });

  test("meals per week from history, default 3", () => {
    expect(mealsPerWeekFromHistory(history, { year: 2026, month: 10 })).toBe(3);
    expect(mealsPerWeekFromHistory([], { year: 2026, month: 10 })).toBe(3);
  });

  test("January looks back into the previous year", () => {
    const dec = [{ amount: 30, date: d(2025, 12, 5) }];
    expect(proposeLimits(dec, { year: 2026, month: 1 })).toEqual({ monthlyLimit: 10, mealCap: 30 });
  });
});
