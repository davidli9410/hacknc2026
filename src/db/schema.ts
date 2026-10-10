// Data model (spec section 5). Each personal agent owns its user's rows; the coordinator owns plans and plan_members.
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  /** E.164 phones and lowercase emails, plus `term:<space>` for the terminal provider. */
  handles: text("handles").array().notNull().default([]),
  /** Which transport reaches this user: imessage | terminal | sim. */
  channel: text("channel").notNull().default("imessage"),
  /** The provider's conversation id (iMessage chat GUID, terminal space id). */
  spaceId: text("space_id"),
  /** The Photon line (phone) this user talks to. */
  foodieLine: text("foodie_line"),
  googleTokens: text("google_tokens"),
  googleEmail: text("google_email"),
  nessieCustomerId: text("nessie_customer_id"),
  nessieAccountId: text("nessie_account_id"),
  dietTags: text("diet_tags").array().notNull().default([]),
  dislikes: text("dislikes").array().notNull().default([]),
  monthlyLimit: integer("monthly_limit"),
  mealCap: integer("meal_cap"),
  mealsPerWeek: real("meals_per_week"),
  /** none | requested | sharing | declined */
  findmyStatus: text("findmy_status").notNull().default("none"),
  /** Exact location. Private to this user's agent; never leaves it. */
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  /** seed | findmy | text */
  locationSource: text("location_source"),
  locationAt: ts("location_at"),
  /** new | asked_diet | link_sent | asked_max | card_sent | asked_budget | done */
  onboarding: text("onboarding").notNull().default("new"),
  linkToken: text("link_token").unique(),
  linkDoneAt: ts("link_done_at"),
  paused: boolean("paused").notNull().default(false),
  /** DEMO=1 only: which seeded person this is (organizer | member | newcomer). */
  demoKey: text("demo_key"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  nicknames: text("nicknames").array().notNull().default([]),
  handles: text("handles").array().notNull().default([]),
  foodieUserId: text("foodie_user_id"),
});

export const crews = pgTable("crews", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  memberIds: text("member_ids").array().notNull().default([]),
});

export type PlaceSnapshot = {
  placeId: string;
  name: string;
  /** How Foodie refers to it in a sentence: "the Thai place", "Cosmic Cantina". */
  refName: string;
  /** Short poll label: "Thai". */
  shortName: string;
  lat: number;
  lng: number;
  priceEach: number;
  cuisine: string;
  mapsUrl: string;
  bookingUrl: string;
  /** Kept so a late joiner's diet can be checked against the same options. */
  primaryType?: string;
  types?: string[];
  servesVegetarianFood?: boolean;
};

export type PlanOption = {
  place: PlaceSnapshot;
  meet: string;
  arrivals: { userId: string; leaveAt: string; travelMin: number; mode: "walk" | "drive" }[];
  score: number;
};

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  organizerId: text("organizer_id").notNull(),
  /** solo | group */
  kind: text("kind").notNull(),
  /** solo: choosing | chosen | done. group: gathering | voting | confirmed | done | cancelled */
  status: text("status").notNull(),
  meal: text("meal").notNull().default("dinner"),
  windowEarliest: ts("window_earliest"),
  windowLatest: ts("window_latest"),
  meetTime: ts("meet_time"),
  placeId: text("place_id"),
  place: jsonb("place").$type<PlaceSnapshot>(),
  options: jsonb("options").$type<PlanOption[]>(),
  runnerUps: jsonb("runner_ups").$type<PlanOption[]>(),
  booked: boolean("booked").notNull().default(false),
  pollClosesAt: ts("poll_closes_at"),
  crewKey: text("crew_key"),
  nudged: boolean("nudged").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const planMembers = pgTable(
  "plan_members",
  {
    planId: text("plan_id").notNull(),
    userId: text("user_id").notNull(),
    /** organizer | member */
    role: text("role").notNull().default("member"),
    /** invited | in | out */
    status: text("status").notNull().default("invited"),
    vote: text("vote"),
    leaveAt: ts("leave_at"),
    eta: ts("eta"),
    travelMode: text("travel_mode"),
    travelMin: integer("travel_min"),
    /** Round 1 answer, as received by the coordinator. */
    constraints: jsonb("constraints"),
    calendarEventId: text("calendar_event_id"),
    lateNotifiedMin: integer("late_notified_min"),
    arrived: boolean("arrived").notNull().default(false),
    /** Text to put in front of this member's next options message ("You're set and free at 6:00."). */
    lead: text("lead"),
    /** Invite order, so names read back the way the organizer said them. */
    addedAt: ts("added_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.planId, t.userId] })],
);

export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  planId: text("plan_id").notNull(),
  inviterId: text("inviter_id").notNull(),
  inviteeName: text("invitee_name").notNull(),
  inviteeHandle: text("invitee_handle"),
  contactId: integer("contact_id"),
  usedBy: text("used_by"),
  expiresAt: ts("expires_at").notNull(),
});

export const polls = pgTable("polls", {
  id: serial("id").primaryKey(),
  planId: text("plan_id").notNull(),
  userId: text("user_id").notNull(),
  providerMessageId: text("provider_message_id"),
  optionPlaceIds: text("option_place_ids").array().notNull(),
  optionTitles: text("option_titles").array().notNull(),
  open: boolean("open").notNull().default(true),
  sentAt: ts("sent_at").notNull().defaultNow(),
});

export const pending = pgTable("pending", {
  userId: text("user_id").primaryKey(),
  kind: text("kind").notNull(),
  planId: text("plan_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: ts("expires_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  runAt: ts("run_at").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  /** queued | done | failed | cancelled */
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
});

export const placeMemory = pgTable(
  "place_memory",
  {
    userId: text("user_id").notNull(),
    placeId: text("place_id").notNull(),
    name: text("name").notNull(),
    cuisine: text("cuisine").notNull(),
    visits: integer("visits").notNull().default(0),
    lastVisit: ts("last_visit"),
    /** -1, 0, 1 */
    rating: integer("rating").notNull().default(0),
    ratedAt: ts("rated_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.placeId] })],
);

export const taste = pgTable(
  "taste",
  {
    userId: text("user_id").notNull(),
    cuisine: text("cuisine").notNull(),
    score: real("score").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.cuisine] })],
);

export const vetoes = pgTable("vetoes", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** place | cuisine */
  scope: text("scope").notNull(),
  /** place id, or lowercase cuisine */
  target: text("target").notNull(),
  label: text("label"),
  /** soft | never */
  kind: text("kind").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at"),
});

export const overrides = pgTable("overrides", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** YYYY-MM-DD in TIMEZONE */
  date: text("date").notNull(),
  /** treat | cheap */
  kind: text("kind").notNull(),
  amount: integer("amount").notNull(),
});

export const crewHistory = pgTable("crew_history", {
  id: serial("id").primaryKey(),
  crewKey: text("crew_key").notNull(),
  placeId: text("place_id").notNull(),
  at: ts("at").notNull(),
});

export const splits = pgTable("splits", {
  id: serial("id").primaryKey(),
  planId: text("plan_id").notNull(),
  payerId: text("payer_id").notNull(),
  totalCents: integer("total_cents").notNull(),
  nessiePurchaseId: text("nessie_purchase_id"),
  /** proposed | confirmed | declined */
  status: text("status").notNull().default("proposed"),
});

export const splitShares = pgTable("split_shares", {
  id: serial("id").primaryKey(),
  splitId: integer("split_id").notNull(),
  userId: text("user_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  /** asked | sent | paid_other | failed */
  status: text("status").notNull().default("asked"),
  nessieTransferId: text("nessie_transfer_id"),
});

export const agentMessages = pgTable("agent_messages", {
  id: serial("id").primaryKey(),
  planId: text("plan_id").notNull(),
  from: text("from").notNull(),
  to: text("to").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  at: ts("at").notNull().defaultNow(),
});

/** Outbound messages worth remembering, so a tapback on them means something. */
export const sentMessages = pgTable("sent_messages", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  /** feedback | options | other */
  purpose: text("purpose").notNull(),
  planId: text("plan_id"),
  placeId: text("place_id"),
  at: ts("at").notNull().defaultNow(),
});
