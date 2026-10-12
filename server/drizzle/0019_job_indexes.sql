CREATE INDEX `jobs_dedupe` ON `jobs` (`kind`,`status`,`payload`);--> statement-breakpoint
CREATE INDEX `jobs_order` ON `jobs` (`status`,`priority`,`created_at`);