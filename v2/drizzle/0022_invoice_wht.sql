CREATE TABLE "invoice_wht" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"bl" text NOT NULL,
	"settlement_id" text DEFAULT '' NOT NULL,
	"inspect_date" text DEFAULT '' NOT NULL,
	"seq" integer NOT NULL,
	"cert_no" text DEFAULT '' NOT NULL,
	"cert_date" text NOT NULL,
	"items_json" text NOT NULL,
	"base" double precision DEFAULT 0 NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"created_by" "citext" NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_wht" ADD CONSTRAINT "invoice_wht_invoice_number_invoices_number_fk" FOREIGN KEY ("invoice_number") REFERENCES "public"."invoices"("number") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "invoice_wht_invoice_idx" ON "invoice_wht" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "invoice_wht_date_idx" ON "invoice_wht" USING btree ("cert_date");--> statement-breakpoint
ALTER TABLE "invoice_wht" ENABLE ROW LEVEL SECURITY;