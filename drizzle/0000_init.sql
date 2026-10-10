CREATE TABLE "agent_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"from" text NOT NULL,
	"to" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"nicknames" text[] DEFAULT '{}' NOT NULL,
	"handles" text[] DEFAULT '{}' NOT NULL,
	"foodie_user_id" text
);
--> statement-breakpoint
CREATE TABLE "crew_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"crew_key" text NOT NULL,
	"place_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crews" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"member_ids" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"code" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"inviter_id" text NOT NULL,
	"invitee_name" text NOT NULL,
	"invitee_handle" text,
	"contact_id" integer,
	"used_by" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending" (
	"user_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"plan_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "place_memory" (
	"user_id" text NOT NULL,
	"place_id" text NOT NULL,
	"name" text NOT NULL,
	"cuisine" text NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL,
	"last_visit" timestamp with time zone,
	"rating" integer DEFAULT 0 NOT NULL,
	"rated_at" timestamp with time zone,
	CONSTRAINT "place_memory_user_id_place_id_pk" PRIMARY KEY("user_id","place_id")
);
--> statement-breakpoint
CREATE TABLE "plan_members" (
	"plan_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"vote" text,
	"leave_at" timestamp with time zone,
	"eta" timestamp with time zone,
	"travel_mode" text,
	"travel_min" integer,
	"constraints" jsonb,
	"calendar_event_id" text,
	"late_notified_min" integer,
	"arrived" boolean DEFAULT false NOT NULL,
	"lead" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_members_plan_id_user_id_pk" PRIMARY KEY("plan_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"organizer_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"meal" text DEFAULT 'dinner' NOT NULL,
	"window_earliest" timestamp with time zone,
	"window_latest" timestamp with time zone,
	"meet_time" timestamp with time zone,
	"place_id" text,
	"place" jsonb,
	"options" jsonb,
	"runner_ups" jsonb,
	"booked" boolean DEFAULT false NOT NULL,
	"poll_closes_at" timestamp with time zone,
	"crew_key" text,
	"nudged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_message_id" text,
	"option_place_ids" text[] NOT NULL,
	"option_titles" text[] NOT NULL,
	"open" boolean DEFAULT true NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sent_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"purpose" text NOT NULL,
	"plan_id" text,
	"place_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "split_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"split_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'asked' NOT NULL,
	"nessie_transfer_id" text
);
--> statement-breakpoint
CREATE TABLE "splits" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"payer_id" text NOT NULL,
	"total_cents" integer NOT NULL,
	"nessie_purchase_id" text,
	"status" text DEFAULT 'proposed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taste" (
	"user_id" text NOT NULL,
	"cuisine" text NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	CONSTRAINT "taste_user_id_cuisine_pk" PRIMARY KEY("user_id","cuisine")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"handles" text[] DEFAULT '{}' NOT NULL,
	"channel" text DEFAULT 'imessage' NOT NULL,
	"space_id" text,
	"foodie_line" text,
	"google_tokens" text,
	"google_email" text,
	"nessie_customer_id" text,
	"nessie_account_id" text,
	"diet_tags" text[] DEFAULT '{}' NOT NULL,
	"dislikes" text[] DEFAULT '{}' NOT NULL,
	"monthly_limit" integer,
	"meal_cap" integer,
	"meals_per_week" real,
	"findmy_status" text DEFAULT 'none' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"location_source" text,
	"location_at" timestamp with time zone,
	"onboarding" text DEFAULT 'new' NOT NULL,
	"link_token" text,
	"link_done_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"demo_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_link_token_unique" UNIQUE("link_token")
);
--> statement-breakpoint
CREATE TABLE "vetoes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"target" text NOT NULL,
	"label" text,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
