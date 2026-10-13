ALTER TABLE "meetings" ADD COLUMN "arrived_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "arrived_lat" double precision;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "arrived_lng" double precision;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "arrived_accuracy_m" double precision;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "arrived_distance_m" double precision;