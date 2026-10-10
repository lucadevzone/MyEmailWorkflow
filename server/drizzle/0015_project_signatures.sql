CREATE TABLE `signatures` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`html` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `signature_id` text;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `signature_html`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `signature_text`;