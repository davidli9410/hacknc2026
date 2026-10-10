// Find My through the Advanced iMessage kit: send the request card, read a shared location.
// Uses the same line credentials Spectrum mints (POST /projects/{id}/imessage/tokens).
import { createGrpcClient, type GrpcAdvancedIMessage } from "@photon-ai/advanced-imessage";
import { hasPhoton } from "../config.ts";
import type { User } from "../messaging.ts";
import { issueImessageTokens, type ImessageTokens } from "./photon-api.ts";

type LineClient = { phone: string | null; client: GrpcAdvancedIMessage };

let tokens: ImessageTokens | null = null;
let tokensAt = 0;
let clients: LineClient[] | null = null;

async function freshTokens(): Promise<ImessageTokens> {
  if (!tokens || Date.now() - tokensAt > tokens.expiresIn * 1000 * 0.8) {
    tokens = await issueImessageTokens();
    tokensAt = Date.now();
  }
  return tokens;
}

async function lineClients(): Promise<LineClient[]> {
  if (clients) return clients;
  const t = await freshTokens();
  if (t.type === "shared") {
    const address = process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";
    clients = [
      {
        phone: null,
        client: createGrpcClient({
          address,
          tls: true,
          retry: true,
          token: async () => {
            const cur = await freshTokens();
            return cur.type === "shared" ? cur.token : "";
          },
        }),
      },
    ];
  } else {
    clients = Object.entries(t.auth).map(([instanceId, initial]) => ({
      phone: t.numbers[instanceId] ?? null,
      client: createGrpcClient({
        address: `${instanceId}.imsg.photon.codes:443`,
        tls: true,
        retry: true,
        token: async () => {
          const cur = await freshTokens();
          return cur.type === "dedicated" ? (cur.auth[instanceId] ?? initial) : initial;
        },
      }),
    }));
  }
  return clients;
}

async function clientFor(user: User): Promise<GrpcAdvancedIMessage | null> {
  const all = await lineClients();
  return (all.find((c) => c.phone && c.phone === user.foodieLine) ?? all[0])?.client ?? null;
}

/** The address Find My knows this person by: their E.164 phone or Apple ID email. */
export function findMyAddress(user: User): string | null {
  return user.handles.find((h) => h.startsWith("+") || h.includes("@")) ?? null;
}

export const findMyAvailable = (user: User) => hasPhoton() && user.channel === "imessage" && Boolean(user.spaceId && findMyAddress(user));

/** Sends the visible Find My request card into the user's DM. */
export async function requestLocation(user: User): Promise<{ ok: boolean; error?: string }> {
  if (!findMyAvailable(user)) return { ok: false, error: "find my unavailable" };
  try {
    const client = await clientFor(user);
    if (!client) return { ok: false, error: "no line client" };
    const receipt = await client.locations.request(user.spaceId!, findMyAddress(user)!, { clientMessageId: `findmy-${user.id}-${Date.now()}` });
    return { ok: Boolean(receipt.messageGuid) || receipt.status !== "failed", error: receipt.reason };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Latest shared location, or null when not shared / no coordinates yet. */
export async function sharedLocation(user: User): Promise<{ lat: number; lng: number; at: Date } | null> {
  if (!findMyAvailable(user)) return null;
  try {
    const client = await clientFor(user);
    if (!client) return null;
    const loc = await client.locations.get(findMyAddress(user)!);
    if (loc.latitude === undefined || loc.longitude === undefined) return null;
    return { lat: loc.latitude, lng: loc.longitude, at: loc.locationTimestamp ? new Date(loc.locationTimestamp) : new Date() };
  } catch {
    return null;
  }
}
