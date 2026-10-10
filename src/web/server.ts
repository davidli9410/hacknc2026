// Hono: Google OAuth callback, the onboarding link page, invite links, and /demo.
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { PersonalAgent } from "../agents/personal-agent.ts";
import { config, hasGoogleOAuth, hasNessie, hasPhoton } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { linkDone } from "../flows/onboarding.ts";
import { authUrl, exchangeCode, sealTokens, warmUpContacts } from "../integrations/google.ts";
import { bank } from "../integrations/nessie.ts";
import { createSharedUser, lineModel, routeNewUser, userRedirectUrl } from "../integrations/photon-api.ts";
import { subscribeAgentMessages, type AgentMessageEvent } from "../protocol.ts";
import { esc, page } from "./html.ts";
import { demoPage } from "./demo-page.ts";

type User = typeof schema.users.$inferSelect;

async function userByLink(token: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(schema.users.linkToken, token) });
}

type LinkState = { skippedGoogle?: boolean; skippedBank?: boolean };
const linkKey = (u: User) => `link_state:${u.id}`;
async function linkState(u: User): Promise<LinkState> {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, linkKey(u)) });
  return (row?.value as LinkState) ?? {};
}
async function setLinkState(u: User, s: LinkState): Promise<void> {
  await db.insert(schema.settings).values({ key: linkKey(u), value: s }).onConflictDoUpdate({ target: schema.settings.key, set: { value: s } });
}

/** Newcomers joining a plan: the bank is optional and contacts aren't needed. */
async function isJoining(u: User): Promise<boolean> {
  const row = await db.query.planMembers.findFirst({ where: eq(schema.planMembers.userId, u.id) });
  return Boolean(row && row.role === "member");
}

export function createWeb(): Hono {
  const app = new Hono();

  app.get("/", (c) => c.html(page("Foodie", `<h1>Foodie</h1><p class="sub">Text Foodie on iMessage when you're hungry.</p>`)));
  app.get("/health", (c) => c.json({ ok: true }));

  // -------------------------------------------------------------------------------------------
  // Onboarding link page: Google sign-in → bank (or max) → all set.

  app.get("/l/:token", async (c) => {
    const u = await userByLink(c.req.param("token"));
    if (!u) return c.html(page("Foodie", `<h1>Link expired</h1><p class="sub">Text Foodie and it'll send a new one.</p>`), 404);
    const state = await linkState(u);
    const joining = await isJoining(u);
    const googleDone = Boolean(u.googleTokens) || state.skippedGoogle;
    const bankDone = Boolean(u.nessieAccountId) || state.skippedBank;
    const needMax = bankDone && !u.nessieAccountId && u.mealCap == null;
    const finished = u.linkDoneAt != null;
    const t = esc(u.linkToken);

    if (finished) {
      return c.html(page("All set", `<h1>All set</h1><p class="sub">Head back to Messages.</p><a class="btn" href="sms:">Back to Messages</a>`));
    }

    const googleStep = googleDone
      ? `<div class="card step done"><div class="num">✓</div><div><h2>Calendar${joining ? "" : " and contacts"}</h2><p>${u.googleTokens ? `Connected${u.googleEmail ? ` as ${esc(u.googleEmail)}` : ""}.` : "Skipped. I'll ask when you're free instead."}</p></div></div>`
      : `<div class="card step"><div class="num">1</div><div style="flex:1"><h2>Calendar${joining ? "" : " and contacts"}</h2><p>So I know when you're free and who your friends are. I never share what's on it.</p>
         ${hasGoogleOAuth() ? `<a class="btn" href="/auth/google?t=${t}">Sign in with Google</a>` : `<p class="muted">Google sign-in isn't configured on this server.</p>`}
         <form method="post" action="/l/${t}/skip-google" style="margin-top:8px"><button class="btn secondary">Skip</button></form></div></div>`;

    const bankStep = !googleDone
      ? `<div class="card step"><div class="num">2</div><div><h2>Bank${joining ? " (optional)" : ""}</h2><p>Sets your budget from what you actually spend.</p></div></div>`
      : bankDone
        ? `<div class="card step done"><div class="num">✓</div><div><h2>Bank</h2><p>${u.nessieAccountId ? "Connected through Capital One Nessie (sandbox)." : "Skipped."}</p></div></div>`
        : `<div class="card step"><div class="num">2</div><div style="flex:1"><h2>Connect bank${joining ? " (optional)" : ""}</h2><p>Capital One Nessie sandbox. Your spending stays private to your own Foodie.</p>${await bankPicker(t)}
           <form method="post" action="/l/${t}/skip-bank" style="margin-top:8px"><button class="btn secondary">Skip</button></form></div></div>`;

    const maxStep = needMax
      ? `<div class="card step"><div class="num">3</div><div style="flex:1"><h2>Rough max per meal?</h2><p>Only you ever see this number.</p>
         <form method="post" action="/l/${t}/max"><input name="amount" inputmode="numeric" placeholder="$20" required><button class="btn">Save</button></form></div></div>`
      : "";

    const ready = googleDone && bankDone && !needMax;
    const finish = ready
      ? `<form method="post" action="/l/${t}/finish"><button class="btn">Done, back to Messages</button></form>`
      : "";
    return c.html(page("Connect Foodie", `<h1>Hi${u.name ? ` ${esc(u.name)}` : ""}</h1><p class="sub">Two quick steps, then back to Messages.</p>${googleStep}${bankStep}${maxStep}${finish}`));
  });

  async function bankPicker(t: string): Promise<string> {
    if (!hasNessie() && !config.demo) return `<p class="muted">Bank connection isn't configured on this server.</p>`;
    try {
      const customers = (await bank().listCustomers()).slice(0, 50);
      if (customers.length === 0) return `<p class="muted">No sandbox customers yet.</p>`;
      const options = customers.map((cu) => `<option value="${esc(cu.id)}">${esc(cu.firstName)} ${esc(cu.lastName)}</option>`).join("");
      return `<form method="post" action="/l/${t}/bank"><select name="customerId">${options}</select><button class="btn">Connect bank</button></form>`;
    } catch (e) {
      return `<p class="muted">Couldn't reach the bank sandbox: ${esc((e as Error).message)}</p>`;
    }
  }

  app.post("/l/:token/skip-google", async (c) => {
    const u = await userByLink(c.req.param("token"));
    if (!u) return c.notFound();
    await setLinkState(u, { ...(await linkState(u)), skippedGoogle: true });
    return c.redirect(`/l/${u.linkToken}`);
  });

  app.post("/l/:token/skip-bank", async (c) => {
    const u = await userByLink(c.req.param("token"));
    if (!u) return c.notFound();
    await setLinkState(u, { ...(await linkState(u)), skippedBank: true });
    return c.redirect(`/l/${u.linkToken}`);
  });

  app.post("/l/:token/bank", async (c) => {
    const u = await userByLink(c.req.param("token"));
    if (!u) return c.notFound();
    const form = await c.req.parseBody();
    const customerId = String(form.customerId ?? "");
    const accounts = await bank().accounts(customerId);
    const account = accounts[0];
    if (!account) return c.html(page("Foodie", `<h1>No account</h1><p class="sub">That customer has no accounts.</p><a class="btn" href="/l/${esc(u.linkToken)}">Back</a>`), 400);
    await PersonalAgent.for(u.id).update({ nessieCustomerId: customerId, nessieAccountId: account.id });
    return c.redirect(`/l/${u.linkToken}`);
  });

  app.post("/l/:token/max", async (c) => {
    const u = await userByLink(c.req.param("token"));
    if (!u) return c.notFound();
    const form = await c.req.parseBody();
    const amount = Number(String(form.amount ?? "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(amount) && amount > 0) await PersonalAgent.for(u.id).update({ mealCap: Math.round(amount) });
    return c.redirect(`/l/${u.linkToken}`);
  });

  app.post("/l/:token/finish", async (c) => {
    const u = await userByLink(c.req.param("token"));
    if (!u) return c.notFound();
    await linkDone(u.id);
    return c.redirect(`/l/${u.linkToken}`);
  });

  // -------------------------------------------------------------------------------------------
  // Google OAuth

  app.get("/auth/google", async (c) => {
    const token = c.req.query("t") ?? "";
    const u = await userByLink(token);
    if (!u || !hasGoogleOAuth()) return c.notFound();
    return c.redirect(authUrl(token));
  });

  app.get("/auth/google/callback", async (c) => {
    const token = c.req.query("state") ?? "";
    const code = c.req.query("code");
    const u = await userByLink(token);
    if (!u) return c.notFound();
    if (!code) return c.redirect(`/l/${token}`);
    try {
      const { tokens, givenName, email } = await exchangeCode(code);
      await PersonalAgent.for(u.id).update({ googleTokens: sealTokens(tokens), googleEmail: email ?? null, ...(u.name ? {} : givenName ? { name: givenName } : {}) });
      const fresh = await PersonalAgent.for(u.id).user();
      await warmUpContacts(fresh).catch(() => undefined);
    } catch (e) {
      console.error("[oauth]", e);
      return c.html(page("Foodie", `<h1>Sign-in didn't work</h1><p class="sub">${esc((e as Error).message)}</p><a class="btn" href="/l/${esc(token)}">Try again</a>`), 400);
    }
    return c.redirect(`/l/${token}`);
  });

  // -------------------------------------------------------------------------------------------
  // Invite links: open Messages to a working Foodie line with the code prefilled.

  app.get("/i/:code", async (c) => {
    const code = c.req.param("code").toUpperCase();
    const invite = await db.query.invites.findFirst({ where: eq(schema.invites.code, code) });
    if (!invite) return c.html(page("Foodie", `<h1>Invite not found</h1><p class="sub">Ask your friend for a new link.</p>`), 404);
    const plan = await db.query.plans.findFirst({ where: eq(schema.plans.id, invite.planId) });
    const organizer = await db.query.users.findFirst({ where: eq(schema.users.id, invite.inviterId) });
    const body = `Hi Foodie, I'm in for ${plan?.meal === "lunch" ? "lunch" : "dinner"} with ${organizer?.name ?? "my friend"} (code ${code})`;

    if (hasPhoton()) {
      try {
        const model = await lineModel();
        if (model === "shared" && invite.inviteeHandle?.startsWith("+")) {
          const shared = await createSharedUser(invite.inviteeHandle, invite.inviteeName);
          return c.redirect(userRedirectUrl(shared.id, body));
        }
        if (model === "dedicated") {
          const { line } = await routeNewUser();
          return c.redirect(`sms:${line.phoneNumber}&body=${encodeURIComponent(body)}`);
        }
      } catch (e) {
        console.warn("[invite] Photon routing failed, using FOODIE_LINK:", (e as Error).message);
      }
    }
    const link = config.photon.foodieLink;
    if (link && /^\+?\d[\d\s-]+$/.test(link)) return c.redirect(`sms:${link.replace(/[\s-]/g, "")}&body=${encodeURIComponent(body)}`);
    if (link && /^https?:/.test(link)) return c.redirect(link);
    return c.html(page("Join Foodie", `<h1>Join ${esc(organizer?.name ?? "your friend")}</h1><p class="sub">Text Foodie this message:</p><div class="card">${esc(body)}</div>`));
  });

  // -------------------------------------------------------------------------------------------
  // /demo: one column per personal agent plus the coordinator, live.

  const demoAllowed = (token: string | undefined) => Boolean(config.demoToken) && token === config.demoToken;

  app.get("/demo", (c) => {
    if (!demoAllowed(c.req.query("token"))) return c.text("Forbidden", 403);
    return c.html(demoPage(String(c.req.query("token")), config.demo));
  });

  app.get("/demo/state", async (c) => {
    if (!demoAllowed(c.req.query("token"))) return c.text("Forbidden", 403);
    const people = await db.select({ id: schema.users.id, name: schema.users.name, demoKey: schema.users.demoKey }).from(schema.users);
    const recent = await db.select().from(schema.agentMessages).orderBy(desc(schema.agentMessages.id)).limit(200);
    const events = recent.reverse().map((r) => redact({ id: r.id, planId: r.planId, from: r.from, to: r.to, type: r.type as AgentMessageEvent["type"], payload: r.payload, at: r.at.toISOString() }));
    return c.json({ people, events, demo: config.demo, names: config.demoNames });
  });

  app.get("/demo/stream", (c) => {
    if (!demoAllowed(c.req.query("token"))) return c.text("Forbidden", 403);
    return streamSSE(c, async (stream) => {
      const queue: AgentMessageEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = subscribeAgentMessages((e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      while (!stream.aborted) {
        if (queue.length === 0) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15000)]);
          wake = null;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: "" });
            continue;
          }
        }
        const e = queue.shift()!;
        await stream.writeSSE({ event: "agent_message", data: JSON.stringify(redact(e)), id: String(e.id) });
      }
      unsubscribe();
    });
  });

  return app;
}

/** Outside demo mode, /demo shows message types and field names only. */
function redact(e: AgentMessageEvent): AgentMessageEvent {
  if (config.demo) return e;
  const hide = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(hide) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hide(x)])) : "•••";
  return { ...e, payload: hide(e.payload) };
}

export function startWeb(): ReturnType<typeof Bun.serve> {
  const app = createWeb();
  return Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 0 });
}
