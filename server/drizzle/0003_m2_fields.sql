ALTER TABLE `conversations` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `trashed_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `outgoing_status` text;