CREATE TABLE `project_contacts` (
	`project_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `contact_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary_detailed` text;