CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`published_on` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_site_id_url_unique` ON `articles` (`site_id`,`url`);--> statement-breakpoint
CREATE INDEX `articles_site_id_published_on_idx` ON `articles` (`site_id`,`published_on`);--> statement-breakpoint
CREATE TABLE `record_articles` (
	`record_id` text NOT NULL,
	`article_id` text NOT NULL,
	PRIMARY KEY(`record_id`, `article_id`),
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `record_articles_article_id_idx` ON `record_articles` (`article_id`);--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`date` text,
	`period_start` text,
	`period_end` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "records_kind_check" CHECK("records"."kind" IN ('action', 'review', 'note')),
	CONSTRAINT "records_status_check" CHECK("records"."status" IN ('planned', 'done', 'canceled'))
);
--> statement-breakpoint
CREATE INDEX `records_site_id_date_idx` ON `records` (`site_id`,`date`);--> statement-breakpoint
CREATE INDEX `records_site_id_kind_status_idx` ON `records` (`site_id`,`kind`,`status`);