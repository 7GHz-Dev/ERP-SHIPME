CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_date" text NOT NULL,
	"direction" text NOT NULL,
	"description" text NOT NULL,
	"qty" double precision DEFAULT 1 NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"vat" double precision DEFAULT 0 NOT NULL,
	"wht_type" text DEFAULT '' NOT NULL,
	"wht_rate" double precision DEFAULT 0 NOT NULL,
	"wht" double precision DEFAULT 0 NOT NULL,
	"net" double precision DEFAULT 0 NOT NULL,
	"pay_method" text DEFAULT '' NOT NULL,
	"pay_ref" text DEFAULT '' NOT NULL,
	"party" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"voucher_no" text DEFAULT '' NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_by" "citext" DEFAULT '' NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_vouchers" (
	"number" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"seq" integer NOT NULL,
	"voucher_date" text NOT NULL,
	"party" text DEFAULT '' NOT NULL,
	"pay_method" text DEFAULT '' NOT NULL,
	"pay_ref" text DEFAULT '' NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"vat" double precision DEFAULT 0 NOT NULL,
	"wht" double precision DEFAULT 0 NOT NULL,
	"net" double precision DEFAULT 0 NOT NULL,
	"prepared_by" text DEFAULT '' NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ledger_entries_date_idx" ON "ledger_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE INDEX "ledger_entries_voucher_idx" ON "ledger_entries" USING btree ("voucher_no");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_vouchers_seq_idx" ON "ledger_vouchers" USING btree ("kind","period","seq");--> statement-breakpoint
ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ledger_vouchers" ENABLE ROW LEVEL SECURITY;