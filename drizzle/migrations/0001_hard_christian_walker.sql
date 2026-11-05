CREATE TABLE `ga4_landing_daily` (
	`site_id` text NOT NULL,
	`property` text NOT NULL,
	`date` text NOT NULL,
	`landing_page` text NOT NULL,
	`channel_group` text NOT NULL,
	`sessions` integer NOT NULL,
	`engaged_sessions` integer NOT NULL,
	`key_events` real NOT NULL,
	`run_id` text NOT NULL,
	PRIMARY KEY(`site_id`, `property`, `date`, `landing_page`, `channel_group`)
);
--> statement-breakpoint
CREATE TABLE `gsc_page_daily` (
	`site_id` text NOT NULL,
	`property` text NOT NULL,
	`date` text NOT NULL,
	`page` text NOT NULL,
	`clicks` integer NOT NULL,
	`impressions` integer NOT NULL,
	`position` real NOT NULL,
	`run_id` text NOT NULL,
	PRIMARY KEY(`site_id`, `property`, `date`, `page`)
);
--> statement-breakpoint
CREATE TABLE `gsc_query_daily` (
	`site_id` text NOT NULL,
	`property` text NOT NULL,
	`date` text NOT NULL,
	`page` text NOT NULL,
	`query` text NOT NULL,
	`clicks` integer NOT NULL,
	`impressions` integer NOT NULL,
	`position` real NOT NULL,
	`run_id` text NOT NULL,
	PRIMARY KEY(`site_id`, `property`, `date`, `page`, `query`)
);
--> statement-breakpoint
CREATE TABLE `pending_purges` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`dataset` text NOT NULL,
	`property` text,
	`created_at` integer NOT NULL,
	`attempted_at` integer,
	CONSTRAINT "pending_purges_dataset_check" CHECK("pending_purges"."dataset" IN ('gsc_pages', 'gsc_queries', 'ga4_landing_pages'))
);
--> statement-breakpoint
CREATE TABLE `sync_days` (
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
	PRIMARY KEY(`site_id`, `dataset`, `date`),
	CONSTRAINT "sync_days_dataset_check" CHECK("sync_days"."dataset" IN ('gsc_pages', 'gsc_queries', 'ga4_landing_pages')),
	CONSTRAINT "sync_days_status_check" CHECK("sync_days"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "sync_days_last_data_state_check" CHECK("sync_days"."last_data_state" IS NULL OR "sync_days"."last_data_state" IN ('final', 'provisional'))
);
--> statement-breakpoint
CREATE INDEX `sync_days_site_dataset_status_idx` ON `sync_days` (`site_id`,`dataset`,`status`);--> statement-breakpoint
CREATE INDEX `sync_days_status_heartbeat_idx` ON `sync_days` (`status`,`heartbeat_at`);