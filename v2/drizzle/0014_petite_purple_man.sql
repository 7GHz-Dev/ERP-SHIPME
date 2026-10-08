CREATE TABLE "meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"inspect_date" text NOT NULL,
	"username" "citext" NOT NULL,
	"driver_id" text NOT NULL,
	"phase" text NOT NULL,
	"mode" text NOT NULL,
	"meeting_point_id" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"scheduled_at" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"item_ids_json" text DEFAULT '[]' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"response_note" text DEFAULT '' NOT NULL,
	"responded_at" text DEFAULT '' NOT NULL,
	"route_run_id" text DEFAULT '' NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"inspect_date" text NOT NULL,
	"username" "citext" NOT NULL,
	"phase" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"result_json" text NOT NULL,
	"created_at" text NOT NULL,
	"confirmed_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "line_user_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "line_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "line_notify" text DEFAULT 'important' NOT NULL;--> statement-breakpoint
CREATE INDEX "meetings_batch_idx" ON "meetings" USING btree ("inspect_date","username","phase");--> statement-breakpoint
CREATE INDEX "meetings_driver_idx" ON "meetings" USING btree ("driver_id","inspect_date");--> statement-breakpoint
CREATE INDEX "route_runs_batch_idx" ON "route_runs" USING btree ("inspect_date","username");