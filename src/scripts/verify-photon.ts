// Section 13: live checks against this Photon project. Run with your phone as the test recipient:
//   VERIFY_TO=+15551234567 bun run verify:photon
// It sends a text, a poll and a Find My card to VERIFY_TO, and reports what the plan supports.
import { Spectrum, poll } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createGrpcClient } from "@photon-ai/advanced-imessage";
import { config, hasPhoton } from "../config.ts";
import { createSharedUser, imessageInfo, issueImessageTokens, routeNewUser, userRedirectUrl } from "../integrations/photon-api.ts";

const to = process.env.VERIFY_TO;
if (!hasPhoton()) {
  console.error("Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET first.");
  process.exit(1);
}

const results: Record<string, string> = {};
const record = (k: string, v: string) => {
  results[k] = v;
  console.log(`${k}: ${v}`);
};

const info = await imessageInfo();
record("line model", info.type);
record("group chats", info.type === "dedicated" ? "supported (dedicated line)" : "not supported on shared-pool lines; DMs only");

const tokens = await issueImessageTokens();
record("line tokens", `issued (${tokens.type}, ttl ${tokens.expiresIn}s)`);

if (info.type === "shared") {
  try {
    const u = await createSharedUser(to ?? "+15555550100", "Verify");
    record("newcomer routing", `POST /users (shared) → line ${u.assignedPhoneNumber}; invite redirect ${userRedirectUrl(u.id, "Hi Foodie")}`);
  } catch (e) {
    record("newcomer routing", `failed: ${(e as Error).message}`);
  }
} else {
  try {
    const r = await routeNewUser();
    record("newcomer routing", `GET /lines/route → ${r.line.phoneNumber}`);
  } catch (e) {
    record("newcomer routing", `failed: ${(e as Error).message}`);
  }
}

if (to) {
  const app = await Spectrum({ projectId: config.photon.projectId!, projectSecret: config.photon.projectSecret!, providers: [imessage.config()] });
  const im = imessage(app) as unknown as {
    user(id: string): Promise<unknown>;
    space: { create(u: unknown): Promise<{ id: string; send: (c: unknown) => Promise<{ id: string } | undefined> }> };
  };
  const space = await im.space.create(await im.user(to));
  record("DM chat", space.id);
  const t = await space.send("Foodie setup check: you can ignore this.");
  record("text in DM", t ? `sent (${t.id})` : "not sent");
  try {
    const p = await space.send(poll("Foodie check: polls work?", "Yes", "No"));
    record("poll in DM", p ? `sent (${p.id})` : "not supported (resolved undefined)");
  } catch (e) {
    record("poll in DM", `failed: ${(e as Error).message}`);
  }
  try {
    const address = info.type === "shared" ? (process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443") : null;
    const fresh = await issueImessageTokens();
    const client =
      fresh.type === "shared"
        ? createGrpcClient({ address: address!, token: fresh.token, tls: true })
        : createGrpcClient({ address: `${Object.keys(fresh.auth)[0]}.imsg.photon.codes:443`, token: Object.values(fresh.auth)[0]!, tls: true });
    const receipt = await client.locations.request(space.id, to);
    record("Find My card", `${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`);
    await client.close();
  } catch (e) {
    record("Find My card", `failed: ${(e as Error).message}`);
  }
  console.log("\nNow reply to the DM from your phone and run `bun start` to see how your sender id arrives (phone or email).");
  await app.stop();
}

console.log("\nCopy these results into DECISIONS.md under 'Section 13 results'.");
console.log(JSON.stringify(results, null, 2));
process.exit(0);
