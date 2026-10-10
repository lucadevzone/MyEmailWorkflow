ALTER TABLE `accounts` ADD `signature_html` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `signature_text` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `format` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `drafts` ADD `body_html` text;