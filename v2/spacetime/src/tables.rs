//! Schema for the Cozy Bistro database.
//!
//! Tables are decorated with `#[spacetimedb::table(name = ..., public)]`
//! so the auto-generated client SDK can subscribe to them. `public` means
//! all clients can read; reducers gate writes by Identity.

use spacetimedb::{table, Identity, Timestamp};

/// A signed-in player. One row per Identity. Created automatically by
/// the `client_connected` lifecycle reducer. Auth credentials live
/// in a SEPARATE `auth_record` table (one row per username) — that
/// way we can add the multiplayer auth layer without doing a
/// breaking-schema migration on this existing table.
#[table(name = player, public)]
pub struct Player {
    /// SpacetimeDB Identity — stable per browser, used as the primary key.
    #[primary_key]
    pub identity: Identity,
    /// Display name. Defaults to a short suffix of the identity hash if
    /// the player hasn't set one yet.
    pub name: String,
    /// When this player first connected.
    pub created_at: Timestamp,
    /// Most recent connection timestamp. Updated on client_connected.
    pub last_seen_at: Timestamp,
}

/// Account credentials — one row per (lowercased) username. Lookup
/// by username yields the active Identity claim for the account.
/// Living separately from `player` so adding multiplayer auth
/// doesn't require schema-migrating the existing player rows.
///
/// On login from a new browser, the row's `identity` field updates
/// to the new sender; the old identity loses its claim (closing
/// the tab on the old browser is then effectively a sign-out).
#[table(name = auth_record, public)]
pub struct AuthRecord {
    /// Lowercased username — globally unique because it's the PK.
    #[primary_key]
    pub username: String,
    /// SpacetimeDB Identity currently logged in as this account.
    /// Btree-indexed so we can answer "what account does identity X
    /// own?" in O(log n) on each connect.
    #[index(btree)]
    pub identity: Identity,
    /// Original-case display name (matches Player.name).
    pub display_name: String,
    /// SHA-256 hex of (salt || password) with "{salt_hex}${hash_hex}".
    pub password_hash: String,
    /// True for the admin account ("Dunnin"). Set by sign_up only
    /// when this is the first ever account with that username.
    pub is_admin: bool,
    pub created_at: Timestamp,
}

/// A physical plot on the shared city map. Seeded at module init
/// with N unowned buildings of mixed sizes; players claim one on
/// first login via the `claim_building` reducer. Once claimed,
/// `owner_identity` is the Identity of the player who chose it
/// (which links back to their auth_record).
///
/// Plot coordinates are in TILES on the shared city grid (much
/// larger than the legacy 10×10 per-restaurant grid — the city
/// will be ~120×120). plot_w / plot_h are the building footprint
/// in tiles; the interior placement grid is derived from these
/// bounds, plus a fenced garden plot and a rooftop expansion
/// added in later phases.
///
/// kind is a string tag picking which programmatic shell to
/// render: "small" (1 storey, ~8×8), "medium" (1-2 storey, ~10×10),
/// "large" (multi-storey, ~12×12). Future variants ("corner",
/// "Greek-tower", etc.) can join the enum without a schema migration.
#[table(name = building, public)]
pub struct Building {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Architectural shell variant; drives the procedural mesh.
    pub kind: String,
    /// Plot anchor X on the city grid (tile units).
    pub plot_x: i32,
    /// Plot anchor Z on the city grid.
    pub plot_z: i32,
    /// Building footprint width in tiles.
    pub plot_w: u32,
    /// Building footprint depth in tiles.
    pub plot_h: u32,
    /// Owner Identity, or the zero Identity when unowned. Indexed
    /// so the BuildingPickModal can query "who owns what" / "what's
    /// available" in one pass.
    #[index(btree)]
    pub owner_identity: Identity,
    /// When this building was claimed (None until owned).
    pub claimed_at: Option<Timestamp>,
}

/// A "forgot password" ticket — created when a player clicks the
/// forgot-password link in the login modal. Visible to the admin
/// (Dunnin) via the AdminPanel; admin can call `admin_reset_password`
/// to issue a new temporary password and mark the ticket resolved.
#[table(name = password_reset_request, public)]
pub struct PasswordResetRequest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Username the player wants to recover. Indexed for the admin
    /// list view + dedup-on-issuance.
    #[index(btree)]
    pub username: String,
    /// Free-text message from the player describing what happened
    /// (e.g. "lost my password", "wrong username typed at signup").
    /// Capped to a reasonable length by the reducer.
    pub message: String,
    /// "pending" | "resolved" | "denied"
    pub status: String,
    pub created_at: Timestamp,
    pub resolved_at: Option<Timestamp>,
}

/// A restaurant owned by one player. A player can own multiple
/// restaurants (different save slots, themed variants, etc).
#[table(name = restaurant, public)]
pub struct Restaurant {
    /// Auto-incrementing id.
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Owning player.
    #[index(btree)]
    pub owner: Identity,
    /// Player-chosen name ("Pasta Place", "Bistro Mauve", …).
    pub name: String,
    /// True if this restaurant should appear in public listings /
    /// friends' "visit" lists. Defaults to true.
    pub public: bool,
    pub created_at: Timestamp,
}

/// Latest save state for a restaurant. Upserted by the `save_snapshot`
/// reducer; one row per restaurant. The full game state is stored as
/// a JSON blob (mirrors the v2 SaveGameState shape).
#[table(name = save_snapshot, public)]
pub struct SaveSnapshot {
    /// Foreign key to Restaurant.id — also the primary key (one save
    /// per restaurant; multi-slot can be modeled as multiple restaurants).
    #[primary_key]
    pub restaurant_id: u64,
    /// JSON-serialized SaveGameState.
    pub data: String,
    /// Denormalized so the restaurant list UI can show stats without
    /// parsing the JSON blob.
    pub day_number: u32,
    pub money: i64,
    pub rating_avg: f32,
    pub luxury_tier: u32,
    pub saved_at: Timestamp,
}

/// Achievement unlocks per player. One row per (player, achievement_id)
/// pair. Used both for "did this player unlock X" lookups and for global
/// "what % of players have X" stats via the table size.
#[table(name = achievement_unlock, public)]
pub struct AchievementUnlock {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub player: Identity,
    /// Matches the id in v2/src/game/AchievementSystem.ts ACHIEVEMENTS list.
    pub achievement_id: String,
    pub unlocked_at: Timestamp,
}

/// Leaderboard entry — published when a day rolls over for a "public"
/// restaurant. The Leaderboard UI queries the top-N rows per category.
#[table(name = leaderboard_entry, public)]
pub struct LeaderboardEntry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub player: Identity,
    pub restaurant_id: u64,
    /// e.g. "daily_revenue" | "daily_served" | "lifetime_served" |
    ///      "fastest_max_tier" | "best_rating_day"
    #[index(btree)]
    pub category: String,
    /// The score itself. Higher is better.
    pub score: i64,
    /// Game day this score was achieved on.
    pub day_number: u32,
    pub submitted_at: Timestamp,
}

/// Friend request — pending or resolved.
#[table(name = friend_request, public)]
pub struct FriendRequest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub from_player: Identity,
    #[index(btree)]
    pub to_player: Identity,
    /// "pending" | "accepted" | "declined"
    pub status: String,
    pub created_at: Timestamp,
    pub resolved_at: Option<Timestamp>,
}

/// Friendship — created when a request is accepted. Stored canonically
/// with player_a < player_b (lexicographic on Identity bytes) so each
/// pair appears exactly once.
#[table(name = friendship, public)]
pub struct Friendship {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub player_a: Identity,
    #[index(btree)]
    pub player_b: Identity,
    pub since: Timestamp,
}

/// Co-owner row for a shared restaurant. The owner Identity on Restaurant
/// is the primary owner; co-owners can edit but can't delete.
#[table(name = co_owner, public)]
pub struct CoOwner {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub restaurant_id: u64,
    #[index(btree)]
    pub player: Identity,
    pub invited_at: Timestamp,
}
