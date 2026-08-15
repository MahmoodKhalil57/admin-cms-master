CREATE TABLE `credit_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` integer NOT NULL,
	`kind` text NOT NULL,
	`credits` integer NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`note` text,
	`dedupe_key` text,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_ledger_dedupe_key_unique` ON `credit_ledger` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `credit_ledger_node` ON `credit_ledger` (`node_id`);--> statement-breakpoint
CREATE TABLE `node_meters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` integer NOT NULL,
	`period` text NOT NULL,
	`item` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`credits` integer DEFAULT 0 NOT NULL,
	`price_list_version` integer DEFAULT 1 NOT NULL,
	`pending` integer DEFAULT false NOT NULL,
	`reported_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_meters_unique` ON `node_meters` (`node_id`,`period`,`item`);--> statement-breakpoint
CREATE INDEX `node_meters_period` ON `node_meters` (`period`);