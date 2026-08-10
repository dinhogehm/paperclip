CREATE TABLE "codex_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"last_authenticated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "codex_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "codex_accounts" ADD CONSTRAINT "codex_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_codex_account_id_codex_accounts_id_fk" FOREIGN KEY ("codex_account_id") REFERENCES "public"."codex_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "codex_accounts_company_idx" ON "codex_accounts" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "codex_accounts_company_name_uq" ON "codex_accounts" USING btree ("company_id","name");
--> statement-breakpoint
CREATE INDEX "agents_company_codex_account_idx" ON "agents" USING btree ("company_id","codex_account_id");
