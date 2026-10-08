CREATE TABLE `project_groups` (
	`project_id` text NOT NULL,
	`group_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `group_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `contact_groups`(`id`) ON UPDATE no action ON DELETE no action
);
