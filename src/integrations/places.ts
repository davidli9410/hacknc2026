// Places API (New): nearby search, text search (for "where are you coming from?"), opening hours, price.
import { config, hasMaps } from "../config.ts";
import { DEMO_PLACES } from "../demo/data.ts";
import { zonedParts } from "../lib/time.ts";

export type OpeningPoint = { day: number; hour: number; minute: number };
export type OpeningPeriod = { open: OpeningPoint; close?: OpeningPoint };

export type Place = {
  placeId: string;
  name: string;
  refName: string;
  shortName: string;
  lat: number;
  lng: number;
  priceEach: number;
  cuisine: string;
  primaryType: string;
  types: string[];
  servesVegetarianFood?: boolean;
  /** light | filling, when known */
  tags: string[];
  /** null when hours are unknown (treated as open). */
  periods: OpeningPeriod[] | null;
  mapsUrl: string;
  bookingUrl: string;
};

/** Spec section 10: estimate from price level when there's no price range. */
export const PRICE_LEVEL_ESTIMATE: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 12,
  PRICE_LEVEL_MODERATE: 22,
  PRICE_LEVEL_EXPENSIVE: 40,
  PRICE_LEVEL_VERY_EXPENSIVE: 70,
};
const UNKNOWN_PRICE = 22;

const CUISINE_BY_TYPE: Record<string, string> = {
  thai_restaurant: "Thai",
  pizza_restaurant: "Pizza",
  mexican_restaurant: "Mexican",
  ramen_restaurant: "Ramen",
  sushi_restaurant: "Sushi",
  japanese_restaurant: "Japanese",
  chinese_restaurant: "Chinese",
  korean_restaurant: "Korean",
  vietnamese_restaurant: "Vietnamese",
  indian_restaurant: "Indian",
  italian_restaurant: "Italian",
  american_restaurant: "American",
  hamburger_restaurant: "Burgers",
  steak_house: "Steak",
  seafood_restaurant: "Seafood",
  mediterranean_restaurant: "Mediterranean",
  middle_eastern_restaurant: "Middle Eastern",
  greek_restaurant: "Greek",
  french_restaurant: "French",
  barbecue_restaurant: "Barbecue",
  vegan_restaurant: "Vegan",
  vegetarian_restaurant: "Vegetarian",
  sandwich_shop: "Sandwiches",
  breakfast_restaurant: "Breakfast",
  brunch_restaurant: "Brunch",
  cafe: "Cafe",
  bakery: "Bakery",
  fast_food_restaurant: "Fast food",
  spanish_restaurant: "Spanish",
  turkish_restaurant: "Turkish",
  lebanese_restaurant: "Lebanese",
  african_restaurant: "African",
  brazilian_restaurant: "Brazilian",
  indonesian_restaurant: "Indonesian",
  chicken_restaurant: "Chicken",
  salad_shop: "Salad",
};

const LIGHT_TYPES = new Set(["cafe", "bakery", "salad_shop", "sandwich_shop", "juice_shop", "dessert_shop", "ice_cream_shop", "coffee_shop", "tea_house"]);

export function cuisineFor(primaryType: string | undefined, types: string[]): string {
  for (const t of [primaryType, ...types]) if (t && CUISINE_BY_TYPE[t]) return CUISINE_BY_TYPE[t]!;
  return "Restaurant";
}

export function mapsDirectionsUrl(p: { lat: number; lng: number; placeId: string; name: string }, mode: "walk" | "drive"): string {
  const params = new URLSearchParams({
    api: "1",
    destination: `${p.lat},${p.lng}`,
    travelmode: mode === "walk" ? "walking" : "driving",
  });
  if (!p.placeId.startsWith("demo-")) params.set("destination_place_id", p.placeId);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** True when the place is open for the whole of [from, to]. Unknown hours count as open. */
export function isOpenBetween(periods: OpeningPeriod[] | null, from: Date, to: Date, tz = config.timezone): boolean {
  if (!periods || periods.length === 0) return true;
  const WEEK = 7 * 24 * 60;
  if (periods.length === 1 && !periods[0]!.close) return true; // open 24/7
  const toMin = (p: OpeningPoint) => p.day * 24 * 60 + p.hour * 60 + p.minute;
  const intervals: [number, number][] = [];
  for (const p of periods) {
    if (!p.close) continue;
    const start = toMin(p.open);
    let end = toMin(p.close);
    if (end <= start) end += WEEK;
    intervals.push([start, end], [start + WEEK, end + WEEK]);
  }
  const fp = zonedParts(from, tz);
  const start = fp.weekday * 24 * 60 + fp.hour * 60 + fp.minute;
  const span = Math.round((to.getTime() - from.getTime()) / 60_000);
  return intervals.some(([a, b]) => a <= start && start + span <= b);
}

// ---------------------------------------------------------------------------------------------

type ApiPlace = {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  priceLevel?: string;
  priceRange?: { startPrice?: { units?: string }; endPrice?: { units?: string } };
  primaryType?: string;
  types?: string[];
  regularOpeningHours?: { periods?: OpeningPeriod[] };
  servesVegetarianFood?: boolean;
  googleMapsUri?: string;
  websiteUri?: string;
  reservable?: boolean;
};

const FIELDS = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.priceLevel",
  "places.priceRange",
  "places.primaryType",
  "places.types",
  "places.regularOpeningHours.periods",
  "places.servesVegetarianFood",
  "places.googleMapsUri",
  "places.websiteUri",
  "places.reservable",
].join(",");

function priceOf(p: ApiPlace): number {
  const lo = Number(p.priceRange?.startPrice?.units);
  const hi = Number(p.priceRange?.endPrice?.units);
  if (Number.isFinite(lo) && lo > 0 && Number.isFinite(hi) && hi > 0) return Math.round((lo + hi) / 2);
  if (Number.isFinite(lo) && lo > 0) return lo;
  if (p.priceLevel && p.priceLevel in PRICE_LEVEL_ESTIMATE) return PRICE_LEVEL_ESTIMATE[p.priceLevel]!;
  return UNKNOWN_PRICE;
}

function fromApi(p: ApiPlace): Place | null {
  if (!p.location || !p.displayName?.text) return null;
  const types = p.types ?? [];
  const name = p.displayName.text;
  return {
    placeId: p.id,
    name,
    refName: name,
    shortName: name,
    lat: p.location.latitude,
    lng: p.location.longitude,
    priceEach: priceOf(p),
    cuisine: cuisineFor(p.primaryType, types),
    primaryType: p.primaryType ?? "restaurant",
    types,
    servesVegetarianFood: p.servesVegetarianFood,
    tags: LIGHT_TYPES.has(p.primaryType ?? "") ? ["light"] : ["filling"],
    periods: p.regularOpeningHours?.periods ?? null,
    mapsUrl: p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${p.id}`,
    bookingUrl: p.websiteUri && p.reservable ? p.websiteUri : (p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${p.id}`),
  };
}

async function placesPost(path: string, body: unknown): Promise<ApiPlace[]> {
  const res = await fetch(`https://places.googleapis.com/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": config.google.mapsKey!, "X-Goog-FieldMask": FIELDS },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Places ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { places?: ApiPlace[] };
  return json.places ?? [];
}

const useDemo = () => config.demo || !hasMaps();

/** Restaurants near a point. */
export async function searchNearby(center: { lat: number; lng: number }, radiusM: number): Promise<Place[]> {
  if (useDemo()) return DEMO_PLACES.map((p) => ({ ...p }));
  const places = await placesPost("places:searchNearby", {
    includedTypes: ["restaurant"],
    maxResultCount: 20,
    rankPreference: "POPULARITY",
    locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: Math.min(50_000, radiusM) } },
  });
  return places.map(fromApi).filter((p): p is Place => p !== null);
}

/** "Where are you coming from?" → a point. Biased to DEMO_AREA. */
export async function geocode(text: string): Promise<{ lat: number; lng: number; label: string } | null> {
  if (useDemo()) {
    // Demo: any answer resolves to the middle of the demo area.
    return { lat: 35.9132, lng: -79.0558, label: text };
  }
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.google.mapsKey!,
      "X-Goog-FieldMask": "places.location,places.formattedAddress,places.displayName",
    },
    body: JSON.stringify({ textQuery: `${text}, ${config.demoArea}`, maxResultCount: 1 }),
  });
  if (!res.ok) throw new Error(`Places searchText ${res.status}`);
  const json = (await res.json()) as { places?: { location?: { latitude: number; longitude: number }; displayName?: { text: string } }[] };
  const p = json.places?.[0];
  if (!p?.location) return null;
  return { lat: p.location.latitude, lng: p.location.longitude, label: p.displayName?.text ?? text };
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
