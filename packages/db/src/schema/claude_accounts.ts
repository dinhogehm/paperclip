import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Company-scoped Claude subscription profiles.
 *
 * OAuth credentials remain on the Paperclip host in isolated Claude config
 * directories. Postgres stores only control-plane metadata and assignments.
 */
export const claudeAccounts = pgTable(
  "claude_accounts",
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
    companyIdx: index("claude_accounts_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("claude_accounts_company_name_uq").on(table.companyId, table.name),
  }),
);
