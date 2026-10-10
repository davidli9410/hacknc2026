// Budget engine (spec section 7). Pure functions; no I/O.

export type MealKind = "lunch" | "dinner";

export const MEAL_WEIGHT: Record<MealKind, number> = { lunch: 0.8, dinner: 1.2 };
export const TARGET_FLOOR = 8;
export const DEFAULT_MEALS_PER_WEEK = 3;

export type Override = { kind: "treat" | "cheap"; amount: number };

export type BudgetInput = {
  monthlyLimit: number;
  mealCap: number;
  spentThisMonth: number;
  mealsPerWeek: number;
  dayOfMonth: number;
  daysInMonth: number;
  meal: MealKind;
  override?: Override | null;
};

export type BudgetResult = {
  remaining: number;
  weeksLeft: number;
  mealsLeft: number;
  base: number;
  target: number;
  hardMax: number;
};

export function computeBudget(input: BudgetInput): BudgetResult {
  const remaining = input.monthlyLimit - input.spentThisMonth;
  const weeksLeft = (input.daysInMonth - input.dayOfMonth) / 7;
  const mealsLeft = Math.max(1, input.mealsPerWeek * weeksLeft);
  const base = remaining / mealsLeft;
  const weighted = remaining <= 0 ? TARGET_FLOOR : base * MEAL_WEIGHT[input.meal];
  let target = Math.min(input.mealCap, Math.max(TARGET_FLOOR, weighted));
  let hardMax = Math.min(input.mealCap, Math.round(target * 1.3));

  if (input.override?.kind === "treat") {
    // A treat night may go above meal_cap; it still counts against the month once spent.
    target = input.override.amount;
    hardMax = input.override.amount;
  } else if (input.override?.kind === "cheap") {
    target = Math.min(target, input.override.amount);
    hardMax = Math.min(hardMax, input.override.amount);
  }
  return { remaining, weeksLeft, mealsLeft, base, target, hardMax };
}

/** Budget for someone without a bank connection: their stated max is the hard max. */
export function computeBudgetWithoutBank(mealCap: number, override?: Override | null): BudgetResult {
  let hardMax = mealCap;
  if (override?.kind === "treat") hardMax = override.amount;
  else if (override?.kind === "cheap") hardMax = Math.min(hardMax, override.amount);
  return { remaining: NaN, weeksLeft: NaN, mealsLeft: NaN, base: NaN, target: hardMax, hardMax };
}

export type Purchase = { amount: number; date: Date };

/**
 * Setup proposal: monthly_limit is the average monthly restaurant spend over the three full months before
 * `now` (rounded to $10); meal_cap is the 90th-percentile meal (nearest rank), rounded up to $5.
 * Returns null when there is no history to base it on.
 */
export function proposeLimits(
  purchases: Purchase[],
  now: { year: number; month: number },
): { monthlyLimit: number; mealCap: number } | null {
  const window = previousMonths(now, 3);
  const inWindow = purchases.filter((p) => window.some((w) => sameMonth(p.date, w)));
  if (inWindow.length === 0) return null;
  const total = inWindow.reduce((s, p) => s + p.amount, 0);
  const monthlyLimit = Math.round(total / 3 / 10) * 10;
  const sorted = inWindow.map((p) => p.amount).sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * sorted.length);
  const p90 = sorted[rank - 1] ?? sorted[sorted.length - 1]!;
  const mealCap = Math.ceil(p90 / 5) * 5;
  return { monthlyLimit, mealCap };
}

/** Usual meals out per week over the last three full months, to the nearest half; default 3 with too little history. */
export function mealsPerWeekFromHistory(purchases: Purchase[], now: { year: number; month: number }): number {
  const window = previousMonths(now, 3);
  const count = purchases.filter((p) => window.some((w) => sameMonth(p.date, w))).length;
  if (count < 6) return DEFAULT_MEALS_PER_WEEK;
  const days = window.reduce((s, w) => s + new Date(Date.UTC(w.year, w.month, 0)).getUTCDate(), 0);
  const perWeek = count / (days / 7);
  return Math.max(1, Math.round(perWeek * 2) / 2);
}

function previousMonths(now: { year: number; month: number }, n: number): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  let y = now.year;
  let m = now.month;
  for (let i = 0; i < n; i++) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    out.push({ year: y, month: m });
  }
  return out;
}

// Purchase dates are calendar dates (Nessie stores YYYY-MM-DD), kept as UTC midnight.
function sameMonth(date: Date, ym: { year: number; month: number }): boolean {
  return date.getUTCFullYear() === ym.year && date.getUTCMonth() + 1 === ym.month;
}
