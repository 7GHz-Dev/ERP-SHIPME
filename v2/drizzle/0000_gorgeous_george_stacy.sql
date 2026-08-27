CREATE TABLE "app_options" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkins" (
	"id" text PRIMARY KEY NOT NULL,
	"server_time" text NOT NULL,
	"local_date" text NOT NULL,
	"device_time" text DEFAULT '' NOT NULL,
	"username" "citext" NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_m" double precision DEFAULT 0 NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"map_link" text DEFAULT '' NOT NULL,
	"photo_url" text DEFAULT '' NOT NULL,
	"photo_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_rates" (
	"key" text PRIMARY KEY NOT NULL,
	"rate" double precision DEFAULT 0 NOT NULL,
	"reasons_json" text DEFAULT '[]' NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"username" "citext" NOT NULL,
	"name" text NOT NULL,
	"inspect_date" text NOT NULL,
	"containers" integer NOT NULL,
	"total" double precision NOT NULL,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"items_json" text NOT NULL,
	"detail" text NOT NULL,
	"detail_all" text NOT NULL,
	"detail_first" text NOT NULL,
	"edit_details_json" text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geocode_cache" (
	"point" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaves" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL,
	"username" "citext" NOT NULL,
	"name" text NOT NULL,
	"leave_type" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"days" integer NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text DEFAULT '' NOT NULL,
	"decided_at" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"server_time" text NOT NULL,
	"device_time" text DEFAULT '' NOT NULL,
	"username" "citext" NOT NULL,
	"name" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_m" double precision DEFAULT 0 NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"map_link" text DEFAULT '' NOT NULL,
	"photo_url" text NOT NULL,
	"photo_id" text NOT NULL,
	"inspect_date" text NOT NULL,
	"retake_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"username" "citext" NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"device" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settle_rates" (
	"key" text PRIMARY KEY NOT NULL,
	"rate" double precision DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"username" "citext" NOT NULL,
	"name" text NOT NULL,
	"inspect_date" text NOT NULL,
	"claim_total" double precision NOT NULL,
	"total_expense" double precision NOT NULL,
	"balance" double precision NOT NULL,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"returned_date" text DEFAULT '' NOT NULL,
	"company_returned_date" text DEFAULT '' NOT NULL,
	"rows_json" text NOT NULL,
	"detail" text NOT NULL,
	"image_url" text DEFAULT '' NOT NULL,
	"slip_url" text DEFAULT '' NOT NULL,
	"slip_txn" text DEFAULT '' NOT NULL,
	"slip_amount" double precision DEFAULT 0 NOT NULL,
	"slip_date" text DEFAULT '' NOT NULL,
	"slip_status" text DEFAULT '' NOT NULL,
	"slip_bank" text DEFAULT '' NOT NULL,
	"legacy_duplicate" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slips" (
	"id" text PRIMARY KEY NOT NULL,
	"username" "citext" NOT NULL,
	"uploaded_at" text NOT NULL,
	"file_name" text NOT NULL,
	"url" text NOT NULL,
	"info_json" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transport_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"transport_date" text NOT NULL,
	"shipping" text DEFAULT '' NOT NULL,
	"bl" text DEFAULT '' NOT NULL,
	"container_no" text DEFAULT '' NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"port" text DEFAULT '' NOT NULL,
	"customer" text DEFAULT '' NOT NULL,
	"source_file" text DEFAULT '' NOT NULL,
	"source_sheet" text DEFAULT '' NOT NULL,
	"source_name" text DEFAULT '' NOT NULL,
	"imported_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"username" "citext" PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"shipping_code" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "leaves" ADD CONSTRAINT "leaves_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "slips" ADD CONSTRAINT "slips_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "checkins_user_date_idx" ON "checkins" USING btree ("username","local_date");--> statement-breakpoint
CREATE INDEX "checkins_time_idx" ON "checkins" USING btree ("server_time" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "claims_user_date_idx" ON "claims" USING btree ("username","inspect_date");--> statement-breakpoint
CREATE INDEX "claims_user_idx" ON "claims" USING btree ("username","inspect_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leaves_user_idx" ON "leaves" USING btree ("username","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_user_date_idx" ON "receipts" USING btree ("username","inspect_date");--> statement-breakpoint
CREATE INDEX "receipts_time_idx" ON "receipts" USING btree ("server_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("username","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_slip_txn_idx" ON "settlements" USING btree (upper("slip_txn")) WHERE "settlements"."slip_txn" <> '' and "settlements"."legacy_duplicate" = false;--> statement-breakpoint
CREATE INDEX "settlements_user_idx" ON "settlements" USING btree ("username","inspect_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transport_lookup_idx" ON "transport_jobs" USING btree ("transport_date","shipping");