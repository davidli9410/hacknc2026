// Intents (spec section 4) and the deterministic rules parser. Gemini handles free text when configured;
// these rules handle short replies, tapbacks and anything when Gemini is unavailable.

export type Mood = "light" | "filling";
export type Meal = "lunch" | "dinner";

export type Intent =
  | { type: "hungry_solo"; mood?: Mood }
  | { type: "plan_group"; names: string[]; when?: string; meal?: Meal }
  | { type: "choose"; n: number }
  | { type: "confirm"; yes: boolean }
  | { type: "availability"; freeAt?: { hour: number; minute: number }; unavailable?: boolean }
  | { type: "set_pref"; diet?: string[]; noRestrictions?: boolean; dislikes?: string[]; maxPerMeal?: number; mood?: Mood }
  | { type: "veto"; target: string; never: boolean }
  | { type: "budget_override"; kind: "treat" | "cheap"; amount?: number }
  | { type: "feedback"; sentiment: "positive" | "negative" | "neutral" }
  | { type: "what_do_you_know" }
  | { type: "forget"; target: string }
  | { type: "stop" }
  | { type: "start" }
  | { type: "booked" }
  | { type: "cant_book" }
  | { type: "paid" }
  | { type: "location"; text: string }
  | { type: "limits"; monthly?: number; perMeal?: number }
  | { type: "other" };

export const INTENT_TYPES = [
  "hungry_solo",
  "plan_group",
  "choose",
  "confirm",
  "availability",
  "set_pref",
  "veto",
  "budget_override",
  "feedback",
  "what_do_you_know",
  "forget",
  "stop",
  "other",
] as const;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9$:'.,\s\/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const YES = /^(y|ya|yes|yeah|yep|yup|sure|ok|okay|k|sounds good|do it|please|yes please|correct|right|definitely|absolutely|go|go ahead|send it|send|split it|perfect|👍)\.?!?$/;
const NO = /^(n|no|nope|nah|not really|no thanks|don't|dont|skip)\.?!?$/;

export function parseYesNo(text: string): boolean | null {
  const t = norm(text);
  if (YES.test(t)) return true;
  if (NO.test(t)) return false;
  return null;
}

export function parseNumberChoice(text: string, max: number): number | null {
  const t = norm(text).replace(/^(option|number|#)\s*/, "");
  const m = t.match(/^(\d)\.?$/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= max ? n : null;
  }
  const words: Record<string, number> = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3 };
  const w = words[t.replace(/^the /, "").replace(/ one$/, "")];
  return w && w <= max ? w : null;
}

export function parseMoney(text: string): number | null {
  const m = text.match(/\$\s?(\d+(?:\.\d{1,2})?)/) ?? text.match(/\b(\d{1,4}(?:\.\d{1,2})?)\s?(?:dollars|bucks)\b/i);
  return m ? Number(m[1]) : null;
}

/** "after 7", "free at 6:30", "6:20", "7pm" → 24h time. */
export function parseAvailability(text: string): { hour: number; minute: number } | null {
  const t = norm(text);
  const m = t.match(/(?:^|\b)(?:after|at|from|around|by|free at|free after|free by|out at|done at)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)\s*$/);
  if (!m) return null;
  const raw = m[1]!.replace(/\s+/g, "");
  const mm = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/);
  if (!mm) return null;
  let hour = Number(mm[1]);
  const minute = mm[2] ? Number(mm[2]) : 0;
  const mer = mm[3];
  if (hour > 23 || minute > 59) return null;
  if (mer?.startsWith("p") && hour < 12) hour += 12;
  else if (mer?.startsWith("a") && hour === 12) hour = 0;
  else if (!mer && hour >= 1 && hour <= 10) hour += 12;
  return { hour, minute };
}

const DIET_PATTERNS: [RegExp, string][] = [
  [/\bvegan\b/, "vegan"],
  [/\bvegetarian\b|\bveggie\b|\bno meat\b|\bdon'?t eat meat\b/, "vegetarian"],
  [/\bpescatarian\b/, "pescatarian"],
  [/\bno seafood\b|\bseafood\b|\bno fish\b/, "no seafood"],
  [/\bshellfish\b/, "no shellfish"],
  [/\bno pork\b|\bpork\b/, "no pork"],
  [/\bhalal\b/, "halal"],
  [/\bkosher\b/, "kosher"],
  [/\bgluten\b|\bceliac\b|\bcoeliac\b/, "gluten-free"],
  [/\bnut allergy\b|\bpeanut\b|\bnuts\b/, "nut allergy"],
  [/\bdairy\b|\blactose\b/, "no dairy"],
];

const NO_RESTRICTIONS = /^(nothing|none|nope|no|nah|i eat everything|everything|anything|no restrictions|i'?ll eat anything|nothing really|all good|n\/a)\.?!?$/;

/** Diet answer: tags, "nothing", and an optional max ("no seafood, $20"). */
export function parseDietAnswer(text: string): { diet: string[]; noRestrictions: boolean; maxPerMeal?: number } | null {
  const t = norm(text);
  const money = parseMoney(text) ?? undefined;
  const withoutMoney = t.replace(/\$\s?\d+(\.\d+)?/g, "").replace(/[,.\s]+$/g, "").trim();
  if (NO_RESTRICTIONS.test(withoutMoney) || withoutMoney === "") {
    return { diet: [], noRestrictions: true, maxPerMeal: money };
  }
  const diet = DIET_PATTERNS.filter(([re]) => re.test(withoutMoney)).map(([, tag]) => tag);
  if (diet.length > 0) return { diet: [...new Set(diet)], noRestrictions: false, maxPerMeal: money };
  // "no mushrooms", "allergic to sesame" → stored as said.
  const free = withoutMoney.match(/^(?:no|not|allergic to|can'?t eat|don'?t eat)\s+([a-z ]{2,30})$/);
  if (free) return { diet: [`no ${free[1]!.trim()}`], noRestrictions: false, maxPerMeal: money };
  return null;
}

/** Names in "dinner with Clive and Eric", "lunch w/ Sam, Ana & Bo". */
export function parseNames(fragment: string): string[] {
  return fragment
    .replace(/[.!?]+$/, "")
    .split(/\s*(?:,|&|\band\b|\bplus\b|\+)\s*/i)
    .map((s) => s.trim().replace(/^(?:with|w\/)\s+/i, ""))
    .filter((s) => s.length > 0 && s.length < 40)
    .map((s) => s.replace(/\b(tonight|today|tomorrow|for (?:lunch|dinner))\b/gi, "").trim())
    .filter(Boolean);
}

const LIKE_TAPBACKS = new Set(["❤️", "♥️", "❤", "👍", "😍", "🔥", "‼️", "😋", "🤤", "💯"]);
const DISLIKE_TAPBACKS = new Set(["👎", "🤮", "😕", "😞", "🙁", "😬"]);

export function tapbackSentiment(emoji: string): "positive" | "negative" | null {
  if (LIKE_TAPBACKS.has(emoji)) return "positive";
  if (DISLIKE_TAPBACKS.has(emoji)) return "negative";
  return null;
}

const POSITIVE = /\b(loved|love|great|amazing|awesome|delicious|good|so good|fantastic|excellent|perfect|yum|tasty|incredible|solid|nice)\b/;
const NEGATIVE = /\b(bad|terrible|awful|meh|gross|disappointing|mid|not good|wasn'?t good|hated|hate|never again|nasty|overrated|bland|cold)\b/;

export function parseSentiment(text: string): "positive" | "negative" | null {
  const t = norm(text);
  if (NEGATIVE.test(t)) return "negative";
  if (POSITIVE.test(t)) return "positive";
  return null;
}

/** Rules parser. Returns `other` when nothing matches. */
export function parseRules(text: string): Intent {
  const t = norm(text);

  if (/^(stop|pause|unsubscribe|leave me alone)\.?$/.test(t)) return { type: "stop" };
  if (/^(start|resume|unpause)\.?$/.test(t)) return { type: "start" };
  if (/what do you know( about me)?|what do you have on me|my data/.test(t)) return { type: "what_do_you_know" };
  const forget = t.match(/^forget(?: about)?(?: my| the)?\s+(.+)$/);
  if (forget) return { type: "forget", target: forget[1]!.trim() };

  if (/^(booked|done booked|it'?s booked|table'?s booked|got (it|the table|a table))\.?!?$/.test(t)) return { type: "booked" };
  if (/(can'?t|couldn'?t|could not|cannot|didn'?t) (book|get a table|reserve)|fully booked|no tables?|booking failed|they'?re closed|it'?s closed|closed/.test(t))
    return { type: "cant_book" };
  if (/^(paid|i paid|i paid already|already paid|paid it|sent it already)\.?!?$/.test(t)) return { type: "paid" };

  const yn = parseYesNo(t);
  if (yn !== null) return { type: "confirm", yes: yn };
  if (/^(i'?m )?in\.?!?$|^count me in|^i'?m down|^down\.?$/.test(t)) return { type: "confirm", yes: true };
  if (/^(can'?t|cant|i can'?t|can'?t make it|i'?m out|out|not tonight|pass|can'?t tonight)\.?!?$/.test(t)) return { type: "availability", unavailable: true };

  const n = parseNumberChoice(t, 9);
  if (n) return { type: "choose", n };

  const never = t.match(/^never\s+(?:again\s+)?(.+?)\.?$/);
  if (never) return { type: "veto", target: never[1]!, never: true };
  const not = t.match(/^(?:not|no more|anything but|not feeling)\s+(.+?)\.?$/);
  if (not) return { type: "veto", target: not[1]!, never: false };

  if (/treat (night|myself|yourself)|splurge|treat me/.test(t)) return { type: "budget_override", kind: "treat", amount: parseMoney(text) ?? undefined };
  if (/(cheap|broke|tight) (tonight|today)|keep it cheap|on a budget today|something cheap/.test(t))
    return { type: "budget_override", kind: "cheap", amount: parseMoney(text) ?? undefined };

  const group = t.match(/\b(dinner|lunch|food|eat|drinks|brunch)\b.*?\b(?:with|w\/)\s+(.+)$/);
  if (group) {
    const meal: Meal = /lunch|brunch/.test(group[1]!) ? "lunch" : "dinner";
    const when = /tomorrow/.test(t) ? "tomorrow" : /tonight|today/.test(t) ? "tonight" : undefined;
    const original = text.match(/\b(?:with|w\/)\s+(.+)$/i)?.[1] ?? group[2]!;
    return { type: "plan_group", names: parseNames(original), when, meal };
  }

  if (/\b(hungry|starving|famished|food|eat|grab a bite|lunch|dinner|snack)\b/.test(t) && !/\bwith\b/.test(t)) {
    const mood: Mood | undefined = /starving|famished|really hungry|so hungry|big meal|filling/.test(t)
      ? "filling"
      : /snack|light|something small|not that hungry|peckish/.test(t)
        ? "light"
        : undefined;
    return { type: "hungry_solo", mood };
  }

  if (/^(light|something light|small)\.?$/.test(t)) return { type: "set_pref", mood: "light" };
  if (/^(filling|something filling|big|hearty|heavy)\.?$/.test(t)) return { type: "set_pref", mood: "filling" };

  const avail = /^(after|free at|free after|free by|done at|out at|around)\b/.test(t) ? parseAvailability(t) : null;
  if (avail) return { type: "availability", freeAt: avail };

  const sentiment = parseSentiment(t);
  if (sentiment && t.split(" ").length <= 8) return { type: "feedback", sentiment };

  const diet = parseDietAnswer(t);
  if (diet && !diet.noRestrictions) return { type: "set_pref", diet: diet.diet, maxPerMeal: diet.maxPerMeal };

  const money = parseMoney(text);
  if (money !== null && t.replace(/\$\s?\d+(\.\d+)?/, "").trim().length < 25) return { type: "set_pref", maxPerMeal: money };

  return { type: "other" };
}
