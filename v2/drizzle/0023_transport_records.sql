CREATE TABLE "transport_records" (
	"id" text PRIMARY KEY NOT NULL,
	"transport_date" text NOT NULL,
	"source" text DEFAULT 'MAESOT FREEZONE' NOT NULL,
	"customer" text DEFAULT '' NOT NULL,
	"vessel" text DEFAULT '' NOT NULL,
	"vessel_name" text DEFAULT '' NOT NULL,
	"bl" text NOT NULL,
	"bl_key" text NOT NULL,
	"containers_json" text DEFAULT '[]' NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"port" text DEFAULT '' NOT NULL,
	"username" "citext" DEFAULT '' NOT NULL,
	"do_fee" double precision DEFAULT 0 NOT NULL,
	"dem" double precision DEFAULT 0 NOT NULL,
	"extra_movement" double precision DEFAULT 0 NOT NULL,
	"storage" double precision DEFAULT 0 NOT NULL,
	"lift_on" double precision DEFAULT 0 NOT NULL,
	"lift_off" double precision DEFAULT 0 NOT NULL,
	"overtime" double precision DEFAULT 0 NOT NULL,
	"seal_fee" double precision DEFAULT 0 NOT NULL,
	"prb" double precision DEFAULT 0 NOT NULL,
	"prb_service" double precision DEFAULT 0 NOT NULL,
	"detention" double precision DEFAULT 0 NOT NULL,
	"repair_fee" double precision DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"doc_sent_date" text DEFAULT '' NOT NULL,
	"imported_from" text DEFAULT '' NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_by" "citext" DEFAULT '' NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "transport_records_bl_date_idx" ON "transport_records" USING btree ("bl_key","transport_date");--> statement-breakpoint
CREATE INDEX "transport_records_date_idx" ON "transport_records" USING btree ("transport_date");--> statement-breakpoint
ALTER TABLE "transport_records" ENABLE ROW LEVEL SECURITY;