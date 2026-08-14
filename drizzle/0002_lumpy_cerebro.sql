CREATE TABLE `api_rate_limits` (
	`key` text NOT NULL,
	`bucket` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`key`, `bucket`)
);
--> statement-breakpoint
CREATE INDEX `idx_api_rate_limits_expiry` ON `api_rate_limits` (`expires_at`);
--> statement-breakpoint
UPDATE `team_usage_logs` SET `task` = '[redacted]';
