// Routes API computeRouteMatrix: walking and traffic-aware driving times from one origin to many places.
import { routesDepartureTime } from "../clock.ts";
import { config, hasMaps } from "../config.ts";
import { DEMO_TRAVEL, type DemoKey } from "../demo/data.ts";
import { distanceKm } from "./places.ts";

export type Travel = { walkMin: number | null; driveMin: number | null };
type Point = { lat: number; lng: number };
type Dest = Point & { placeId: string };

/** Straight-line estimate, used only when the API can't answer. */
export function estimateTravel(a: Point, b: Point): Travel {
  const km = distanceKm(a, b);
  return { walkMin: Math.round((km * 1.3) / 5 * 60), driveMin: Math.max(3, Math.round((km * 1.3) / 35 * 60 + 3)) };
}

/**
 * Travel times from `origin` to each destination, departing at `departure`.
 * In demo mode, seeded people get the fixed table so timings are repeatable.
 */
export async function travelTimes(origin: Point, dests: Dest[], departure: Date, demoKey?: string | null): Promise<Map<string, Travel>> {
  const out = new Map<string, Travel>();
  if (config.demo && demoKey && demoKey in DEMO_TRAVEL) {
    const table = DEMO_TRAVEL[demoKey as DemoKey];
    for (const d of dests) {
      const row = table[d.placeId];
      out.set(d.placeId, row ? { walkMin: row[0], driveMin: row[1] } : estimateTravel(origin, d));
    }
    return out;
  }
  if (!hasMaps() || dests.length === 0) {
    for (const d of dests) out.set(d.placeId, estimateTravel(origin, d));
    return out;
  }
  const [walk, drive] = await Promise.all([
    matrix(origin, dests, "WALK", departure).catch((e) => (console.warn("[routes] walk:", e.message), null)),
    matrix(origin, dests, "DRIVE", departure).catch((e) => (console.warn("[routes] drive:", e.message), null)),
  ]);
  dests.forEach((d, i) => {
    const est = estimateTravel(origin, d);
    out.set(d.placeId, { walkMin: walk?.[i] ?? est.walkMin, driveMin: drive?.[i] ?? est.driveMin });
  });
  return out;
}

async function matrix(origin: Point, dests: Dest[], mode: "WALK" | "DRIVE", departure: Date): Promise<(number | null)[]> {
  const body: Record<string, unknown> = {
    origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
    destinations: dests.map((d) => ({ waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } } })),
    travelMode: mode,
  };
  if (mode === "DRIVE") {
    body.routingPreference = "TRAFFIC_AWARE";
    body.departureTime = routesDepartureTime(departure).toISOString();
  }
  const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.google.mapsKey!,
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`computeRouteMatrix ${mode} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = (await res.json()) as { destinationIndex?: number; duration?: string; condition?: string }[];
  const out: (number | null)[] = dests.map(() => null);
  for (const r of rows) {
    if (r.condition !== "ROUTE_EXISTS" || !r.duration) continue;
    const secs = Number(r.duration.replace(/s$/, ""));
    out[r.destinationIndex ?? 0] = Math.max(1, Math.round(secs / 60));
  }
  return out;
}
