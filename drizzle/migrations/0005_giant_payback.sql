CREATE TABLE `ga4_page_daily` (
	`site_id` text NOT NULL,
	`property` text NOT NULL,
	`date` text NOT NULL,
	`host_name` text NOT NULL,
	`page_path` text NOT NULL,
	`views` integer NOT NULL,
	`engagement_seconds` real NOT NULL,
	`run_id` text NOT NULL,
	PRIMARY KEY(`site_id`, `property`, `date`, `host_name`, `page_path`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending_purges` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`dataset` text NOT NULL,
	`property` text,
	`created_at` integer NOT NULL,
	`attempted_at` integer,
	CONSTRAINT "pending_purges_dataset_check" CHECK("__new_pending_purges"."dataset" IN ('gsc_pages', 'gsc_queries', 'ga4_landing_pages', 'ga4_pages'))
);
--> statement-breakpoint
INSERT INTO `__new_pending_purges`("id", "site_id", "dataset", "property", "created_at", "attempted_at") SELECT "id", "site_id", "dataset", "property", "created_at", "attempted_at" FROM `pending_purges`;--> statement-breakpoint
DROP TABLE `pending_purges`;--> statement-breakpoint
ALTER TABLE `__new_pending_purges` RENAME TO `pending_purges`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Edited by hand: drizzle-kit copied the new column last_thresholded from the old sync_days, which does not have it.
-- The copy leaves it out, so that it is NULL for the existing rows.
CREATE TABLE `__new_sync_days` (
	`site_id` text NOT NULL,
	`dataset` text NOT NULL,
	`date` text NOT NULL,
	`property` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text NOT NULL,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`heartbeat_at` integer,
	`finished_at` integer,
	`error_code` text,
	`error_message` text,
	`last_succeeded_at` integer,
	`last_data_state` text,
	`last_row_count` integer,
	`last_truncated` integer,
	`last_time_zone` text,
	`last_thresholded` integer,
	PRIMARY KEY(`site_id`, `dataset`, `date`),
	CONSTRAINT "sync_days_dataset_check" CHECK("__new_sync_days"."dataset" IN ('gsc_pages', 'gsc_queries', 'ga4_landing_pages', 'ga4_pages')),
	CONSTRAINT "sync_days_status_check" CHECK("__new_sync_days"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "sync_days_last_data_state_check" CHECK("__new_sync_days"."last_data_state" IS NULL OR "__new_sync_days"."last_data_state" IN ('final', 'provisional'))
);
--> statement-breakpoint
INSERT INTO `__new_sync_days`("site_id", "dataset", "date", "property", "status", "run_id", "queued_at", "started_at", "heartbeat_at", "finished_at", "error_code", "error_message", "last_succeeded_at", "last_data_state", "last_row_count", "last_truncated", "last_time_zone") SELECT "site_id", "dataset", "date", "property", "status", "run_id", "queued_at", "started_at", "heartbeat_at", "finished_at", "error_code", "error_message", "last_succeeded_at", "last_data_state", "last_row_count", "last_truncated", "last_time_zone" FROM `sync_days`;--> statement-breakpoint
DROP TABLE `sync_days`;--> statement-breakpoint
ALTER TABLE `__new_sync_days` RENAME TO `sync_days`;--> statement-breakpoint
CREATE INDEX `sync_days_site_dataset_status_idx` ON `sync_days` (`site_id`,`dataset`,`status`);--> statement-breakpoint
CREATE INDEX `sync_days_status_heartbeat_idx` ON `sync_days` (`status`,`heartbeat_at`);