CREATE TABLE "driver_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"sms_id" text NOT NULL,
	"inspect_date" text NOT NULL,
	"phone" text NOT NULL,
	"driver_name" text DEFAULT '' NOT NULL,
	"plate" text DEFAULT '' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_m" double precision DEFAULT 0 NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_plan_items" (
	"id" text PRIMARY KEY NOT NULL,
	"inspect_date" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"bl" text DEFAULT '' NOT NULL,
	"container_no" text DEFAULT '' NOT NULL,
	"port" text DEFAULT '' NOT NULL,
	"destination" text DEFAULT '' NOT NULL,
	"customer" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"sheet_shipping" text DEFAULT '' NOT NULL,
	"driver_name" text DEFAULT '' NOT NULL,
	"plate" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"username" "citext" DEFAULT '' NOT NULL,
	"assigned_by" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_plans" (
	"inspect_date" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"driver_file" text DEFAULT '' NOT NULL,
	"confirm_count" integer DEFAULT 0 NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_by" "citext" DEFAULT '' NOT NULL,
	"updated_at" text NOT NULL,
	"confirmed_by" "citext" DEFAULT '' NOT NULL,
	"confirmed_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"port" text DEFAULT '' NOT NULL,
	"port_key" text DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"url" text NOT NULL,
	"width" integer DEFAULT 0 NOT NULL,
	"height" integer DEFAULT 0 NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "port_assignments" (
	"period" text NOT NULL,
	"port_key" text NOT NULL,
	"port" text NOT NULL,
	"username" "citext" NOT NULL,
	"updated_by" "citext" DEFAULT '' NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "port_assignments_period_port_key_pk" PRIMARY KEY("period","port_key")
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"inspect_date" text NOT NULL,
	"item_ids_json" text DEFAULT '[]' NOT NULL,
	"username" "citext" DEFAULT '' NOT NULL,
	"sent_by" "citext" DEFAULT '' NOT NULL,
	"phone" text NOT NULL,
	"driver_name" text DEFAULT '' NOT NULL,
	"plate" text DEFAULT '' NOT NULL,
	"containers" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'appoint' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"with_location" boolean DEFAULT false NOT NULL,
	"map_id" text DEFAULT '' NOT NULL,
	"map_key" text DEFAULT '' NOT NULL,
	"provider" text DEFAULT 'thaibulksms' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_id" text DEFAULT '' NOT NULL,
	"credit" double precision DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"sent_at" text DEFAULT '' NOT NULL,
	"preview_at" text DEFAULT '' NOT NULL,
	"opened_at" text DEFAULT '' NOT NULL,
	"last_opened_at" text DEFAULT '' NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"location_status" text DEFAULT '' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_m" double precision,
	"location_at" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "driver_locations" ADD CONSTRAINT "driver_locations_sms_id_sms_messages_id_fk" FOREIGN KEY ("sms_id") REFERENCES "public"."sms_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_plan_items" ADD CONSTRAINT "job_plan_items_inspect_date_job_plans_inspect_date_fk" FOREIGN KEY ("inspect_date") REFERENCES "public"."job_plans"("inspect_date") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_assignments" ADD CONSTRAINT "port_assignments_username_users_username_fk" FOREIGN KEY ("username") REFERENCES "public"."users"("username") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "driver_locations_phone_idx" ON "driver_locations" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "job_plan_items_date_idx" ON "job_plan_items" USING btree ("inspect_date","seq");--> statement-breakpoint
CREATE INDEX "job_plan_items_user_idx" ON "job_plan_items" USING btree ("username","inspect_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_messages_code_idx" ON "sms_messages" USING btree ("code") WHERE "sms_messages"."code" <> '';--> statement-breakpoint
CREATE INDEX "sms_messages_date_idx" ON "sms_messages" USING btree ("inspect_date","username");