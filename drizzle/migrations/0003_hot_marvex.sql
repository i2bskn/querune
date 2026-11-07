DROP TABLE `record_articles`;--> statement-breakpoint
DROP TABLE `records`;--> statement-breakpoint
CREATE TABLE `memo_articles` (
	`memo_id` text NOT NULL,
	`article_id` text NOT NULL,
	PRIMARY KEY(`memo_id`, `article_id`),
	FOREIGN KEY (`memo_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memo_articles_article_id_idx` ON `memo_articles` (`article_id`);--> statement-breakpoint
CREATE TABLE `memos` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`title` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memos_site_id_created_at_idx` ON `memos` (`site_id`,`created_at`);