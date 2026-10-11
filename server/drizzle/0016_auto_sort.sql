CREATE TABLE `auto_sort_log` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sender` text,
	`mode` text NOT NULL,
	`outcome` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `auto_sort_conv` ON `auto_sort_log` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `auto_sort_sender` ON `auto_sort_log` (`sender`,`project_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `auto_sorted_at` integer;