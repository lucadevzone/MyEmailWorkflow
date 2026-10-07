CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`provider` text NOT NULL,
	`imap_host` text NOT NULL,
	`imap_port` integer NOT NULL,
	`imap_secure` integer NOT NULL,
	`smtp_host` text NOT NULL,
	`smtp_port` integer NOT NULL,
	`smtp_secure` integer NOT NULL,
	`username` text NOT NULL,
	`auth_type` text NOT NULL,
	`credential_ref` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`urgent` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`executed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activities_status` ON `activities` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`quote_exact` text NOT NULL,
	`quote_prefix` text,
	`quote_suffix` text,
	`start_offset` integer,
	`end_offset` integer,
	`label` text,
	`comment` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `annotations_message` ON `annotations` (`message_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`blob_sha` text NOT NULL,
	`filename` text,
	`mime` text,
	`size` integer NOT NULL,
	`content_id` text,
	`is_inline` integer DEFAULT false NOT NULL,
	`version_chain_id` text,
	`version_no` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blob_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_chain_id`) REFERENCES `version_chains`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_message` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_chain` ON `attachments` (`version_chain_id`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`mime` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`ord` integer NOT NULL,
	`text` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chunks_message` ON `chunks` (`message_id`);--> statement-breakpoint
CREATE TABLE `contact_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text,
	`email` text NOT NULL,
	`display_name` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_addresses_email` ON `contact_addresses` (`email`);--> statement-breakpoint
CREATE INDEX `contact_addresses_contact` ON `contact_addresses` (`contact_id`);--> statement-breakpoint
CREATE TABLE `contact_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`avatar_blob_sha` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`subject` text,
	`summary` text,
	`summary_updated_at` integer,
	`last_message_at` integer NOT NULL,
	`gm_thread_id` text,
	`is_noise` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversations_project_last` ON `conversations` (`project_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_gm_thread` ON `conversations` (`gm_thread_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`contact_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `contact_id`),
	FOREIGN KEY (`group_id`) REFERENCES `contact_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_pick` ON `jobs` (`status`,`priority`,`run_after`);--> statement-breakpoint
CREATE TABLE `message_addresses` (
	`message_id` text NOT NULL,
	`contact_address_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`message_id`, `contact_address_id`, `role`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_address_id`) REFERENCES `contact_addresses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_addresses_address` ON `message_addresses` (`contact_address_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`account_id` text NOT NULL,
	`direction` text NOT NULL,
	`rfc_message_id` text,
	`in_reply_to` text,
	`references` text,
	`gm_msgid` text,
	`gm_thread_id` text,
	`mailbox` text,
	`uid` integer,
	`from_address` text,
	`from_name` text,
	`subject` text,
	`date` integer NOT NULL,
	`snippet` text,
	`body_text` text,
	`body_text_clean` text,
	`raw_blob_sha` text,
	`html_blob_sha` text,
	`flags` text,
	`analyzed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_date` ON `messages` (`conversation_id`,`date`);--> statement-breakpoint
CREATE INDEX `messages_rfc_id` ON `messages` (`rfc_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_account_gm_msgid` ON `messages` (`account_id`,`gm_msgid`);--> statement-breakpoint
CREATE INDEX `messages_account_mailbox_uid` ON `messages` (`account_id`,`mailbox`,`uid`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`annotation_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`annotation_id`) REFERENCES `annotations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notes_project` ON `notes` (`project_id`);--> statement-breakpoint
CREATE INDEX `notes_conversation` ON `notes` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`outgoing_account_id` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`outgoing_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`kind` text NOT NULL,
	`blob_sha` text,
	`url` text,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blob_sha`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `resources_project` ON `resources` (`project_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`payload` text NOT NULL,
	`confidence` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `suggestions_subject` ON `suggestions` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `suggestions_status` ON `suggestions` (`status`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`account_id` text NOT NULL,
	`mailbox` text NOT NULL,
	`uid_validity` text,
	`last_uid` integer,
	`highest_modseq` text,
	`oldest_synced_date` integer,
	`backfill_done` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `mailbox`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text,
	`message_id` text,
	`annotation_id` text,
	`title` text NOT NULL,
	`details` text,
	`status` text DEFAULT 'open' NOT NULL,
	`rank` text NOT NULL,
	`priority` integer,
	`due_date` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`annotation_id`) REFERENCES `annotations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_status_rank` ON `tasks` (`status`,`rank`);--> statement-breakpoint
CREATE INDEX `tasks_project` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE `version_chains` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`logical_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
