CREATE TABLE `nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`hostname` text,
	`owner_user_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`template_version` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_slug_unique` ON `nodes` (`slug`);