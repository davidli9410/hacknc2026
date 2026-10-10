# How Foodie works

Foodie is an iMessage bot. Every user gets a **personal agent** that keeps their private data: diet, budget, calendar, location and taste history. When friends plan a meal together, a **coordinator** for that plan talks to each personal agent. It only ever receives limited constraints and scores from them, never the raw data.

## 1. Layers

```
iMessage / terminal / sim   ← transports (src/integrations/photon.ts, src/sim/)
        │  Inbound
        ▼
router.ts                    ← who sent this? handles one message per person at a time
        │
        ▼
flows/conversation.ts        ← answer the open question, or else parse an intent
        │
   ┌────┴─────────────┬──────────────────┬──────────────┐
flows/onboarding   flows/solo      flows/friends → agents/coordinator   flows/after
        │                 │                         │
        └──────── agents/personal-agent.ts ─────────┘   (private data lives here)
                          │
engines/ (budget, arrival, ranking: pure math)    integrations/ (Google, Places, Routes, Nessie, Gemini, Find My)
                          │
              Postgres via Drizzle  +  scheduler.ts (the jobs table)  +  clock.ts
```

## 2. Startup (`src/main.ts`)

1. Runs the migrations in `drizzle/`.
2. `loadClock()` loads the clock offset. In demo mode, the clock is pinned to `DEMO_DATE` at the current wall-clock time.
3. `registerJobs()` connects each job kind to its handler (`src/jobs.ts`).
4. If `DEMO=1` and the database is empty, it seeds Ronald and Clive (`src/demo/seed.ts`). Eric starts with nothing so the newcomer path can be shown.
5. Starts the Hono web server (link page, OAuth, invite links, `/demo`).
6. Starts Spectrum, which provides iMessage and/or the terminal. Every inbound message goes to `routeInbound`.
7. Starts the scheduler, which checks for due jobs every 5 seconds.

## 3. What happens to every inbound message

**Transport → `Inbound`.** `photon.ts` turns a Spectrum message into an `Inbound` of one of four kinds: `text`, `reaction` (tapback), `poll_vote` or `contact` (shared contact card). It also normalizes the sender's handle (E.164 phone, lowercase email, or a `term:`/`sim:` id) in `router-util.ts`.

**Router (`src/router.ts`).** The whole message runs under `withLock("user:<handle>")`, so each person's messages are handled one at a time and in order. Then, in this order:

1. **Look up the user** by any of their handles. If their conversation, line or channel changed, the stored reply path is updated.
2. **Demo commands** (`/clock`, `/late`, `/paid`, `/reset`). These need `DEMO=1` and only work for the organizer.
3. **`/findmy yes|no`.** A stand-in for the Find My card in the terminal and sim.
4. **`stop`.** Pauses the user and clears their open question. No LLM is involved.
5. **Plan codes.** A regex looks for `code XXXX`. If it matches an invite, the router creates the user if needed and calls `newcomerJoined`. It then either starts newcomer setup or says "You're in".
6. **Unknown sender with no code** → `startOnboarding`.
7. Tapbacks, poll votes and contact cards go to their own handlers.
8. Everything else → `handleText`.

**`handleText` (`src/flows/conversation.ts`).** This works in two steps:

- **The open question comes first.** Each user has at most one row in the `pending` table, for example `{kind: "vote", planId}`. `answerPending` tries to read the reply as an answer to that question, so "1", "yes", "in" or "booked" mean what Foodie just asked. Kinds include `diet`, `mood`, `invite_in`, `when_free`, `vote`, `confirm_booked`, `runner_up`, `confirm_split` and `feedback`. These replies never go through the LLM.
- **Otherwise, parse an intent.** `parseIntent` (`integrations/gemini.ts`) asks Gemini for JSON that must match a schema, with the last question as context. If Gemini is off or fails, the rules parser in `intent.ts` is used. `act()` then dispatches on the intent type: `hungry_solo`, `plan_group`, `set_pref`, `veto`, `budget_override`, `availability`, `feedback`, `what_do_you_know`, `forget`, `booked`, `paid`, and so on. Anything it doesn't recognize gets "I can find you somewhere to eat now, or plan a meal with friends. Hungry?"

Gemini is never used for arithmetic. Its only jobs are classifying intents and optionally rewording a reason in six words or fewer.

## 4. Onboarding (`src/flows/onboarding.ts`)

The user's `onboarding` field moves through these steps: `asked_diet → link_sent → (asked_max) → card_sent → (asked_budget) → done`.

1. **Diet.** Foodie says "Hey, I'm Foodie… Anything you don't eat?" `parseDietAnswer` maps the reply to tags such as `vegetarian`, `no seafood` or `halal`, and also picks up an optional `$20` as the max per meal.
2. **Link.** Foodie sends `${PUBLIC_BASE_URL}/l/<token>`. That page (`web/server.ts`) connects Google OAuth (Calendar and Contacts), a Nessie bank account, and optionally a max per meal. If the link isn't used, a job sends a reminder after 5 minutes.
3. **Max per meal.** When the link page is finished, Foodie asks "Rough max per meal?" only if there's no meal cap and no bank.
4. **Find My.** Foodie sends a location-share request card. On iMessage, a job checks `locations.get` every 15 seconds for up to 3 minutes. In the terminal you answer with `/findmy yes`. SMS users skip this step.
5. **Finish.** If a bank is connected, `proposeLimits` suggests limits from three months of restaurant purchases: the monthly limit is the average monthly spend, and the meal cap is the 90th-percentile meal rounded up to $5. Foodie asks "Use those as your limits?" If the user is a newcomer who joined through someone's plan, the limits are set without asking and they go straight into the plan through `newcomerReady`.

## 5. Solo: "I'm hungry" (`src/flows/solo.ts`)

1. `startSolo` checks for a location through `agent.location()`. In demo mode, seeded locations always win. Otherwise it uses a live Find My fix (trusted for 2 hours), then a typed answer (trusted for the rest of the day). If none of these exist, Foodie asks "Where are you coming from?" and geocodes the reply.
2. If no mood was given, Foodie asks "Light or filling?" It adds "You're free until X" when there's a calendar and "about $Y today" when there's a budget.
3. `showOptions`:
   - searches Places within 3 km and gets walking and driving times from Routes
   - `chooseTravel` picks walking if it takes 15 minutes or less, otherwise driving
   - builds a `SoloCandidate` for each place with its fit, veto status, novelty and whether it matches the mood
4. `rankSolo` (in `engines/ranking.ts`):
   - **Hard filters:** price ≤ hardMax, diet OK, not vetoed, travel ≤ 35 min, open from arrival for 45 minutes.
   - **Score** (lower is better): `0.3·travel − 20·fit − novelty(3 if never visited) − 5 if mood matches`.
   - Picks the top three, preferring different cuisines.
5. Foodie sends a numbered list, for example "1. Thai place · 8 min walk · ~$12 · new, matches what you like". A reason is only shown when memory explains the pick.
6. When the user replies "2", `chooseSolo` runs:
   - learns from the choice (+0.1 to that cuisine's taste score) and records a visit
   - sends a directions link and "You'll be back well before 3:00" (when a calendar is connected)
   - schedules `solo_feedback` for 60 minutes later

## 6. Group plans: the main flow

### 6a. Who's coming (`src/flows/friends.ts`)

"dinner tonight with Clive and Eric" becomes a `plan_group` intent with `names: ["Clive", "Eric"]`. `continueDraft` resolves each name in turn:

1. **"the usual"** expands to the saved crew.
2. **Known contacts** for this organizer, matched by full name, first name or nickname. If several match, Foodie asks "Eric Chen or Eric Park?"
3. **Google Contacts** search, when the organizer has linked Google.
4. Otherwise Foodie asks: "I don't have Eric's number. Share the contact card?"

Each resolved person becomes an `Invitee` with a `userId` if they're already on Foodie, or `null` if they're a newcomer. The group is saved as "the usual", and then `startGroupPlan` runs.

### 6b. Starting the plan (`agents/coordinator.ts`: `startGroupPlan`)

- **Window** (`planWindow`): dinner runs from 5:30 to 9:00 pm, lunch from 11:30 am to 2:00 pm. The window never starts before now.
- Creates the `plans` row (`status: gathering`). The organizer is added with status `in`. Members already on Foodie are added as `invited`.
- **Newcomers** get a 4-character invite code that lasts 24 hours, plus a link `/i/<code>`.
- The organizer gets: "On it. Clive's on Foodie. Eric isn't yet, so send Eric this: https://…/i/K7Q2"
- `gatherConstraints` runs for the organizer.
- Each existing member gets an invite written by **their own agent**, using their own free time: "Ronald's planning dinner tonight with you and Eric. You're free at 6:20, so I'm aiming for about 6:30. In?" Their pending question becomes `invite_in`. Without a calendar, they're asked "When are you free?" instead.
- Schedules `invite_timeout` for 15 minutes later.

### 6c. Round 1: constraints (the privacy boundary)

The coordinator sends a `ConstraintRequest` to each agent. `PersonalAgent.constraints()` answers with only:

```ts
{ freeAt, maxPrice /* budget.hardMax */, dietTags, area: { lat, lng } /* rounded to 0.02°, about 2 km */ }
```

If the agent is missing information, it returns `{need: "location"}` or `{need: "free"}`. The coordinator then asks the owner "Where are you coming from?" or "When are you free?" and waits.

Every protocol message is written to `agent_messages` and streamed live to `/demo` (`protocol.ts`).

The member's replies lead to these coordinator calls:

| Reply | Coordinator call |
|---|---|
| `in` / yes | `memberIn` → collects constraints |
| `after 7` | `memberIn(freeAt = 7pm)` or `memberAvailability` (a `ConstraintsUpdate`) |
| `can't` | `memberOut`. The organizer hears "Clive can't make it." |

After every change, **`maybeProceed`** checks whether anyone is still `invited`, whether any invite codes are unused, and whether any `in` member is missing constraints. If nobody is still pending:

- with fewer than 2 people in, it calls the plan off
- otherwise it runs the rounds

**Timeouts.** After 15 minutes, the organizer gets "Still waiting on Eric. Go without Eric? yes/no". If they say no, or don't answer, Foodie waits another 10 minutes and then drops whoever is still pending (`dropWaiting`).

### 6d. Newcomer path

1. Eric taps `/i/K7Q2`. On a Photon shared line, `POST /users` gives him a line. He's then redirected to Messages with "Hi Foodie, I'm in for dinner with Ronald (code K7Q2)" already filled in.
2. The router sees the code → `newcomerJoined` marks the invite used and adds Eric as `in` → `startNewcomer` sends "Hey Eric! Ronald's planning dinner tonight with you and Clive. Anything you don't eat?"
3. Eric goes through the shorter onboarding (diet → link with a max field → Find My). Then `newcomerReady` collects his constraints.
4. If voting has already started (`joinVoting`), his agent evaluates the existing options. If any of them work for him (price, diet, no veto, and he can make the meet time), he votes on those. Otherwise everyone is polled again.
5. If the plan is already confirmed (`joinConfirmed`), he gets the plan with his own leave time.

### 6e. Round 2: proposal and evaluation (`runRounds`)

1. **Ceiling** = the lowest `maxPrice` across members. It is never relaxed.
2. **Candidates** (`candidatePlaces`):
   - searches Places around the average of everyone's rounded areas, with a radius of the largest distance from that center plus 8 km
   - drops places above the ceiling, places that fail any member's diet, places this exact crew visited in the last 14 days, and places not open for 75 minutes at some point in the window
   - keeps at most 20
3. The coordinator sends a **Proposal** (the list of places) to every agent. Each `PersonalAgent.evaluate()` works privately:
   - travel time from the person's **exact** location, through Routes
   - walk or drive (`chooseTravel`)
   - `fit = clamp(0.5 + taste/2 + (0.2 if they rated this place +1), 0, 1)`
   - `veto` = true/false only, with **no reason**. It covers vetoes, dislikes, and places rated −1 in the last 60 days.
4. **`rankGroup`** (`engines/ranking.ts`):
   - **Hard filters:**
     - price ≤ ceiling, diet OK, nobody vetoed it
     - longest travel ≤ 35 min, and the gap between the longest and shortest travel ≤ 25 min
     - meet time ≤ end of the window
     - open from the meet time for 75 minutes
   - **Meet time** (`engines/arrival.ts`):
     - each person leaves at `max(now, freeAt)` and arrives at `leave + travel`
     - `meet` = the latest arrival, rounded up to the next 5 minutes (and never before the window opens)
     - each person's leave time is `meet − travel`
   - **Score** (lower is better): `1.0·(minutes later than the earliest option) + 0.3·total travel + 0.7·gap − 20·average fit − novelty (3 if the crew hasn't been there in 60 days)`.
   - **Top three with different cuisines.** If fewer than three pass, the limits are loosened one at a time: no gap cap → travel cap of 45 min → cuisines may repeat → window extended by 30 min. The header changes to match, for example "Nothing closer fit everyone, so some drives are longer:".
   - If nothing passes even after loosening, the plan is cancelled and Foodie says "Nothing fits everyone tonight…"

### 6f. Voting

- **The organizer** gets a header plus three lines, then a poll. Example: `Thai place · 6:30 · ~$14 · 30 min drive`.
- **Members** get "Options are in. Vote:" and a poll labeled with **their own** travel times.
- **The ceiling note.** Whoever's max set the ceiling hears "Kept it under $15 for you." This message goes only to them.
- If poll sending fails, Foodie sends a numbered list instead ("Reply 1, 2 or 3."). With `GROUP_CHAT_MODE=1` on a dedicated line, one poll goes into a real group chat.
- **Closing the vote.** The vote closes when everyone has voted, or when the 10-minute `poll_close` job fires. Ties go to the organizer's vote, then to the best score.
- **Changes mid-vote.** If someone drops out, changes their time, or vetoes a listed option during the vote, everything is re-run and the header says "Times changed:".

### 6g. Confirming and booking

`confirm()` does the following:

- sets the plan to `confirmed` and records crew history
- for each member, their own agent:
  - learns from their vote (if they voted for the winner)
  - records the visit
  - writes an event to **their own** Google Calendar
- members get "Thai place at 6:30. Leave at 6:00, it's on your calendar." Foodie only says "it's on your calendar" when the event was actually created.
- the organizer gets "Thai place at 6:30 it is. Tap to book a table for 3: <url>. Booked?"
- schedules four jobs, timed from the meet time:
  - `late_watch` from 30 minutes before
  - `after_meal` at +90 minutes
  - `split_check` at +95 minutes
  - `plan_done` at +180 minutes

The organizer then replies:

- **"booked"** → `markBooked`. Everyone gets "Table's booked under Ronald."
- **"can't book" / "closed"** → `bookingFailed`. Foodie offers the next option: "Pizza spot at 6:35 instead? yes/no". Saying yes confirms it again with "Change of plan: …".

## 7. After the meal (`src/flows/after.ts`)

- **Running late.** Every 2 minutes, the watcher reads each sharing member's Find My location:
  - within 150 m of the restaurant counts as arrived
  - otherwise Routes estimates their ETA
  - if they're more than 5 minutes late, and at least 5 minutes later than the last alert, everyone else gets "Clive's about 8 min behind, now 6:38."

  Only the ETA is shared, never the location. In the demo, `/late clive 8` triggers this instead.
- **Feedback.** Everyone gets "How was the Thai place?" A tapback or a text reply feeds back into memory:
  - positive: the place is rated +1 and its cuisine gets +0.2 taste
  - negative: the place is rated −1 and hidden for 60 days
- **Bill split.** `split_check` looks through members' Nessie purchases from that day for a merchant whose name matches the restaurant or that is within 150 m of it.
  - If it finds one, the payer gets "Saw $52 at the Thai place. Split 3 ways, $17.33 each?"
  - If not, the organizer is asked "Who paid?" and then "How much was dinner?"
  - Once the payer says yes, each other member gets "Ronald covered dinner, your share is $17.33. Send it?" Saying yes makes a Nessie transfer (sandbox money only). Foodie says "Sent." only if the transfer succeeds, and the payer is told.
  - Members who can't transfer get "Paid another way? Reply 'paid'."

## 8. Budget engine (`src/engines/budget.ts`)

With a bank connected:

```
remaining  = monthlyLimit − restaurant spend this month
mealsLeft  = max(1, mealsPerWeek × days left in month / 7)
target     = clamp(remaining / mealsLeft × weight, $8, mealCap)    weight: lunch 0.8, dinner 1.2
hardMax    = min(mealCap, round(target × 1.3))
```

- **Treat night** sets both target and hardMax to the override amount, which may be above the meal cap.
- **Keep it cheap** caps both at the override amount.
- **Without a bank**, hardMax is simply the stated max per meal.
- **With no budget at all**, the agent reports a max price of $999, so it doesn't constrain anything.

## 9. Plumbing that holds it together

- **`clock.ts`** is the only source of "now": real time plus an offset stored in the database. `/clock 17:50` moves every timer consistently.
- **`scheduler.ts`** stores every timer as a row in `jobs`: poll closing, nudges, late watching, feedback, the split. They survive a restart.
- **Locks** (`lib/mutex.ts`) are in-process, keyed by `user:<handle>`, `plan:<id>`, `late:<id>` and `split:<id>`. This is safe with one server process but not with several.
- **`messaging.ts`** has one transport per channel: `imessage`, `terminal` or `sim`. Each user's messages go to the conversation and line stored on their user row.
- **Demo mode** uses fixed data so runs are repeatable:
  - Places returns ten fixed restaurants
  - Routes uses a fixed table of travel times
  - free/busy is mocked for the seeded people
- **Sim** (`bun run sim`) drives the real router, agents and coordinator through an in-memory transport. It checks every reply word for word against the expected transcripts in `src/sim/scenarios.ts`.

## Example walkthrough

The demo's main scenario, end to end:

1. Ronald texts "dinner with Clive and Eric". Clive is found in his contacts; Eric gets an invite link.
2. Clive's agent invites him using his calendar. He replies "in".
3. Eric taps the link, sets up, and shares his location.
4. All three agents send their limited constraints.
5. The coordinator searches for places, and each agent scores them privately.
6. The ranking picks three options, and everyone gets a poll.
7. The vote closes. Each person gets a calendar event and their own leave time.
8. Ronald confirms the booking.
9. Foodie watches for anyone running late, asks how dinner was, and offers to split the bill.
