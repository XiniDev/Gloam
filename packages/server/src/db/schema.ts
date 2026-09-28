import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * SQLite schema (SPEC §12.2). IDs are `nanoid(16)` with a type prefix; times are integer ms since the epoch;
 * JSON columns hold zod-validated documents. Extra tables/columns beyond §12.2 are recorded in DECISIONS.md.
 */

const bool = (name: string) => integer(name, { mode: "boolean" });
const json = (name: string) => text(name);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const admin = sqliteTable("admin", {
  id: integer("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  color: text("color").notNull(),
  pinHash: text("pin_hash"),
  isAdmin: bool("is_admin").notNull().default(false),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  bannedAt: integer("banned_at"),
  banReason: text("ban_reason"),
  diceSkinJson: json("dice_skin_json").notNull().default("{}"),
  prefsJson: json("prefs_json").notNull().default("{}"),
  deletedAt: integer("deleted_at"),
});

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceHash: text("device_hash").notNull(),
    label: text("label").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    bannedAt: integer("banned_at"),
  },
  (t) => [index("devices_user_idx").on(t.userId), index("devices_hash_idx").on(t.deviceHash)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    kind: text("kind", { enum: ["admin", "player"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    tableSessionNo: integer("table_session_no"),
    status: text("status", { enum: ["pending", "admitted", "denied", "kicked"] })
      .notNull()
      .default("pending"),
    deviceId: text("device_id"),
    identityKind: text("identity_kind"),
    deviceLabel: text("device_label"),
    knockedAt: integer("knocked_at"),
    admittedAs: text("admitted_as"),
    ip: text("ip"),
  },
  (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const inviteCodes = sqliteTable("invite_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
  maxUses: integer("max_uses"),
  uses: integer("uses").notNull().default(0),
  revokedAt: integer("revoked_at"),
});

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  coverAssetId: text("cover_asset_id"),
  rulesPack: text("rules_pack").notNull().default("srd-5.2.1"),
  units: text("units", { enum: ["ft", "m"] })
    .notNull()
    .default("ft"),
  houseRulesJson: json("house_rules_json").notNull().default("{}"),
  settingsJson: json("settings_json").notNull().default("{}"),
  activeSceneId: text("active_scene_id"),
  sessionNo: integer("session_no").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  archivedAt: integer("archived_at"),
});

/** One row per opening of the table (SPEC §5 "Session"); used for crash hygiene and log grouping. */
export const tableSessions = sqliteTable(
  "table_sessions",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    sessionNo: integer("session_no").notNull(),
    mode: text("mode").notNull(),
    openedAt: integer("opened_at").notNull(),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
  },
  (t) => [index("table_sessions_campaign_idx").on(t.campaignId)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["dm", "player", "spectator"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.userId] }), index("memberships_user_idx").on(t.userId)],
);

export const scenes = sqliteTable(
  "scenes",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sort: real("sort").notNull().default(0),
    mapKind: text("map_kind", { enum: ["image", "model", "procedural", "blank"] }).notNull(),
    mapAssetId: text("map_asset_id"),
    calibrationJson: json("calibration_json").notNull().default("{}"),
    floorJson: json("floor_json").notNull().default("{}"),
    ambientJson: json("ambient_json").notNull().default("{}"),
    fogMode: text("fog_mode", { enum: ["off", "painted", "dynamic"] })
      .notNull()
      .default("off"),
    fogCellFt: real("fog_cell_ft").notNull().default(1),
    boundsJson: json("bounds_json").notNull(),
    spawnJson: json("spawn_json").notNull(),
    musicJson: json("music_json"),
    walls3d: bool("walls3d").notNull().default(false),
    thumbnailAssetId: text("thumbnail_asset_id"),
    dataJson: json("data_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("scenes_campaign_idx").on(t.campaignId)],
);

export const walls = sqliteTable(
  "walls",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    ax: real("ax").notNull(),
    ay: real("ay").notNull(),
    bx: real("bx").notNull(),
    by: real("by").notNull(),
    kind: text("kind").notNull(),
    doorState: text("door_state"),
    hidden: bool("hidden").notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("walls_scene_idx").on(t.sceneId)],
);

export const lights = sqliteTable(
  "lights",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    tokenId: text("token_id"),
    x: real("x").notNull(),
    y: real("y").notNull(),
    elevation: real("elevation").notNull().default(0),
    bright: real("bright").notNull(),
    dim: real("dim").notNull(),
    color: text("color").notNull(),
    intensity: real("intensity").notNull().default(1),
    animation: text("animation").notNull().default("none"),
    coneDeg: real("cone_deg"),
    directionDeg: real("direction_deg").notNull().default(0),
    magical: bool("magical").notNull().default(false),
    pierceDarkness: bool("pierce_darkness").notNull().default(false),
    enabled: bool("enabled").notNull().default(true),
    dmOnly: bool("dm_only").notNull().default(false),
    preset: text("preset"),
    dataJson: json("data_json").notNull().default("{}"),
  },
  (t) => [index("lights_scene_idx").on(t.sceneId)],
);

export const zones = sqliteTable(
  "zones",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    shapeJson: json("shape_json").notNull(),
    label: text("label").notNull().default(""),
    color: text("color").notNull(),
    visible: bool("visible").notNull().default(true),
    triggersJson: json("triggers_json").notNull().default("[]"),
    note: text("note").notNull().default(""),
  },
  (t) => [index("zones_scene_idx").on(t.sceneId)],
);

export const actors = sqliteTable(
  "actors",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["character", "npc"] }).notNull(),
    ownerUserId: text("owner_user_id"),
    templateId: text("template_id"),
    lockLevel: text("lock_level", { enum: ["unlocked", "core", "full"] })
      .notNull()
      .default("unlocked"),
    sheetJson: json("sheet_json").notNull(),
    statusJson: json("status_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("actors_campaign_idx").on(t.campaignId)],
);

/** A player's proposed change to a locked sheet (SPEC §8.10 Ownership and locks): the DM approves or denies it. */
export const sheetProposals = sqliteTable(
  "sheet_proposals",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** The changes (path, before, after) as proposed. */
    changesJson: json("changes_json").notNull(),
    note: text("note").notNull().default(""),
    status: text("status", { enum: ["pending", "approved", "denied", "withdrawn"] })
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (t) => [index("sheet_proposals_campaign_idx").on(t.campaignId, t.status)],
);

export const sheetTemplates = sqliteTable("sheet_templates", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id")
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  blocksJson: json("blocks_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    link: text("link", { enum: ["linked", "unlinked"] })
      .notNull()
      .default("unlinked"),
    name: text("name").notNull(),
    x: real("x").notNull(),
    y: real("y").notNull(),
    elevation: real("elevation").notNull().default(0),
    rotation: real("rotation").notNull().default(0),
    sizeFt: real("size_ft").notNull(),
    appearanceJson: json("appearance_json").notNull(),
    ownerIdsJson: json("owner_ids_json").notNull().default("[]"),
    disposition: text("disposition").notNull(),
    hidden: bool("hidden").notNull().default(false),
    revealJson: json("reveal_json").notNull().default('"vision"'),
    hpDisplay: text("hp_display").notNull(),
    statsJson: json("stats_json"),
    statusJson: json("status_json"),
    overridesJson: json("overrides_json").notNull().default("{}"),
    lightId: text("light_id"),
    locked: bool("locked").notNull().default(false),
    dataJson: json("data_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("tokens_scene_idx").on(t.sceneId), index("tokens_actor_idx").on(t.actorId)],
);

export const effects = sqliteTable(
  "effects",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    sourceJson: json("source_json").notNull(),
    shapeJson: json("shape_json").notNull(),
    propsJson: json("props_json").notNull().default("{}"),
    triggersJson: json("triggers_json").notNull().default("[]"),
    attachedTokenId: text("attached_token_id"),
    concentrationTokenId: text("concentration_token_id"),
    expiresJson: json("expires_json").notNull(),
    visibility: text("visibility", { enum: ["everyone", "dm"] })
      .notNull()
      .default("everyone"),
    vfx: text("vfx").notNull(),
    dataJson: json("data_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("effects_scene_idx").on(t.sceneId)],
);

export const fogMasks = sqliteTable(
  "fog_masks",
  {
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    layer: text("layer").notNull(),
    cellFt: real("cell_ft").notNull(),
    originX: real("origin_x").notNull(),
    originY: real("origin_y").notNull(),
    w: integer("w").notNull(),
    h: integer("h").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sceneId, t.layer] })],
);

export const combats = sqliteTable(
  "combats",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    active: bool("active").notNull().default(true),
    round: integer("round").notNull().default(1),
    turnIndex: integer("turn_index").notNull().default(0),
    dataJson: json("data_json").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [index("combats_scene_idx").on(t.sceneId)],
);

export const rolls = sqliteTable(
  "rolls",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    sceneId: text("scene_id"),
    userId: text("user_id").notNull(),
    tokenId: text("token_id"),
    formula: text("formula").notNull(),
    resultJson: json("result_json").notNull(),
    total: integer("total").notNull(),
    visibility: text("visibility").notNull(),
    purpose: text("purpose"),
    requestId: text("request_id"),
    manual: bool("manual").notNull().default(false),
    seed: integer("seed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("rolls_campaign_created_idx").on(t.campaignId, t.createdAt)],
);

export const rollRequests = sqliteTable(
  "roll_requests",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull(),
    dataJson: json("data_json").notNull(),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [index("roll_requests_campaign_idx").on(t.campaignId)],
);

export const content = sqliteTable(
  "content",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    pack: text("pack").notNull(),
    type: text("type", { enum: ["spell", "monster", "item"] }).notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    dataJson: json("data_json").notNull(),
    status: text("status", { enum: ["active", "proposed", "rejected"] })
      .notNull()
      .default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("content_campaign_type_slug_idx").on(t.campaignId, t.type, t.slug)],
);

export const history = sqliteTable(
  "history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    sceneId: text("scene_id"),
    userId: text("user_id").notNull(),
    actingAs: text("acting_as"),
    type: text("type").notNull(),
    opsJson: json("ops_json").notNull(),
    inverseJson: json("inverse_json").notNull(),
    summary: text("summary").notNull(),
    undoable: bool("undoable").notNull(),
    createdAt: integer("created_at").notNull(),
    undoneAt: integer("undone_at"),
    undoneBy: text("undone_by"),
    tableSessionNo: integer("table_session_no"),
  },
  (t) => [index("history_campaign_id_idx").on(t.campaignId, t.id)],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["auto", "manual", "scene", "close", "shutdown", "pre-restore"] }).notNull(),
    path: text("path").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("snapshots_campaign_idx").on(t.campaignId)],
);

export const assetFiles = sqliteTable("asset_files", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["image", "model", "audio"] }).notNull(),
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  variantsJson: json("variants_json").notNull(),
  metaJson: json("meta_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => assetFiles.id),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    tagsJson: json("tags_json").notNull().default("[]"),
    uploaderId: text("uploader_id").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at"),
    deletedAt: integer("deleted_at"),
    /** Per-asset display overrides (minis: scale, rotation about Y, vertical offset; SPEC §8.5, AC-TOK-03). */
    overridesJson: json("overrides_json").notNull().default("{}"),
  },
  (t) => [
    index("assets_campaign_idx").on(t.campaignId),
    index("assets_file_idx").on(t.fileId),
    index("assets_uploader_idx").on(t.uploaderId),
  ],
);

export const handouts = sqliteTable(
  "handouts",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    imageAssetId: text("image_asset_id"),
    recipientsJson: json("recipients_json").notNull().default("[]"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    kind: text("kind", { enum: ["handout", "note"] })
      .notNull()
      .default("handout"),
  },
  (t) => [index("handouts_campaign_idx").on(t.campaignId)],
);

export const logEntries = sqliteTable(
  "log_entries",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    sessionNo: integer("session_no").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    dataJson: json("data_json").notNull().default("{}"),
    visibility: text("visibility").notNull().default("everyone"),
    userId: text("user_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("log_entries_campaign_idx").on(t.campaignId, t.createdAt)],
);

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  scopesJson: json("scopes_json").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
});

export const securityLog = sqliteTable(
  "security_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    event: text("event").notNull(),
    userId: text("user_id"),
    ip: text("ip"),
    detailJson: json("detail_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("security_log_created_idx").on(t.createdAt)],
);
