CREATE TABLE `assistant_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread` text NOT NULL,
	`role` text NOT NULL,
	`mode` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assistant_messages_thread` ON `assistant_messages` (`thread`,`created_at`);