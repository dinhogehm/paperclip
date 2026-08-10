import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Company-scoped Codex subscription profiles.
 *
 * OAuth credentials are intentionally kept out of Postgres. Each row only
 * stores control-plane metadata; the Codex CLI owns auth.json inside the
 * Paperclip-managed account home on the local instance filesystem.
 */
export const codexAccounts = pgTable(
  "codex_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("codex_accounts_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("codex_accounts_company_name_uq").on(table.companyId, table.name),
  }),
);
