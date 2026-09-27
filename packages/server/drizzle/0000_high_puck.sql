CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`kind` text NOT NULL,
	`owner_user_id` text,
	`template_id` text,
	`lock_level` text DEFAULT 'unlocked' NOT NULL,
	`sheet_json` text NOT NULL,
	`status_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `actors_campaign_idx` ON `actors` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `admin` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `asset_files` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`variants_json` text NOT NULL,
	`meta_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`file_id` text NOT NULL,
	`name` text NOT NULL,
	`purpose` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`uploader_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `asset_files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assets_campaign_idx` ON `assets` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `assets_file_idx` ON `assets` (`file_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cover_asset_id` text,
	`rules_pack` text DEFAULT 'srd-5.2.1' NOT NULL,
	`units` text DEFAULT 'ft' NOT NULL,
	`house_rules_json` text DEFAULT '{}' NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`active_scene_id` text,
	`session_no` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `combats` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`turn_index` integer DEFAULT 0 NOT NULL,
	`data_json` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `combats_scene_idx` ON `combats` (`scene_id`);--> statement-breakpoint
CREATE TABLE `content` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text,
	`pack` text NOT NULL,
	`type` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`data_json` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_campaign_type_slug_idx` ON `content` (`campaign_id`,`type`,`slug`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_hash` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`banned_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `devices_user_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `devices_hash_idx` ON `devices` (`device_hash`);--> statement-breakpoint
CREATE TABLE `effects` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`source_json` text NOT NULL,
	`shape_json` text NOT NULL,
	`props_json` text DEFAULT '{}' NOT NULL,
	`triggers_json` text DEFAULT '[]' NOT NULL,
	`attached_token_id` text,
	`concentration_token_id` text,
	`expires_json` text NOT NULL,
	`visibility` text DEFAULT 'everyone' NOT NULL,
	`vfx` text NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `effects_scene_idx` ON `effects` (`scene_id`);--> statement-breakpoint
CREATE TABLE `fog_masks` (
	`scene_id` text NOT NULL,
	`layer` text NOT NULL,
	`cell_ft` real NOT NULL,
	`origin_x` real NOT NULL,
	`origin_y` real NOT NULL,
	`w` integer NOT NULL,
	`h` integer NOT NULL,
	`data` blob NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scene_id`, `layer`),
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `handouts` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text DEFAULT '' NOT NULL,
	`image_asset_id` text,
	`recipients_json` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text DEFAULT 'handout' NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `handouts_campaign_idx` ON `handouts` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` text NOT NULL,
	`scene_id` text,
	`user_id` text NOT NULL,
	`acting_as` text,
	`type` text NOT NULL,
	`ops_json` text NOT NULL,
	`inverse_json` text NOT NULL,
	`summary` text NOT NULL,
	`undoable` integer NOT NULL,
	`created_at` integer NOT NULL,
	`undone_at` integer,
	`undone_by` text,
	`table_session_no` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `history_campaign_id_idx` ON `history` (`campaign_id`,`id`);--> statement-breakpoint
CREATE TABLE `invite_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`max_uses` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `lights` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`token_id` text,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`elevation` real DEFAULT 0 NOT NULL,
	`bright` real NOT NULL,
	`dim` real NOT NULL,
	`color` text NOT NULL,
	`intensity` real DEFAULT 1 NOT NULL,
	`animation` text DEFAULT 'none' NOT NULL,
	`cone_deg` real,
	`direction_deg` real DEFAULT 0 NOT NULL,
	`magical` integer DEFAULT false NOT NULL,
	`pierce_darkness` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`dm_only` integer DEFAULT false NOT NULL,
	`preset` text,
	`data_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lights_scene_idx` ON `lights` (`scene_id`);--> statement-breakpoint
CREATE TABLE `log_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`session_no` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`visibility` text DEFAULT 'everyone' NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `log_entries_campaign_idx` ON `log_entries` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`campaign_id`, `user_id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `roll_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`created_by` text NOT NULL,
	`data_json` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `roll_requests_campaign_idx` ON `roll_requests` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `rolls` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`scene_id` text,
	`user_id` text NOT NULL,
	`token_id` text,
	`formula` text NOT NULL,
	`result_json` text NOT NULL,
	`total` integer NOT NULL,
	`visibility` text NOT NULL,
	`purpose` text,
	`request_id` text,
	`manual` integer DEFAULT false NOT NULL,
	`seed` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rolls_campaign_created_idx` ON `rolls` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`sort` real DEFAULT 0 NOT NULL,
	`map_kind` text NOT NULL,
	`map_asset_id` text,
	`calibration_json` text DEFAULT '{}' NOT NULL,
	`floor_json` text DEFAULT '{}' NOT NULL,
	`ambient_json` text DEFAULT '{}' NOT NULL,
	`fog_mode` text DEFAULT 'off' NOT NULL,
	`fog_cell_ft` real DEFAULT 1 NOT NULL,
	`bounds_json` text NOT NULL,
	`spawn_json` text NOT NULL,
	`music_json` text,
	`walls3d` integer DEFAULT false NOT NULL,
	`thumbnail_asset_id` text,
	`data_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenes_campaign_idx` ON `scenes` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `security_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`user_id` text,
	`ip` text,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_log_created_idx` ON `security_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`table_session_no` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`device_id` text,
	`identity_kind` text,
	`device_label` text,
	`knocked_at` integer,
	`admitted_as` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sheet_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`blocks_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_campaign_idx` ON `snapshots` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `table_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`session_no` integer NOT NULL,
	`mode` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`close_reason` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `table_sessions_campaign_idx` ON `table_sessions` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`actor_id` text,
	`link` text DEFAULT 'unlinked' NOT NULL,
	`name` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`elevation` real DEFAULT 0 NOT NULL,
	`rotation` real DEFAULT 0 NOT NULL,
	`size_ft` real NOT NULL,
	`appearance_json` text NOT NULL,
	`owner_ids_json` text DEFAULT '[]' NOT NULL,
	`disposition` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`reveal_json` text DEFAULT '"vision"' NOT NULL,
	`hp_display` text NOT NULL,
	`stats_json` text,
	`status_json` text,
	`overrides_json` text DEFAULT '{}' NOT NULL,
	`light_id` text,
	`locked` integer DEFAULT false NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tokens_scene_idx` ON `tokens` (`scene_id`);--> statement-breakpoint
CREATE INDEX `tokens_actor_idx` ON `tokens` (`actor_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`color` text NOT NULL,
	`pin_hash` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`banned_at` integer,
	`ban_reason` text,
	`dice_skin_json` text DEFAULT '{}' NOT NULL,
	`prefs_json` text DEFAULT '{}' NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `walls` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`ax` real NOT NULL,
	`ay` real NOT NULL,
	`bx` real NOT NULL,
	`by` real NOT NULL,
	`kind` text NOT NULL,
	`door_state` text,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `walls_scene_idx` ON `walls` (`scene_id`);--> statement-breakpoint
CREATE TABLE `zones` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`kind` text NOT NULL,
	`shape_json` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`color` text NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`triggers_json` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `zones_scene_idx` ON `zones` (`scene_id`);