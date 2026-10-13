CREATE TABLE "driver_signup_links" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "source" text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "created_by" "citext" DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "note" text DEFAULT '' NOT NULL;