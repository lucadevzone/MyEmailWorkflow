ALTER TABLE `messages` ADD `labels` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `seen` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `has_attachments` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `lowest_uid` integer;