// Spectrum: one agent loop for every provider. iMessage in production, the terminal provider in development.
import { Spectrum, poll, reaction, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { config, hasPhoton } from "../config.ts";
import { registerGroupPoller, registerTransport, type Inbound, type Outbound, type SendResult, type Transport, type User } from "../messaging.ts";
import { normalizeHandle } from "../router-util.ts";

type App = Awaited<ReturnType<typeof Spectrum>>;

// Platform narrowing is heavily generic; these are the few members Foodie uses.
type PlatformApi = {
  user(id: string): Promise<unknown>;
  space: { get(id: string, params?: { phone: string }): Promise<Space>; create(user: unknown, params?: { phone: string }): Promise<Space> };
};
const imessagePlatform = (a: unknown) => (imessage as unknown as (x: unknown) => PlatformApi)(a);
const terminalPlatform = (a: unknown) => (terminal as unknown as (x: unknown) => PlatformApi)(a);
const imessageSpace = (s: unknown) => (imessage as unknown as (x: unknown) => { phone?: string; type?: string })(s);
const imessageMessage = (m: unknown) => (imessage as unknown as (x: unknown) => { sender?: { service?: string } })(m);

let app: App | null = null;

const DEMO_TERMINAL_SPACES = () => Object.values(config.demoNames).map((n) => n.toLowerCase());

async function spaceForUser(user: User): Promise<Space | null> {
  if (!app) return null;
  if (user.channel === "imessage") {
    const im = imessagePlatform(app);
    const params = user.foodieLine ? { phone: user.foodieLine } : undefined;
    if (user.spaceId) return im.space.get(user.spaceId, params);
    const handle = user.handles.find((h) => h.startsWith("+") || h.includes("@"));
    if (!handle) return null;
    return im.space.create(await im.user(handle), params);
  }
  if (user.channel === "terminal") return terminalPlatform(app).space.get(user.spaceId ?? "chat-1");
  return null;
}

class SpectrumTransport implements Transport {
  constructor(readonly channel: "imessage" | "terminal") {}

  async send(user: User, content: Outbound): Promise<SendResult> {
    const space = await spaceForUser(user);
    if (!space) return { ok: false, error: "no space" };
    switch (content.kind) {
      case "text": {
        const sent = await space.send(content.text);
        return { ok: true, messageId: sent?.id };
      }
      case "poll": {
        const sent = await space.send(poll(content.title, ...content.options));
        if (!sent) return { ok: false, error: "polls unsupported" };
        return { ok: true, messageId: sent.id };
      }
      case "findmy": {
        // The real card goes through the Advanced iMessage kit; the terminal gets a stand-in.
        if (this.channel === "terminal") {
          const sent = await space.send("[Find My request card] (type /findmy yes or /findmy no)");
          return { ok: true, messageId: sent?.id };
        }
        return { ok: true };
      }
      case "react": {
        const target = await space.getMessage(content.targetMessageId);
        if (!target) return { ok: false, error: "target not found" };
        await space.send(reaction(content.emoji, target));
        return { ok: true };
      }
    }
  }
}

function unwrap(message: Message): Message["content"] {
  const c = message.content as Message["content"] & { content?: Message["content"] };
  return c.type === "reply" && c.content ? c.content : c;
}

/** Spectrum message → our Inbound. Returns null for things Foodie ignores. */
function toInbound(space: Space, message: Message): Inbound | null {
  if (message.direction === "outbound") return null;
  const platform = message.platform as string;
  let handle: string | null;
  let line: string | undefined;
  let service: string | undefined;
  let channel: "imessage" | "terminal";
  let group = false;
  if (platform === "imessage") {
    channel = "imessage";
    handle = normalizeHandle(message.sender?.id ?? "");
    const s = imessageSpace(space);
    // Group chats only matter for GROUP_CHAT_MODE poll votes; everything else is handled in DMs.
    group = s.type === "group";
    if (group && (unwrap(message) as { type: string }).type !== "poll_option") return null;
    line = s.phone && s.phone !== "shared" ? s.phone : undefined;
    service = imessageMessage(message).sender?.service;
  } else if (platform === "terminal") {
    channel = "terminal";
    handle = `term:${space.id}`;
  } else {
    return null;
  }
  if (!handle) return null;
  const base = { channel, handle, spaceId: space.id, line, service, group, messageId: message.id, at: message.timestamp };
  const c = unwrap(message) as any;
  switch (c.type) {
    case "text":
      return { ...base, kind: "text", text: c.text };
    case "reaction":
      return { ...base, kind: "reaction", emoji: c.emoji, targetMessageId: c.target?.id ?? "" };
    case "poll_option":
      return { ...base, kind: "poll_vote", optionTitle: c.option?.title ?? c.title, selected: Boolean(c.selected), pollMessageId: message.id.split(":")[0] };
    case "contact":
      return {
        ...base,
        kind: "contact",
        name: c.name?.formatted ?? [c.name?.first, c.name?.last].filter(Boolean).join(" "),
        phones: (c.phones ?? []).map((p: { value: string }) => p.value),
        emails: (c.emails ?? []).map((e: { value: string }) => e.value),
      };
    default:
      return null;
  }
}

export async function startSpectrum(onInbound: (msg: Inbound) => Promise<void>): Promise<App | null> {
  const providers: unknown[] = [];
  if (hasPhoton()) providers.push(imessage.config());
  if (config.terminal) providers.push(terminal.config({ commands: [{ name: "/findmy", description: "Accept (yes) or decline (no) the Find My card" }, { name: "/clock", description: "Demo: set the clock" }, { name: "/late", description: "Demo: /late clive 8" }, { name: "/paid", description: "Demo: /paid 52" }, { name: "/reset", description: "Demo: reset" }] }));
  if (providers.length === 0) return null;
  app = hasPhoton()
    ? await Spectrum({ projectId: config.photon.projectId!, projectSecret: config.photon.projectSecret!, providers: providers as never })
    : await Spectrum({ providers: providers as never });
  if (hasPhoton()) {
    registerTransport(new SpectrumTransport("imessage"));
    if (config.groupChatMode) {
      registerGroupPoller(async (users, title, options) => {
        const im = imessagePlatform(app);
        const people = [];
        for (const u of users) {
          const handle = u.handles.find((h) => h.startsWith("+") || h.includes("@"));
          if (!handle) return { ok: false, error: `no iMessage handle for ${u.id}` };
          people.push(await im.user(handle));
        }
        // Throws UnsupportedError on shared-pool lines; the caller falls back to DMs.
        const group = await im.space.create(people);
        const sent = await group.send(poll(title, ...options));
        return sent ? { ok: true, messageId: sent.id } : { ok: false, error: "poll not sent" };
      });
    }
  }
  if (config.terminal) {
    registerTransport(new SpectrumTransport("terminal"));
    // One chat per demo person so all three can be driven from one terminal.
    const t = terminalPlatform(app);
    for (const name of DEMO_TERMINAL_SPACES()) await t.space.get(name);
  }
  void (async () => {
    for await (const [space, message] of app!.messages) {
      const inbound = toInbound(space as Space, message as Message);
      if (inbound) void onInbound(inbound);
    }
  })();
  return app;
}

export async function stopSpectrum(): Promise<void> {
  await app?.stop();
  app = null;
}
