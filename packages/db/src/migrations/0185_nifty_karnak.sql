ALTER TABLE "agents" ADD COLUMN "codex_account_mode" text DEFAULT 'host' NOT NULL;
--> statement-breakpoint
UPDATE "agents" SET "codex_account_mode" = 'fixed' WHERE "codex_account_id" IS NOT NULL;
