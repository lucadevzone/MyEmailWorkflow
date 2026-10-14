CREATE TABLE IF NOT EXISTS `shared_message_map` (stable_key text primary key, conversation_id text not null);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `shared_conversation_state` (id text primary key, project_id, summary, summary_detailed, summary_updated_at, last_message_at, archived_at, trashed_at, is_noise, noise_manual, is_spam, split_from_id, split_at, auto_sorted_at, created_at, updated_at);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `shared_pending_refs` (tbl text not null, row_id text not null, col text not null, kind text not null, ref text not null, primary key (tbl, row_id, col));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `shared_pending_rows` (tbl text not null, row_id text not null, row_json text not null, ref text not null, primary key (tbl, row_id));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `shared_pending_refs_ref` ON `shared_pending_refs` (`ref`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `shared_pending_rows_ref` ON `shared_pending_rows` (`ref`);
