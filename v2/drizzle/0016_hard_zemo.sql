CREATE TABLE "shipping_asks" (
	"id" text PRIMARY KEY NOT NULL,
	"inspect_date" text NOT NULL,
	"username" "citext" NOT NULL,
	"asked_by" "citext" NOT NULL,
	"asked_at" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"send_state" text NOT NULL,
	"send_error" text DEFAULT '' NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"answer_note" text DEFAULT '' NOT NULL,
	"answered_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "shipping_asks_date_idx" ON "shipping_asks" USING btree ("inspect_date","username");--> statement-breakpoint
CREATE INDEX "shipping_asks_user_idx" ON "shipping_asks" USING btree ("username","asked_at");