CREATE TABLE `billing_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_event_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`result` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_events_unique` ON `billing_events` (`provider_event_id`);--> statement-breakpoint
CREATE TABLE `credit_packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`credits` integer NOT NULL,
	`price` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`monthly` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_packages_key_unique` ON `credit_packages` (`key`);--> statement-breakpoint
CREATE INDEX `credit_packages_active` ON `credit_packages` (`active`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` integer NOT NULL,
	`package_key` text NOT NULL,
	`provider_ref` text NOT NULL,
	`customer_ref` text,
	`status` text DEFAULT 'active' NOT NULL,
	`current_period_end` integer,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_provider_ref_unique` ON `subscriptions` (`provider_ref`);--> statement-breakpoint
CREATE INDEX `subscriptions_node` ON `subscriptions` (`node_id`);