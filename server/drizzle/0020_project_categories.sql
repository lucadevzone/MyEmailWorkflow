CREATE TABLE `project_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rank` text,
	`collapsed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `category_id` text REFERENCES project_categories(id);