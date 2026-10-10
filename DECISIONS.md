# Decisions

Choices made where the spec was open, and why. Newest last within each section.

## From the spec (Appendix A)

- **Two-round protocol.** Agents first send Constraints (free time, max price, diet tags, and an area rounded to 0.02°), then evaluate a Proposal. Candidate search needs diet, price and area before any candidates exist. Exact coordinates never leave a personal agent.
- **The group price ceiling is never shown.** Options show each restaurant's public price. The person (or people) whose max set the ceiling hears "Kept it under $15 for you." privately.
- **One action per message.** The link and the Find My card go out as two messages, the second after the link page is done.
- **Newcomer's max is asked on the link page** ("Rough max per meal?"), with a text fallback, so the diet question stays one question.
- **The organizer confirms the booking** ("Booked?") before anyone is told the table is booked.
- **Taqueria demo timings are 35/10/20**, so all three options pass the 25-minute gap filter without relaxing it.
- **The budget test includes meal weights.** Dinner target $18.67 (max $20), lunch $12.44 (max $16); the solo transcript says "about $12".
- **All timing goes through `clock` and `jobs`.** Routes never receives a past departure time (`routesDepartureTime`).
- **Users are found by any handle** (E.164 phone, lowercase email, `term:`/`sim:` ids). Outbound messages go to each user's stored conversation and line.
- **/demo needs `?token=DEMO_TOKEN`** and shows only field names outside DEMO=1.
- **Every user already has a conversation with Foodie** from setup, so Foodie's own messages (invites, nudges, feedback, late alerts, split prompts) are sent directly. Newcomers always text first via an invite link.

## Made while building

### Platform

- **Advanced iMessage kit function names.** The installed `@photon-ai/advanced-imessage@2.2.0` exports `createGrpcClient` (and `createHttpClient`), not the `createClient` shown in the docs. Foodie uses `createGrpcClient`, the same way Spectrum's own iMessage provider does internally. Credentials come from `POST /projects/{id}/imessage/tokens`. Shared lines use `imessage.spectrum.photon.codes:443`; dedicated lines use `{instanceId}.imsg.photon.codes:443`.
- **Newcomer routing on shared-pool lines** follows the Spectrum API. `POST /projects/{id}/users` with `type: "shared"` and the invitee's phone assigns them a line. `GET /users/{id}/redirect?msg=…` then opens Messages to that line with the plan code prefilled. Dedicated lines use `GET /lines/route` plus an `sms:` link. Without Photon credentials, or if routing fails, the invite falls back to an `sms:` link to `FOODIE_LINK`.
- **The sim uses an in-memory transport, not the terminal provider.** In non-TTY mode the terminal provider is a single readline chat, so it can't script three people reliably. `bun run sim` drives the real router, agents and coordinator through an in-memory transport. `bun run dev` (TERMINAL=1) runs the real Spectrum terminal provider with three chats (`ronald`, `clive`, `eric`) for playing by hand.
- **Terminal and sim have a Find My stand-in.** They show `[Find My request card]`, and `/findmy yes` or `/findmy no` answers it. On iMessage, acceptance is detected by polling `locations.get` every 15 seconds for up to 3 minutes.
- **SMS contacts.** A sender whose service is SMS gets `findmy_status = unavailable`, skips the card, and is asked "Where are you coming from?" when a plan needs it.
- **GROUP_CHAT_MODE.** When it is on and every member is on iMessage, the vote is posted once into a real group chat (`space.create([...])`, Business dedicated lines only). Private details still go by DM, and each DM ends with "Vote in the group chat." On a shared line, or on any error, it falls back to per-person polls. Group-chat messages are only read for poll votes, and they never change where a person's DMs go.
- **Polls fall back to a numbered list** ("Reply 1, 2 or 3.") if a poll send is unsupported.

### Product and wording

- **Gender-neutral wording.** "send Eric this: {invite link}" instead of "send him this", and "Go without Eric?" or "Go without them?", since Foodie doesn't know anyone's pronouns.
- **Solo without a calendar** leaves out "You're free until …" rather than asking. Asking would add a step to a quick lunch question.
- **Payer acknowledgement.** When the payer says yes to a split, Foodie reacts 👍 to their message instead of sending another text, which keeps the 9.7 transcript's step count.
- **Feedback.** A tapback on "How was …?" gets no reply. A text answer gets one short line ("Good to know. I'll keep it in the rotation.").
- **Payer notifications.** The payer hears "Clive sent you $17.33." or "Eric paid you back $17.33 another way." Without this they'd never know the split was settled.
- **Organizer's own ceiling note.** If the organizer's max set the ceiling, it goes in the header: "Everyone's in. Kept it under $15 for you:".
- **Header when someone's missing.** "Everyone's in:" only when nobody dropped out or was planned without; otherwise "Here's what works:". After a change mid-vote it reads "Times changed:".
- **Relaxation lines** replace the header, so the message stays at four lines: "Nothing fit 9:00, so I moved it to 9:20:", "Nothing closer fit everyone, so some drives are longer:", and so on.
- **Overrides without an amount.** A treat night defaults to 1.5× meal_cap, rounded up to $5. "Keep it cheap" defaults to $10.
- **Unknown price** (no range and no level) is estimated at $22, the moderate level, so unpriced places aren't treated as cheap.
- **Meal windows.** Dinner meets between 5:30 and 9:00 pm, lunch between 11:30 am and 2:00 pm, never before now.
- **Late joiners.** A newcomer who finishes setup after the poll went out votes on the same options if those work for them (price, diet, no veto, and they can make the meet time). Otherwise everyone is re-polled. After confirmation they get the plan with their own leave time.
- **Newcomers with a bank** get limits from their history set quietly, so they aren't asked a budget question in the middle of someone else's plan.
- **Invite codes** are 4 characters (no 0/O/1/I), one per newcomer, and expire after 24 hours or when the organizer goes without them.
- **Learning in groups.** Only the people who voted for the winning place get +0.1 to its cuisine. Everyone who attends gets a visit recorded.

### Data and engines

- **Postgres driver.** Drizzle with `postgres` (postgres.js), not `Bun.sql`. It's the more mature Drizzle driver.
- **Concurrency.** Each user's messages and each plan's changes run one at a time under in-process keyed locks. This assumes a single server process, which is enough for the hackathon. The spec's `SELECT … FOR UPDATE` would be needed to run several replicas.
- **Location trust.** A Find My fix is used for 2 hours. A typed "where are you coming from" answer holds for the rest of the day. In demo mode, seeded locations always win.
- **Taste scores** are stored per lowercase cuisine and clamped to [−1, 1].
- **Solo score** is 0.3 × travel − 20 × fit − novelty (3 if never visited) − 5 if it matches light/filling. Hard filters: hard max, diet, veto, 35-minute cap, open from arrival for 45 minutes.
- **"New, matches what you like"** means never visited and that cuisine's taste score is above 0.2. "You loved it last time" means rating +1. Gemini may rephrase these reason codes in six words or fewer; anything longer, or with digits or emoji, falls back to the template.
- **Search radius.** 3 km for solo. For groups, the spread of the members' areas plus 8 km, capped at 20 candidates after the coordinator's own filters (price, diet, crew cooldown, open at some point in the window).
- **Demo world is fixed.** In DEMO=1, Places returns a fixed set of ten restaurants and Routes uses a fixed travel table for seeded people, so every run matches section 8. Free/busy is mocked for seeded people. Calendar events still go to the person's real Google Calendar if they signed in; otherwise a stand-in is used, and "it's on your calendar" is only said in the terminal and sim.
- **Never claim what didn't happen.** "It's on your calendar" is only said when the insert succeeded (or in the terminal/sim stand-in). "Sent." is only said after the Nessie transfer returns success. Without `NESSIE_API_KEY` an in-memory bank stands in for the terminal and sim; iMessage users are never offered a transfer against it.
- **Nessie restaurant purchases** are those whose merchant category matches food, restaurant, dining, cafe or bar. The payer is found from a purchase that day at a merchant whose name matches the restaurant, or that is within 150 m of it.
- **Gemini model.** Defaults to the `gemini-flash-latest` alias when `GEMINI_MODEL` is empty.
- **Token encryption.** Google tokens are AES-256-GCM encrypted with `ENCRYPTION_KEY`. If it's missing, a key is derived from the Photon secret and a warning is logged.

## Section 13 results

From the Stable docs and installed SDK source. **Not yet confirmed live**: no Photon credentials were available while building. Run `VERIFY_TO=+1… bun run verify:photon` and paste its output here.

| Question | What the docs and SDK say | Design impact |
|---|---|---|
| Polls in direct messages | Spectrum's `poll()` sends through `polls.create(chat.guid, …)` for any chat; neither the docs nor the SDK restrict it to groups. Votes arrive as `poll_option` content. | Per-person polls in DMs, with a numbered-list fallback. |
| Find My on shared-pool lines | The kit's `locations.request(chat, address)` takes any DM chat GUID, and Spectrum mints a shared-line token that the kit can use. No doc says Find My is limited to dedicated lines. | Send the card; if no share appears in 3 minutes, carry on and ask "Where are you coming from?" later. |
| How a newcomer reaches this agent | Shared pool: `POST /users` (shared) then `GET /users/{id}/redirect?msg=`. Dedicated: `GET /lines/route`. | `/i/{code}` does exactly this. |
| Group chats | Group creation and group events need a Business dedicated line. Shared mode throws `UnsupportedError`. | DMs by default; `GROUP_CHAT_MODE` is opt-in and falls back to DMs. |
| Sender ids | iMessage users are an E.164 phone or an email (`address`), with `service` iMessage/SMS/RCS. | Handles are normalized and an email handle is accepted. |
