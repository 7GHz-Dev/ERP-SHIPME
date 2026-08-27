DROP INDEX "settlements_user_idx";--> statement-breakpoint
DROP INDEX "settlements_slip_txn_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_new_date_idx" ON "settlements" USING btree ("username","inspect_date") WHERE "settlements"."legacy_duplicate" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_slip_txn_idx" ON "settlements" USING btree (upper("slip_txn")) WHERE "settlements"."slip_txn" <> '';