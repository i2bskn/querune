CREATE TABLE `sitemap_urls` (
	`site_id` text NOT NULL,
	`url` text NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `url`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
