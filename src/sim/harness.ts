// In-memory transport plus a driver that plays several people at once. Used by `bun run sim` and the tests.
import { setClock, setClockTimeOfDay, now } from "../clock.ts";
import { config } from "../config.ts";
import { registerTransport, type Inbound, type Outbound, type SendResult, type Transport, type User } from "../messaging.ts";
import { routeInbound } from "../router.ts";
import { runDueJobs } from "../scheduler.ts";
import { addMinutes } from "../lib/time.ts";

export type SimMessage = { id: string; text: string };

const LINK = /https?:\/\/\S+?(?=[.,]?(\s|$))/g;

/** Replaces URLs with stable placeholders so transcripts compare cleanly. */
export function normalize(text: string): string {
  return text.replace(LINK, (url) => {
    if (url.includes("/l/")) return "{link}";
    if (url.includes("/i/")) return "{invite link}";
    if (url.includes("/maps/dir/")) return "{maps link}";
    if (url.includes("google.com/maps")) return "{booking link}";
    return "{url}";
  });
}

export class SimTransport implements Transport {
  readonly channel = "sim";
  readonly inbox = new Map<string, SimMessage[]>();
  private n = 0;
  echo = false;

  send(user: User, content: Outbound): Promise<SendResult> {
    const who = user.handles.find((h) => h.startsWith("sim:"))?.slice(4) ?? user.id;
    let text: string;
    switch (content.kind) {
      case "text":
        text = content.text;
        break;
      case "poll":
        text = `[poll: ${content.options.join(" / ")}]`;
        break;
      case "findmy":
        text = "[Find My request card]";
        break;
      case "react":
        text = `[reacted ${content.emoji}]`;
        break;
    }
    const id = `sim-${++this.n}`;
    const list = this.inbox.get(who) ?? [];
    list.push({ id, text });
    this.inbox.set(who, list);
    if (this.echo) {
      for (const line of text.split("\n")) console.log(`  Foodie → ${cap(who)}: ${line}`);
    }
    return Promise.resolve({ ok: true, messageId: id });
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class Sim {
  readonly transport = new SimTransport();
  private read = new Map<string, number>();
  private n = 0;

  constructor(echo = false) {
    this.transport.echo = echo;
    registerTransport(this.transport);
  }

  private inbound(who: string, extra: Partial<Inbound> & Pick<Inbound, "kind">): Inbound {
    return {
      channel: "sim",
      handle: `sim:${who}`,
      spaceId: who,
      messageId: `in-${++this.n}`,
      at: now(),
      ...extra,
    } as Inbound;
  }

  async say(who: string, text: string): Promise<void> {
    if (this.transport.echo) console.log(`${cap(who)}: ${text}`);
    await routeInbound(this.inbound(who, { kind: "text", text }));
    await runDueJobs();
  }

  async tapback(who: string, emoji: string, messageId: string): Promise<void> {
    if (this.transport.echo) console.log(`${cap(who)}: [tapback ${emoji}]`);
    await routeInbound(this.inbound(who, { kind: "reaction", emoji, targetMessageId: messageId }));
    await runDueJobs();
  }

  async vote(who: string, optionTitle: string): Promise<void> {
    if (this.transport.echo) console.log(`${cap(who)}: [votes ${optionTitle}]`);
    await routeInbound(this.inbound(who, { kind: "poll_vote", optionTitle, selected: true }));
    await runDueJobs();
  }

  async clock(hour: number, minute: number): Promise<void> {
    await setClockTimeOfDay(hour, minute);
    await runDueJobs();
  }

  async advance(minutes: number): Promise<void> {
    // Step a minute at a time so jobs run in order at their own times.
    for (let i = 0; i < minutes; i++) {
      await setClock(addMinutes(now(), 1));
      await runDueJobs();
    }
  }

  /** Messages for `who` not yet consumed, normalized. */
  take(who: string): string[] {
    const all = this.transport.inbox.get(who) ?? [];
    const from = this.read.get(who) ?? 0;
    this.read.set(who, all.length);
    return all.slice(from).map((m) => normalize(m.text));
  }

  last(who: string): SimMessage | undefined {
    return this.transport.inbox.get(who)?.at(-1);
  }

  /** The raw text of the most recent message to `who` that matches. */
  find(who: string, re: RegExp): SimMessage | undefined {
    return [...(this.transport.inbox.get(who) ?? [])].reverse().find((m) => re.test(m.text));
  }
}

export const tz = () => config.timezone;
