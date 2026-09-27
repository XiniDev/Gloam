ALTER TABLE `assets` ADD `overrides_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `assets_uploader_idx` ON `assets` (`uploader_id`);