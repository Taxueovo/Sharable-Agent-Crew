CREATE TABLE `shared_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`team_config` text NOT NULL,
	`access_code_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
