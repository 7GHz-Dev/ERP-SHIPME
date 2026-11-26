CREATE TABLE "transport_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"bl" text NOT NULL,
	"bl_key" text NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"mime" text DEFAULT 'application/pdf' NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"kola_job_id" text DEFAULT '' NOT NULL,
	"declaration_no" text DEFAULT '' NOT NULL,
	"uploaded_by" text DEFAULT '' NOT NULL,
	"uploaded_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "transport_docs_bl_idx" ON "transport_docs" USING btree ("bl_key","kind","current");--> statement-breakpoint
CREATE INDEX "transport_docs_at_idx" ON "transport_docs" USING btree ("uploaded_at");--> statement-breakpoint
ALTER TABLE "transport_docs" ENABLE ROW LEVEL SECURITY;