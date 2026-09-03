CREATE TABLE "invoices" (
	"number" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"seq" integer NOT NULL,
	"issue_date" text NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"customer_address" text DEFAULT '' NOT NULL,
	"customer_tax_id" text DEFAULT '' NOT NULL,
	"bl" text DEFAULT '' NOT NULL,
	"items_json" text NOT NULL,
	"subtotal" double precision DEFAULT 0 NOT NULL,
	"vat" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"withholding" double precision DEFAULT 0 NOT NULL,
	"net_total" double precision DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"prepared_by" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" text DEFAULT '' NOT NULL,
	"approved_at" text DEFAULT '' NOT NULL,
	"settlement_id" text DEFAULT '' NOT NULL,
	"created_by" "citext" NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "do_fee" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_username_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("username") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "invoices_period_idx" ON "invoices" USING btree ("kind","period","seq");--> statement-breakpoint
CREATE INDEX "invoices_created_idx" ON "invoices" USING btree ("created_by","issue_date");