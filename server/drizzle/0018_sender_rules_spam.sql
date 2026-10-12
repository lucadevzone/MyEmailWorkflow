CREATE TABLE `sender_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_rules_pattern_unique` ON `sender_rules` (`pattern`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `is_spam` integer DEFAULT false NOT NULL;