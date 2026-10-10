// DEMO=1 seed (spec section 11): Ronald and Clive are set up; Eric starts with nothing.
import { sql } from "drizzle-orm";
import { now } from "../clock.ts";
import { config, hasPhoton } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { bank, type Bank } from "../integrations/nessie.ts";
import { addMinutes, zonedParts } from "../lib/time.ts";
import { DEMO_PLACES, DEMO_TASTE, memberPurchases, organizerPurchases, type DemoKey } from "./data.ts";

export type DemoChannel = "imessage" | "terminal" | "sim";

export function demoHandles(key: DemoKey): string[] {
  const idx = { organizer: 0, member: 1, newcomer: 2 }[key];
  const name = config.demoNames[key].toLowerCase();
  const phone = config.demoPhones[idx];
  return [phone, `term:${name}`, `sim:${name}`].filter((h): h is string => Boolean(h));
}

export function defaultDemoChannel(): DemoChannel {
  return hasPhoton() && config.demoPhones.length >= 3 ? "imessage" : "terminal";
}

function spaceFor(key: DemoKey, channel: DemoChannel): string {
  const name = config.demoNames[key].toLowerCase();
  if (channel === "imessage") return `any;-;${config.demoPhones[{ organizer: 0, member: 1, newcomer: 2 }[key]]}`;
  return name;
}

const TABLES = [
  "agent_messages",
  "sent_messages",
  "split_shares",
  "splits",
  "crew_history",
  "overrides",
  "vetoes",
  "taste",
  "place_memory",
  "jobs",
  "pending",
  "polls",
  "invites",
  "plan_members",
  "plans",
  "crews",
  "contacts",
  "users",
];

export async function wipe(): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY`));
}

async function seedBankFor(b: Bank, first: string, purchases: { amount: number; date: string; placeId: string }[]) {
  const customer = await b.createCustomer(first, "Demo");
  const account = await b.createAccount(customer.id, `${first}'s checking`, 2000);
  const merchants = new Map<string, string>();
  for (const p of DEMO_PLACES) {
    const m = await b.createMerchant(p.name, ["Food", "Restaurant"], p.lat, p.lng);
    merchants.set(p.placeId, m.id);
  }
  for (const p of purchases) await b.createPurchase(account.id, merchants.get(p.placeId)!, p.amount, p.date, `Meal at ${p.placeId.replace("demo-", "")}`);
  return { customerId: customer.id, accountId: account.id };
}

/** Real Nessie keeps data between resets, so bank seeds are created once and reused. */
async function demoBank(year: number, month: number) {
  const b = bank();
  const key = `demo_nessie_${year}_${month}`;
  if (b.real) {
    const row = await db.query.settings.findFirst({ where: (s, { eq }) => eq(s.key, key) });
    if (row?.value) return row.value as Record<"organizer" | "member", { customerId: string; accountId: string }>;
  }
  const ids = {
    organizer: await seedBankFor(b, config.demoNames.organizer, organizerPurchases(year, month)),
    member: await seedBankFor(b, config.demoNames.member, memberPurchases(year, month)),
  };
  if (b.real) await db.insert(schema.settings).values({ key, value: ids }).onConflictDoUpdate({ target: schema.settings.key, set: { value: ids } });
  return ids;
}

export async function seedDemo(channel: DemoChannel = defaultDemoChannel()): Promise<void> {
  await wipe();
  const p = zonedParts(now(), config.timezone);
  const banks = await demoBank(p.year, p.month);
  const organizerId = "demo-organizer";
  const memberId = "demo-member";

  await db.insert(schema.users).values([
    {
      id: organizerId,
      name: config.demoNames.organizer,
      handles: demoHandles("organizer"),
      channel,
      spaceId: spaceFor("organizer", channel),
      dietTags: ["vegetarian"],
      monthlyLimit: 240,
      mealCap: 20,
      mealsPerWeek: 3,
      nessieCustomerId: banks.organizer.customerId,
      nessieAccountId: banks.organizer.accountId,
      onboarding: "done",
      demoKey: "organizer",
    },
    {
      id: memberId,
      name: config.demoNames.member,
      handles: demoHandles("member"),
      channel,
      spaceId: spaceFor("member", channel),
      monthlyLimit: 200,
      mealCap: 25,
      mealsPerWeek: 3,
      nessieCustomerId: banks.member.customerId,
      nessieAccountId: banks.member.accountId,
      onboarding: "done",
      demoKey: "member",
    },
  ]);

  await db.insert(schema.contacts).values([
    { ownerId: organizerId, name: config.demoNames.member, handles: demoHandles("member"), foodieUserId: memberId },
    { ownerId: organizerId, name: config.demoNames.newcomer, handles: demoHandles("newcomer") },
    { ownerId: memberId, name: config.demoNames.organizer, handles: demoHandles("organizer"), foodieUserId: organizerId },
  ]);

  const tasteRows = (Object.entries(DEMO_TASTE) as [DemoKey, Record<string, number>][]).flatMap(([key, scores]) =>
    key === "newcomer" ? [] : Object.entries(scores).map(([cuisine, score]) => ({ userId: key === "organizer" ? organizerId : memberId, cuisine: cuisine.toLowerCase(), score })),
  );
  await db.insert(schema.taste).values(tasteRows);

  // Ronald loved the burrito place.
  await db.insert(schema.placeMemory).values({
    userId: organizerId,
    placeId: "demo-burrito",
    name: "Burrito place",
    cuisine: "Burritos",
    visits: 3,
    lastVisit: addMinutes(now(), -9 * 24 * 60),
    rating: 1,
    ratedAt: addMinutes(now(), -9 * 24 * 60),
  });

  // Clive's soft veto on the ramen place near everyone. Nobody else ever hears about it.
  await db.insert(schema.vetoes).values({
    userId: memberId,
    scope: "place",
    target: "demo-ramen",
    label: "the ramen house",
    kind: "soft",
    createdAt: addMinutes(now(), -2 * 24 * 60),
    expiresAt: addMinutes(now(), 28 * 24 * 60),
  });
}
