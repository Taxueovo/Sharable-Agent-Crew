import { sql } from "drizzle-orm";
import { index, integer, primaryKey, text, sqliteTable } from "drizzle-orm/sqlite-core";

export const sharedTeams = sqliteTable("shared_teams", {
  id: text("id").primaryKey(),
  teamConfig: text("team_config").notNull(),
  accessCodeHash: text("access_code_hash").notNull(),
  ownerTokenHash: text("owner_token_hash"),
  ownerUserHash: text("owner_user_hash"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const teamUsageLogs = sqliteTable("team_usage_logs", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  task: text("task").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_team_usage_logs_team_created").on(table.teamId, table.createdAt)]);

export const apiRateLimits = sqliteTable("api_rate_limits", {
  key: text("key").notNull(),
  bucket: integer("bucket").notNull(),
  count: integer("count").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
}, (table) => [primaryKey({ columns: [table.key, table.bucket] }), index("idx_api_rate_limits_expiry").on(table.expiresAt)]);
