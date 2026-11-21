CREATE TABLE `user_invitations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_invitations_token_hash_unique` ON `user_invitations` (`token_hash`);