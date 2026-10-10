// Small formatting helpers for Foodie's messages.

export const dollars = (n: number) => `$${Math.round(n)}`;
export const cents = (c: number) => `$${(c / 100).toFixed(2)}`;

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const travelLabel = (min: number, mode: "walk" | "drive") => `${min} min ${mode}`;

export const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "the burrito place" → "The burrito place" at the start of a sentence. */
export const sentenceStart = capitalize;
