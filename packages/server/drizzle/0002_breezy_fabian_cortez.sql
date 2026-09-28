CREATE TABLE `sheet_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`user_id` text NOT NULL,
	`changes_json` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sheet_proposals_campaign_idx` ON `sheet_proposals` (`campaign_id`,`status`);