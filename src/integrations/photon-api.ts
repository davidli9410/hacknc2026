// Spectrum management API (https://spectrum.photon.codes, Basic auth with project credentials).
import { config, hasPhoton } from "../config.ts";

const BASE = "https://spectrum.photon.codes";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const auth = Buffer.from(`${config.photon.projectId}:${config.photon.projectSecret}`).toString("base64");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { succeed?: boolean; data?: T; message?: string };
  if (!res.ok || json.succeed === false) throw new Error(`Spectrum ${method} ${path} ${res.status}: ${json.message ?? ""}`);
  return json.data as T;
}

export type ImessageTokens =
  | { type: "shared"; token: string; expiresIn: number }
  | { type: "dedicated"; auth: Record<string, string>; numbers: Record<string, string>; expiresIn: number };

export const issueImessageTokens = () => call<ImessageTokens>("POST", `/projects/${config.photon.projectId}/imessage/tokens`);

export const imessageInfo = () => call<{ type: "shared" | "dedicated" }>("GET", `/projects/${config.photon.projectId}/imessage/`);

/** Shared-pool user: the server assigns this phone a Foodie line. Idempotent on phone number. */
export const createSharedUser = (phoneNumber: string, firstName?: string) =>
  call<{ id: string; assignedPhoneNumber?: string }>("POST", `/projects/${config.photon.projectId}/users/`, {
    type: "shared",
    phoneNumber,
    firstName: firstName ?? null,
  });

/** Best dedicated line for a new user (Business plan). */
export const routeNewUser = () => call<{ line: { phoneNumber: string; status: string } }>("GET", `/projects/${config.photon.projectId}/lines/route`);

/** Public redirect that opens Messages to the user's assigned line with a prefilled body. */
export function userRedirectUrl(userId: string, msg: string): string {
  return `${BASE}/users/${userId}/redirect?${new URLSearchParams({ msg }).toString()}`;
}

let cachedInfo: { type: "shared" | "dedicated" } | null = null;
export async function lineModel(): Promise<"shared" | "dedicated" | null> {
  if (!hasPhoton()) return null;
  if (cachedInfo) return cachedInfo.type;
  try {
    cachedInfo = await imessageInfo();
    return cachedInfo.type;
  } catch (e) {
    console.warn("[photon] could not read line model:", (e as Error).message);
    return null;
  }
}
