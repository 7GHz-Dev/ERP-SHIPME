CREATE TABLE "transport_sync_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transport_sync_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"synced_at" text NOT NULL,
	"source_file" text DEFAULT '' NOT NULL,
	"source_sheet" text DEFAULT '' NOT NULL,
	"rows_before" integer DEFAULT 0 NOT NULL,
	"rows_after" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"added_bls" text DEFAULT '[]' NOT NULL,
	"removed_bls" text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "transport_sync_logs_idx" ON "transport_sync_logs" USING btree ("synced_at");