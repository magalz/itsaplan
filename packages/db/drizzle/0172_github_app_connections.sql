ALTER TABLE "git_provider_connection" ADD COLUMN "auth_type" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "git_provider_connection" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "git_provider_connection" ADD COLUMN "installation_id" text;