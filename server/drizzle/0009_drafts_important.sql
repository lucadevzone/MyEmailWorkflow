CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`reply_to_message_id` text,
	`forward_message_id` text,
	`to` text DEFAULT '[]' NOT NULL,
	`cc` text DEFAULT '[]' NOT NULL,
	`bcc` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`include_quote` integer DEFAULT false NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`forward_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `drafts_conversation` ON `drafts` (`conversation_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `important` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- I messaggi già segnati con la stellina di Gmail (\Flagged) sono importanti.
UPDATE `messages` SET `important` = 1 WHERE `flags` LIKE '%\Flagged%';
