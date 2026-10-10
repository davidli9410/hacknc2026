// The section 9 transcripts, played through the real router with the in-memory transport.
import { eq } from "drizzle-orm";
import { setClockTimeOfDay } from "../clock.ts";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { seedDemo } from "../demo/seed.ts";
import { findMyAnswer, linkDone } from "../flows/onboarding.ts";
import { bank, MemoryBank, setBankForTests } from "../integrations/nessie.ts";
import { Sim } from "./harness.ts";

export type Check = { scenario: string; who: string; expected: string[]; actual: string[]; ok: boolean };

export type Scenario = { name: string; run: (sim: Sim, expect: (who: string, expected: string[]) => void) => Promise<void> };

const N = () => ({
  ronald: config.demoNames.organizer.toLowerCase(),
  clive: config.demoNames.member.toLowerCase(),
  eric: config.demoNames.newcomer.toLowerCase(),
});

async function userFor(handle: string) {
  const all = await db.select().from(schema.users);
  return all.find((u) => u.handles.includes(handle))!;
}

async function fresh(): Promise<void> {
  setBankForTests(new MemoryBank());
  await seedDemo("sim");
}

const READY = `Text me when you're hungry, or say "dinner with" and some names.`;

export const scenarios: Scenario[] = [
  {
    name: "9.1 Setup",
    async run(sim, expect) {
      const { ronald } = N();
      await fresh();
      // Ronald is new: keep his bank history, drop his Foodie account.
      const seeded = await userFor(`sim:${ronald}`);
      await db.delete(schema.users).where(eq(schema.users.id, seeded.id));
      await setClockTimeOfDay(10, 0);

      await sim.say(ronald, "hey");
      expect(ronald, ["Hey, I'm Foodie. I find you places to eat and plan meals with friends. Anything you don't eat?"]);
      await sim.say(ronald, "vegetarian");
      expect(ronald, ["Got it. One tap to connect your calendar, contacts and bank: {link}"]);

      // The link page: Google sign-in (gives the name) and the Nessie picker.
      const u = await userFor(`sim:${ronald}`);
      await db
        .update(schema.users)
        .set({ name: "Ronald", nessieCustomerId: seeded.nessieCustomerId, nessieAccountId: seeded.nessieAccountId })
        .where(eq(schema.users.id, u.id));
      await linkDone(u.id);
      expect(ronald, ["Last step: accept the location card below and choose Share Indefinitely.", "[Find My request card]"]);

      await findMyAnswer(u.id, true);
      expect(ronald, ["All set, Ronald. You've averaged $240 a month eating out, usually under $20 a meal. Use those as your limits?"]);
      await sim.say(ronald, "yes");
      expect(ronald, [`Done. ${READY}`]);
    },
  },
  {
    name: "9.2 Solo",
    async run(sim, expect) {
      const { ronald } = N();
      await fresh();
      await sim.clock(12, 0);
      await sim.say(ronald, "I'm hungry");
      expect(ronald, ["You're free until 1:00 and at about $12 today. Light or filling?"]);
      await sim.say(ronald, "filling");
      expect(ronald, [
        [
          "1. Burrito place · 6 min walk · ~$11 · you loved it last time",
          "2. Noodle bar · 9 min walk · ~$13 · new, matches what you like",
          "3. Falafel spot · 4 min walk · ~$9",
        ].join("\n"),
      ]);
      await sim.say(ronald, "1");
      expect(ronald, ["Good call. Directions: {maps link}. You'll be back well before 1:00."]);
      await sim.advance(60);
      expect(ronald, ["How was the burrito place?"]);
      await sim.tapback(ronald, "❤️", sim.last(ronald)!.id);
      expect(ronald, []);
    },
  },
  {
    name: "9.2 Solo, mood already given",
    async run(sim, expect) {
      const { ronald } = N();
      await fresh();
      await sim.clock(12, 0);
      await sim.say(ronald, "I'm starving");
      expect(ronald, [
        [
          "You're free until 1:00 and at about $12 today:",
          "1. Burrito place · 6 min walk · ~$11 · you loved it last time",
          "2. Noodle bar · 9 min walk · ~$13 · new, matches what you like",
          "3. Falafel spot · 4 min walk · ~$9",
        ].join("\n"),
      ]);
    },
  },
  {
    name: "9.3–9.7 Group dinner",
    async run(sim, expect) {
      const { ronald, clive, eric } = N();
      await fresh();
      await sim.clock(17, 50);

      // 9.3 / 9.4
      await sim.say(ronald, "dinner tonight with Clive and Eric");
      expect(ronald, ["On it. Clive's on Foodie. Eric isn't yet, so send Eric this: {invite link}"]);
      expect(clive, ["Ronald's planning dinner tonight with you and Eric. You're free at 6:20, so I'm aiming for about 6:30. In?"]);
      await sim.say(clive, "in");
      expect(clive, []);
      expect(ronald, []);

      // 9.5: Eric taps the forwarded invite, which prefills a text with the plan code.
      const code = sim.find(ronald, /\/i\//)!.text.match(/\/i\/([A-Z0-9]{4})/)![1];
      await sim.say(eric, `Hi Foodie, I'm in for dinner with Ronald (code ${code})`);
      expect(eric, ["Hey Eric! Ronald's planning dinner tonight with you and Clive. Anything you don't eat?"]);
      await sim.say(eric, "no seafood");
      expect(eric, ["Got it. Tap to connect your calendar and set a max: {link}"]);
      const e = await userFor(`sim:${eric}`);
      await db.update(schema.users).set({ mealCap: 20 }).where(eq(schema.users.id, e.id)); // the link page's "Rough max per meal?"
      await linkDone(e.id);
      expect(eric, ["Last step: accept the location card and choose Share Indefinitely so I can plan around you.", "[Find My request card]"]);
      await findMyAnswer(e.id, true);

      expect(ronald, [
        ["Everyone's in:", "Thai place · 6:30 · ~$14 · 30 min drive", "Pizza spot · 6:35 · ~$12 · 25 min", "Taqueria · 6:35 · ~$11 · 35 min"].join("\n"),
        "[poll: Thai / Pizza / Taqueria]",
      ]);
      expect(clive, ["Kept it under $15 for you. Vote:", "[poll: Thai · 10 min / Pizza · 15 min / Taqueria · 10 min]"]);
      expect(eric, ["You're set and free at 6:00. Vote:", "[poll: Thai · 15 min / Pizza · 10 min / Taqueria · 20 min]"]);

      await sim.vote(ronald, "Thai");
      await sim.vote(clive, "Thai · 10 min");
      await sim.vote(eric, "Thai · 15 min");
      expect(ronald, ["Thai at 6:30 it is. Tap to book a table for 3: {booking link}. Booked?"]);
      expect(clive, ["Thai at 6:30. Leave at 6:20, it's on your calendar."]);
      expect(eric, ["Thai at 6:30. Leave at 6:15, it's on your calendar."]);

      await sim.say(ronald, "booked");
      expect(ronald, ["Nice, I told Clive and Eric. Leave at 6:00, it's on your calendar."]);
      expect(clive, ["Table's booked under Ronald."]);
      expect(eric, ["Table's booked under Ronald."]);

      // 9.6
      await sim.say(ronald, "/late clive 8");
      expect(ronald, ["Clive's about 8 min behind, now 6:38."]);
      expect(eric, ["Clive's about 8 min behind, now 6:38."]);
      expect(clive, []);

      // 9.7
      await sim.clock(20, 0);
      expect(ronald, ["How was the Thai place?"]);
      expect(clive, ["How was the Thai place?"]);
      expect(eric, ["How was the Thai place?"]);
      await sim.tapback(clive, "👍", sim.last(clive)!.id);
      await sim.say(ronald, "/paid 52");
      expect(ronald, ["Saw $52 at the Thai place. Split 3 ways, $17.33 each?"]);
      await sim.say(ronald, "yes");
      expect(ronald, ["[reacted 👍]"]);
      expect(clive, ["Ronald covered dinner, your share is $17.33. Send it?"]);
      expect(eric, ["Ronald covered dinner, your share is $17.33. Paid another way? Reply 'paid'."]);
      await sim.say(clive, "yes");
      expect(clive, ["Sent."]);
      expect(ronald, ["Clive sent you $17.33."]);
      await sim.say(eric, "paid");
      expect(eric, ["Thanks, I'll let Ronald know."]);
      expect(ronald, ["Eric paid you back $17.33 another way."]);

      // The transfer really moved (sandbox) money.
      const b = bank() as MemoryBank;
      if (b.transfers.length !== 1 || Math.abs(b.transfers[0]!.amount - 17.33) > 0.001) throw new Error("expected one $17.33 transfer");
    },
  },
  {
    name: "9.4 Invited member can't make it",
    async run(sim, expect) {
      const { ronald, clive } = N();
      await fresh();
      await sim.clock(17, 50);
      await sim.say(ronald, "dinner tonight with Clive");
      expect(ronald, ["On it. Clive's on Foodie, so I'm asking now."]);
      expect(clive, ["Ronald's planning dinner tonight with you. You're free at 6:20, so I'm aiming for about 6:30. In?"]);
      await sim.say(clive, "can't");
      expect(ronald, ["Clive can't make it.", "Nobody else can make it, so I called it off. Text me if you want somewhere for just you."]);
    },
  },
  {
    name: "9.4 Invited member is free later",
    async run(sim, expect) {
      const { ronald, clive } = N();
      await fresh();
      await sim.clock(17, 50);
      await sim.say(ronald, "dinner tonight with Clive");
      sim.take(ronald);
      sim.take(clive);
      await sim.say(clive, "after 7");
      const r = sim.take(ronald);
      const ok = r.length === 2 && r[0]!.startsWith("Everyone's in:") && r[0]!.split("\n").length === 4 && r[0]!.includes("· 7:");
      expect(ronald, ok ? [] : r);
      const c = sim.take(clive);
      expect(clive, c.length === 2 && c[0] === "Kept it under $15 for you. Vote:" ? [] : c);
    },
  },
  {
    name: "Go without, tie, runner-up, who paid",
    async run(sim, expect) {
      const { ronald, clive, eric } = N();
      await fresh();
      await sim.clock(17, 50);
      await sim.say(ronald, "dinner tonight with Clive and Eric");
      sim.take(ronald);
      sim.take(clive);
      await sim.say(clive, "in");

      // Eric never taps the invite.
      await sim.advance(15);
      expect(ronald, ["Still waiting on Eric. Go without Eric? yes/no"]);
      await sim.say(ronald, "yes");
      // Without Eric's no-seafood tag the sushi bar is back in play.
      expect(ronald, [
        ["Here's what works:", "Sushi bar · 6:35 · ~$15 · 22 min drive", "Pizza spot · 6:35 · ~$12 · 25 min", "Thai place · 6:40 · ~$14 · 30 min"].join("\n"),
        "[poll: Sushi / Pizza / Thai]",
      ]);
      expect(clive, ["Kept it under $15 for you. Vote:", "[poll: Sushi · 14 min / Pizza · 15 min / Thai · 10 min]"]);
      expect(eric, []);

      // A tie: everyone has voted, so it closes now and the organizer's vote breaks it.
      await sim.vote(ronald, "Pizza");
      expect(ronald, []);
      await sim.vote(clive, "Thai · 10 min");
      expect(ronald, ["Pizza at 6:35 it is. Tap to book a table for 2: {booking link}. Booked?"]);
      expect(clive, ["Pizza at 6:35. Leave at 6:20, it's on your calendar."]);

      // Booking fails: the runner-up goes to the organizer.
      await sim.say(ronald, "couldn't book it");
      expect(ronald, ["Sushi bar at 6:35 instead? yes/no"]);
      await sim.say(ronald, "yes");
      expect(clive, ["Change of plan: Sushi at 6:35. Leave at 6:21, it's on your calendar."]);
      expect(ronald, ["Sushi at 6:35 it is. Tap to book a table for 2: {booking link}. Booked?"]);
      await sim.say(ronald, "booked");
      expect(ronald, ["Nice, I told Clive. Leave at 6:13, it's on your calendar."]);
      expect(clive, ["Table's booked under Ronald."]);

      // No purchase shows up: Foodie asks who paid, then how much.
      await sim.clock(21, 0);
      expect(ronald, ["How was the sushi bar?", "Who paid?"]);
      expect(clive, ["How was the sushi bar?"]);
      await sim.say(ronald, "Clive");
      expect(clive, ["How much was dinner?"]);
      await sim.say(clive, "$40");
      expect(clive, ["Got it, $40. Split 2 ways, $20 each?"]);
      await sim.say(clive, "yes");
      expect(clive, ["[reacted 👍]"]);
      expect(ronald, ["Clive covered dinner, your share is $20. Send it?"]);
      await sim.say(ronald, "yes");
      expect(ronald, ["Sent."]);
      expect(clive, ["Ronald sent you $20."]);
    },
  },
  {
    name: "Memory and transparency",
    async run(sim, expect) {
      const { ronald } = N();
      await fresh();
      await sim.say(ronald, "what do you know about me?");
      expect(ronald, ["Here's what I know: vegetarian; $240 a month; under $20 a meal; you like burritos, noodles, thai; connected: bank.\nSay \"forget\" and a thing to delete it."]);
      await sim.say(ronald, "never sushi");
      expect(ronald, ["Got it, never sushi."]);
      await sim.say(ronald, "forget sushi");
      expect(ronald, ["Done, sushi is back on the table."]);
      await sim.say(ronald, "stop");
      expect(ronald, [`Paused. I won't watch your location or message you first. Text "start" to undo.`]);
      await sim.say(ronald, "start");
      expect(ronald, ["Welcome back. Text me when you're hungry."]);
    },
  },
];

/** Runs every scenario; returns each comparison. */
export async function runScenarios(echo: boolean, only?: string): Promise<Check[]> {
  const checks: Check[] = [];
  for (const s of scenarios) {
    if (only && !s.name.toLowerCase().includes(only.toLowerCase())) continue;
    const sim = new Sim(echo);
    if (echo) console.log(`\n── ${s.name} ${"─".repeat(Math.max(0, 60 - s.name.length))}`);
    const expectFn = (who: string, expected: string[]) => {
      const actual = sim.take(who);
      const ok = actual.length === expected.length && actual.every((a, i) => a === expected[i]);
      checks.push({ scenario: s.name, who, expected, actual, ok });
      if (echo && !ok) {
        console.log(`  ✗ ${who}: expected`);
        for (const x of expected) console.log(`      ${x.replace(/\n/g, "\n      ")}`);
        console.log(`    got`);
        for (const x of actual) console.log(`      ${x.replace(/\n/g, "\n      ")}`);
      }
    };
    try {
      await s.run(sim, expectFn);
    } catch (e) {
      checks.push({ scenario: s.name, who: "-", expected: [], actual: [String((e as Error).stack ?? e)], ok: false });
      if (echo) console.log(`  ✗ threw: ${(e as Error).stack ?? e}`);
    }
  }
  return checks;
}
