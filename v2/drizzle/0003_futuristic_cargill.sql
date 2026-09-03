ALTER TABLE "transport_jobs" ADD COLUMN "vessel" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "dem" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "extra_movement" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "storage" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "lift_on" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "lift_off" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "order_form" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "inspector_fee" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "overtime" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "seal_fee" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "other_fee" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "detention" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "repair_fee" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "driver" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "settled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "doc_sent_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_jobs" ADD COLUMN "invoice_no" text DEFAULT '' NOT NULL;