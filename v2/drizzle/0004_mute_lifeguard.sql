ALTER TABLE "invoices" ADD COLUMN "batch_no" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "batch_period" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "batch_sent_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sent_to_kola" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_amount" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "receipt_no" text DEFAULT '' NOT NULL;