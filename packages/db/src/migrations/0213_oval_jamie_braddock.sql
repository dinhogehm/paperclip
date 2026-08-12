CREATE TABLE "claude_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"last_authenticated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "claude_account_mode" text DEFAULT 'host' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "claude_account_id" uuid;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD CONSTRAINT "claude_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claude_accounts_company_idx" ON "claude_accounts" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claude_accounts_company_name_uq" ON "claude_accounts" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_claude_account_id_claude_accounts_id_fk" FOREIGN KEY ("claude_account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_company_claude_account_idx" ON "agents" USING btree ("company_id","claude_account_id");