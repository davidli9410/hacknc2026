// Deterministic demo world (spec section 11): restaurants, travel times, calendars, bank history.
// Timings match the section 8 table exactly.
import type { Place } from "../integrations/places.ts";

export type DemoKey = "organizer" | "member" | "newcomer";
export const DEMO_KEYS: DemoKey[] = ["organizer", "member", "newcomer"];

/** Private seeded locations. They override Find My in demo mode. */
export const DEMO_LOCATIONS: Record<DemoKey, { lat: number; lng: number }> = {
  organizer: { lat: 35.9101, lng: -79.0533 },
  member: { lat: 35.9405, lng: -79.0181 },
  newcomer: { lat: 35.8902, lng: -79.0812 },
};

const daily = (openH: number, openM: number, closeH: number, closeM: number) =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    open: { day, hour: openH, minute: openM },
    close: { day, hour: closeH, minute: closeM },
  }));

const place = (
  id: string,
  name: string,
  refName: string,
  shortName: string,
  cuisine: string,
  primaryType: string,
  priceEach: number,
  lat: number,
  lng: number,
  extra: Partial<Place> = {},
): Place => ({
  placeId: `demo-${id}`,
  name,
  refName,
  shortName,
  lat,
  lng,
  priceEach,
  cuisine,
  primaryType,
  types: [primaryType, "restaurant", "food"],
  servesVegetarianFood: true,
  tags: ["filling"],
  periods: daily(11, 0, 22, 0),
  mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} Chapel Hill NC`)}`,
  bookingUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} Chapel Hill NC reservations`)}`,
  ...extra,
});

export const DEMO_PLACES: Place[] = [
  place("thai", "Thai place", "the Thai place", "Thai", "Thai", "thai_restaurant", 14, 35.9265, -79.0302),
  place("pizza", "Pizza spot", "the pizza spot", "Pizza", "Pizza", "pizza_restaurant", 12, 35.9188, -79.0601),
  place("taqueria", "Taqueria", "the taqueria", "Taqueria", "Mexican", "mexican_restaurant", 11, 35.9320, -79.0250),
  place("ramen", "Ramen house", "the ramen house", "Ramen", "Ramen", "ramen_restaurant", 13, 35.9213, -79.0410),
  place("sushi", "Sushi bar", "the sushi bar", "Sushi", "Sushi", "sushi_restaurant", 15, 35.9150, -79.0480),
  place("steak", "Steakhouse", "the steakhouse", "Steak", "Steak", "steak_house", 32, 35.9230, -79.0450, { servesVegetarianFood: false }),
  place("burrito", "Burrito place", "the burrito place", "Burrito", "Burritos", "mexican_restaurant", 11, 35.9108, -79.0549),
  place("noodle", "Noodle bar", "the noodle bar", "Noodles", "Noodles", "chinese_restaurant", 13, 35.9119, -79.0570),
  place("falafel", "Falafel spot", "the falafel spot", "Falafel", "Middle Eastern", "middle_eastern_restaurant", 9, 35.9096, -79.0522),
  place("salad", "Salad bar", "the salad bar", "Salad", "Salad", "salad_shop", 10, 35.9093, -79.0541, { tags: ["light"] }),
];

/** [walk, drive] minutes from each person's seeded location. */
export const DEMO_TRAVEL: Record<DemoKey, Record<string, [number, number]>> = {
  organizer: {
    "demo-burrito": [6, 3],
    "demo-noodle": [9, 4],
    "demo-falafel": [4, 2],
    "demo-salad": [5, 2],
    "demo-thai": [95, 30],
    "demo-pizza": [80, 25],
    "demo-taqueria": [110, 35],
    "demo-ramen": [60, 20],
    "demo-sushi": [70, 22],
    "demo-steak": [65, 20],
  },
  member: {
    "demo-burrito": [120, 40],
    "demo-noodle": [120, 40],
    "demo-falafel": [120, 40],
    "demo-salad": [120, 40],
    "demo-thai": [40, 10],
    "demo-pizza": [50, 15],
    "demo-taqueria": [35, 10],
    "demo-ramen": [40, 12],
    "demo-sushi": [45, 14],
    "demo-steak": [50, 15],
  },
  newcomer: {
    "demo-burrito": [140, 45],
    "demo-noodle": [140, 45],
    "demo-falafel": [140, 45],
    "demo-salad": [140, 45],
    "demo-thai": [50, 15],
    "demo-pizza": [35, 10],
    "demo-taqueria": [65, 20],
    "demo-ramen": [50, 15],
    "demo-sushi": [40, 12],
    "demo-steak": [55, 18],
  },
};

/** Busy blocks on the demo date, local time [startH, startM, endH, endM]. */
export const DEMO_BUSY: Record<DemoKey, [number, number, number, number][]> = {
  organizer: [[13, 0, 18, 0]],
  member: [[15, 0, 18, 20]],
  newcomer: [[14, 0, 18, 0]],
};

/** Taste seeds. Thai's average fit across the three is 0.7. */
export const DEMO_TASTE: Record<DemoKey, Record<string, number>> = {
  organizer: { Thai: 0.6, Burritos: 0.4, Noodles: 0.4 },
  member: { Thai: 0.6 },
  newcomer: {},
};

/**
 * Ronald's bank history: 39 restaurant meals over the three months before the demo month totalling $720
 * (13 a month: four at $19.50, nine at $18), then $100 by day 10.
 */
export function organizerPurchases(year: number, month: number): { amount: number; date: string; placeId: string }[] {
  const out: { amount: number; date: string; placeId: string }[] = [];
  const spots = ["demo-burrito", "demo-noodle", "demo-falafel", "demo-thai", "demo-pizza", "demo-salad"];
  for (let back = 3; back >= 1; back--) {
    let y = year;
    let m = month - back;
    if (m <= 0) {
      m += 12;
      y -= 1;
    }
    for (let k = 0; k < 13; k++) {
      out.push({ amount: k < 4 ? 19.5 : 18, date: ymd(y, m, 1 + k * 2), placeId: spots[k % spots.length]! });
    }
  }
  [18, 15, 17, 16, 19, 15].forEach((amount, i) => out.push({ amount, date: ymd(year, month, 1 + i), placeId: spots[i % spots.length]! }));
  return out;
}

/** Clive's tighter month: $115 by day 10. */
export function memberPurchases(year: number, month: number): { amount: number; date: string; placeId: string }[] {
  return [20, 18, 22, 19, 17, 19].map((amount, i) => ({ amount, date: ymd(year, month, 2 + i), placeId: "demo-pizza" }));
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
