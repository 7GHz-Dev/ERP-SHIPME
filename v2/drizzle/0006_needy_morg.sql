ALTER TABLE "transport_sync_logs" ADD COLUMN "changed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transport_sync_logs" ADD COLUMN "details" text DEFAULT '[]' NOT NULL;