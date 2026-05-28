//! Schema for the Cozy Bistro database.
//!
//! Tables are decorated with `#[spacetimedb::table(name = ..., public)]`
//! so the auto-generated client SDK can subscribe to them. `public` means
//! all clients can read; reducers gate writes by Identity.

use spacetimedb::{table, Identity, Timestamp};

/// A signed-in player. One row per Identity. Created automatically by
/// the `client_connected` lifecycle reducer.
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
