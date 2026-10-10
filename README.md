# Foodie

An AI agent you text over iMessage. It knows your tastes, budget, calendar and location. It tells you where to eat right now, and plans a meal with friends in a few taps.

Each person has their own **personal agent** that holds their private data. When friends eat together, a **coordinator** negotiates between those agents, and only constraints cross that boundary: free time, a max price, diet tags, a ~2 km area and per-restaurant evaluations. Nobody's budget, calendar, exact location or vetoes are ever shown to anyone else.

Built for HackNC 2026 on **Photon Spectrum** (the whole interface), **Capital One Nessie** (budgets and bill splitting) and **Gemini** (intent parsing and short reasons).

## Run it in the terminal (no credentials needed)

You need [Bun](https://bun.sh) and Postgres.

```sh
bun install
createdb foodie

bun test        # engines, parsers, and every section 9 transcript end to end
bun run sim     # plays Ronald, Clive and Eric through every transcript, printed as a chat
```

`bun run sim` prints each conversation and checks it word for word against the spec, for example:

```
Ronald: dinner tonight with Clive and Eric
  Foodie → Ronald: On it. Clive's on Foodie. Eric isn't yet, so send Eric this: https://…/i/K7Q2
  Foodie → Clive: Ronald's planning dinner tonight with you and Eric. You're free at 6:20, so I'm aiming for about 6:30. In?
…
  Foodie → Ronald: Everyone's in:
  Foodie → Ronald: Thai place · 6:30 · ~$14 · 30 min drive
  Foodie → Ronald: Pizza spot · 6:35 · ~$12 · 25 min
  Foodie → Ronald: Taqueria · 6:35 · ~$11 · 35 min
  Foodie → Ronald: [poll: Thai / Pizza / Taqueria]
```

Pass a name to run one scenario: `bun run sim "Group dinner"`. The sim uses its own database (`foodie_sim`) and never calls an external API.

### Play it yourself

```sh
DEMO=1 bun run dev
```

This starts the Spectrum terminal provider with three chats: `ronald`, `clive` and `eric`. Switch between them with `Ctrl+J` / `Ctrl+K`; press `r` on a message to react. Try this:

| Chat | Type |
|---|---|
| ronald | `/clock 12:00`, then `I'm hungry`, `filling`, `1` |
| ronald | `/clock 17:50`, then `dinner tonight with Clive and Eric` |
| clive | `in` |
| eric | the text the invite link would prefill: `Hi Foodie, I'm in for dinner with Ronald (code XXXX)` |
| eric | `no seafood`, open the link (or skip it), `/findmy yes` |
| all | vote by replying with the option number |
| ronald | `booked`, `/late clive 8`, `/clock 20:00`, `/paid 52`, `yes` |

The hidden demo commands are organizer-only and need `DEMO=1`: `/clock 17:50`, `/late clive 8`, `/paid 52` and `/reset`.

## Run it on real phones

1. **Fill in `.env`.** Copy `.env.example` to `.env` and fill it in.
2. **Expose the server.** Run `cloudflared tunnel --url http://localhost:3000` and set `PUBLIC_BASE_URL` to the HTTPS URL it prints.
3. **Photon.** Set `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` and `FOODIE_LINK`. Check what your plan supports, using your own number:
   ```sh
   VERIFY_TO=+15551234567 bun run verify:photon
   ```
   It reports the line model, whether polls work in DMs, whether the Find My card sends, and how newcomers are routed. Paste the results into `DECISIONS.md`.
4. **Google Cloud.** Use one project for everything.
   - Enable the Calendar API, People API, Places API (New) and Routes API. Put a restricted key in `GOOGLE_MAPS_API_KEY`.
   - Create an OAuth client (Web). Add the redirect URI `${PUBLIC_BASE_URL}/auth/google/callback`.
   - **The app stays in Testing mode**, so:
     - Add every Google account that will sign in (`DEMO_GOOGLE_ACCOUNTS`) as a **test user** on the consent screen. Other accounts are refused.
     - Everyone sees Google's **"unverified app"** screen once. Tap *Advanced → Continue*.
     - **Refresh tokens expire after 7 days.** After that, Foodie treats the calendar as disconnected and falls back to asking "When are you free?". Re-link to fix it.
5. **Nessie.** Set `NESSIE_API_KEY`. Nessie is a **sandbox: no real money moves**. "Sent." means the sandbox transfer succeeded.
6. **Gemini.** Set `GEMINI_API_KEY`, and `GEMINI_MODEL` to a current Flash model.
7. **Demo.** Set `DEMO=1`, `DEMO_TOKEN`, and `DEMO_PHONES=+1… / +1… / +1…` (organizer / member / newcomer). Then:
   ```sh
   bun start
   ```
   In demo mode Ronald and Clive are seeded and Eric starts with nothing. All three phones can be in the same room: seeded locations override Find My, but Eric still gets a real Find My card when he sets up.
8. **Watch the agents.** Open `${PUBLIC_BASE_URL}/demo?token=DEMO_TOKEN` to see every agent-to-agent message live, with one column per personal agent plus the coordinator.

## How it's built

```
src/
  router.ts               every inbound message → sender → that person's agent (one at a time per person)
  agents/
    personal-agent.ts     one per user: profile, memory, budget, calendar, location; answers constraints() and evaluate()
    coordinator.ts        one per group plan: two-round protocol, ranking, polls, vote, confirm, booking, runner-up
  engines/                pure functions with unit tests
    budget.ts             section 7
    arrival.ts            section 8: meet time and per-person leave times
    ranking.ts            section 8: hard filters, score, top three, relaxation
  flows/                  onboarding, solo, friends (contact resolution), conversation (pending questions + intents), after (late, feedback, split)
  integrations/           photon (Spectrum), photon-api, findmy, google (OAuth, Calendar, People), places, routes, nessie, gemini
  web/                    Hono: link page, OAuth callback, invite links, /demo
  scheduler.ts, clock.ts  durable jobs table; one source of "now" that /clock moves
  protocol.ts             typed agent messages, logged to agent_messages and streamed to /demo
  demo/                   seeded world, hidden commands
  sim/                    in-memory transport and the section 9 scenarios
```

- **The LLM never does arithmetic.** Gemini only turns text into an intent (JSON-schema output) and may rephrase a reason code. Scores, budgets and times are computed in code. Short replies ("1", "yes", "in", "booked", tapbacks, poll votes) skip the LLM entirely.
- **One open question per person.** The `pending` table makes sure "yes" and "1" mean what Foodie just asked. Anything else falls through to intent parsing, and the plan's state is kept.
- **Durable timers.** Poll closing, nudges, location watching, feedback and the split all live in `jobs`, so they survive a restart and follow the demo clock.

`DECISIONS.md` records every choice the spec left open.

## Commands

| Command | What it does |
|---|---|
| `bun test` | Unit tests and the end-to-end transcript scenarios (uses database `foodie_test`) |
| `bun run sim [name]` | Prints and checks the transcripts (uses database `foodie_sim`) |
| `bun run dev` | Server plus terminal provider (`TERMINAL=1`) |
| `bun start` | Server: iMessage when Photon is configured, plus web |
| `bun run verify:photon` | Section 13 live checks |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:generate` | Regenerate migrations after editing `src/db/schema.ts` |

Migrations run on startup.

## What has and hasn't been verified

- **Verified here:**
  - `bun test` (62 tests) and `bun run sim` (every transcript in section 9, plus the drop-out, tie, runner-up and who-paid paths)
  - Typecheck
  - The web link page, walked through by hand
  - The Spectrum terminal provider, smoke-tested
- **Not yet run against live services:** iMessage via Photon, Find My, Google OAuth / Calendar / People, Places, Routes, Gemini and the real Nessie API. No credentials were available while building. The integrations follow the current docs and the installed SDK types. Run `bun run verify:photon` and a real-phone pass before the demo.
