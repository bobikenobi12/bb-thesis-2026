ALTER TABLE "cli_logins" ADD COLUMN "user_code" text;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD COLUMN "client_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD COLUMN "request_ip" text;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD COLUMN "denied_at" timestamp with time zone;