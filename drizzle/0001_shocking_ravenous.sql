CREATE TABLE `team_usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`task` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_team_usage_logs_team_created` ON `team_usage_logs` (`team_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `shared_teams` ADD `owner_token_hash` text;--> statement-breakpoint
ALTER TABLE `shared_teams` ADD `expires_at` text;--> statement-breakpoint
ALTER TABLE `shared_teams` ADD `revoked_at` text;