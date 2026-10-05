CREATE TABLE "inspection_files" (
	"id" text PRIMARY KEY NOT NULL,
	"username" "citext" NOT NULL,
	"inspect_date" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"url" text NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'docscan' NOT NULL,
	"created_at" text NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspection_files" ADD CONSTRAINT "inspection_files_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "inspection_files_user_date_idx" ON "inspection_files" USING btree ("username","inspect_date");