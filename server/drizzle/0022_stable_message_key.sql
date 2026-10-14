ALTER TABLE `messages` ADD `stable_key` text;--> statement-breakpoint
CREATE INDEX `messages_stable_key` ON `messages` (`stable_key`);--> statement-breakpoint
UPDATE `messages` SET `stable_key` = `account_id` || '|' || coalesce(`rfc_message_id`, 'gm:' || `gm_msgid`, 'id:' || `id`) WHERE `stable_key` IS NULL;
