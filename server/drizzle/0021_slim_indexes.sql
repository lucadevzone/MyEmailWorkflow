CREATE INDEX `messages_unread` ON `messages` (`conversation_id`) WHERE seen = 0 and direction = 'in' and deleted_at is null;--> statement-breakpoint
CREATE INDEX `messages_important` ON `messages` (`conversation_id`) WHERE important = 1 and deleted_at is null;--> statement-breakpoint
CREATE INDEX `messages_slim` ON `messages` (`id`,`conversation_id`,`date`) WHERE deleted_at is null;