CREATE TABLE "service_invoices" (
	"number" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"seq" integer NOT NULL,
	"issue_date" text NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'inspect' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"range_from" text DEFAULT '' NOT NULL,
	"range_to" text DEFAULT '' NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"customer_address" text DEFAULT '' NOT NULL,
	"customer_tax_id" text DEFAULT '' NOT NULL,
	"items_json" text NOT NULL,
	"summary_json" text DEFAULT '' NOT NULL,
	"subtotal" double precision DEFAULT 0 NOT NULL,
	"vat" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"withholding" double precision DEFAULT 0 NOT NULL,
	"net_total" double precision DEFAULT 0 NOT NULL,
	"prepared_by" text DEFAULT '' NOT NULL,
	"paid_amount" double precision DEFAULT 0 NOT NULL,
	"paid_at" text DEFAULT '' NOT NULL,
	"receipt_no" text DEFAULT '' NOT NULL,
	"receipt_date" text DEFAULT '' NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "service_invoices_issue_idx" ON "service_invoices" USING btree ("issue_date");--> statement-breakpoint
CREATE UNIQUE INDEX "service_invoices_receipt_idx" ON "service_invoices" USING btree ("receipt_no") WHERE "service_invoices"."receipt_no" <> '';