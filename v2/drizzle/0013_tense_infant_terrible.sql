CREATE TABLE "driver_link_invites" (
	"code" text PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text DEFAULT '' NOT NULL,
	"used_line_user_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"phone" text NOT NULL,
	"plate" text DEFAULT '' NOT NULL,
	"line_user_id" text DEFAULT '' NOT NULL,
	"line_name" text DEFAULT '' NOT NULL,
	"line_picture" text DEFAULT '' NOT NULL,
	"line_linked_at" text DEFAULT '' NOT NULL,
	"line_friend" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_files" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"inspect_date" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"url" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"inspect_date" text NOT NULL,
	"username" "citext" DEFAULT '' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text DEFAULT '' NOT NULL,
	"event" text NOT NULL,
	"meta_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_steps" (
	"item_id" text PRIMARY KEY NOT NULL,
	"inspect_date" text NOT NULL,
	"username" "citext" NOT NULL,
	"driver_id" text DEFAULT '' NOT NULL,
	"card_handed_at" text DEFAULT '' NOT NULL,
	"card_handed_by" "citext" DEFAULT '' NOT NULL,
	"card_ack_at" text DEFAULT '' NOT NULL,
	"picked_up_at" text DEFAULT '' NOT NULL,
	"xray_status" text DEFAULT 'pending' NOT NULL,
	"xray_at" text DEFAULT '' NOT NULL,
	"xray_note" text DEFAULT '' NOT NULL,
	"eir_handed_at" text DEFAULT '' NOT NULL,
	"eir_handed_by" "citext" DEFAULT '' NOT NULL,
	"eir_received_at" text DEFAULT '' NOT NULL,
	"completed_at" text DEFAULT '' NOT NULL,
	"problem" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"line_user_id" text NOT NULL,
	"driver_id" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"payload_json" text NOT NULL,
	"retry_key" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"sent_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"phase" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy_m" double precision DEFAULT 0 NOT NULL,
	"captured_at" text NOT NULL,
	"received_at" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"inspect_date" text NOT NULL,
	"username" "citext" NOT NULL,
	"driver_id" text NOT NULL,
	"phase" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"item_ids_json" text DEFAULT '[]' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"requested_by" "citext" DEFAULT '' NOT NULL,
	"requested_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"responded_at" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_points" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"port" text DEFAULT '' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" "citext" DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "driver_link_invites" ADD CONSTRAINT "driver_link_invites_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_reports" ADD CONSTRAINT "location_reports_request_id_location_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."location_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_requests" ADD CONSTRAINT "location_requests_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_phone_idx" ON "drivers" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_line_idx" ON "drivers" USING btree ("line_user_id") WHERE "drivers"."line_user_id" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_files_key_idx" ON "evidence_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "evidence_files_item_idx" ON "evidence_files" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "job_events_item_idx" ON "job_events" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "job_events_batch_idx" ON "job_events" USING btree ("inspect_date","username");--> statement-breakpoint
CREATE INDEX "job_steps_batch_idx" ON "job_steps" USING btree ("inspect_date","username");--> statement-breakpoint
CREATE INDEX "job_steps_driver_idx" ON "job_steps" USING btree ("driver_id","inspect_date");--> statement-breakpoint
CREATE UNIQUE INDEX "line_outbox_retry_idx" ON "line_outbox" USING btree ("retry_key");--> statement-breakpoint
CREATE INDEX "line_outbox_driver_idx" ON "line_outbox" USING btree ("driver_id","created_at");--> statement-breakpoint
CREATE INDEX "location_reports_req_idx" ON "location_reports" USING btree ("request_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "location_requests_code_idx" ON "location_requests" USING btree ("code");--> statement-breakpoint
CREATE INDEX "location_requests_batch_idx" ON "location_requests" USING btree ("inspect_date","username","phase");