//! Schema for the Cozy Bistro database.
//!
//! Tables are decorated with `#[spacetimedb::table(name = ..., public)]`
//! so the auto-generated client SDK can subscribe to them. `public` means
//! all clients can read; reducers gate writes by Identity.

use spacetimedb::{table, Identity, ScheduleAt, Timestamp};

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

/// A ban applied to an account. One row per banned username; presence
/// of a row means the account is banned. Stored in a separate table
/// (instead of a `banned` flag on auth_record) because String columns
/// can't take a `#[default(...)]` migration value, and using a side
/// table avoids the destructive re-publish needed to add new columns
/// without defaults.
///
/// Login looks up by username via the primary-key index; a hit causes
/// the login to reject with a message that includes the reason. The
/// admin panel lists every row in this table for the "banned players"
/// section + offers an unban button which deletes the row.
#[table(name = ban_record, public)]
pub struct BanRecord {
    /// Lowercased username — same key shape as auth_record.username
    /// so the join is trivial. Primary key.
    #[primary_key]
    pub username: String,
    /// Free-text reason the admin gave when banning. Surfaced in the
    /// rejected-login error message and in the admin panel.
    pub reason: String,
    pub banned_at: Timestamp,
    /// Identity of the admin who issued the ban. Logged for audit
    /// purposes; not currently shown in the UI.
    pub banned_by: Identity,
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

    /// Phase H.22 — pending end-of-visit rollup for guests the server
    /// despawned while the foreground client wasn't running. The
    /// server-side settle path (see tick_guest_state's despawn block)
    /// increments these every time it processes a guest whose
    /// dishes_settled flag was still false. On reconnect / foreground,
    /// the client reads these from the Restaurant subscription, applies
    /// them to local Game state (money, served counter, reputation
    /// rating history), and calls consume_pending_visit_rollup to
    /// zero them out atomically.
    ///
    /// All four default to 0 — migration-safe primitive defaults. At
    /// end-of-struct so the addition is a non-destructive publish.
    #[default(0u32)]
    pub pending_served: u32,
    #[default(0i64)]
    pub pending_tips_cents: i64,
    /// Sum of approximated star ratings × 100 across pending guests.
    /// Combined with pending_rating_count to compute an average
    /// rating to apply via Game.reputation.recordRating(avg).
    #[default(0i64)]
    pub pending_rating_sum_x100: i64,
    #[default(0u32)]
    pub pending_rating_count: u32,

    /// Phase H.28 — Cached furniture aggregate stats. The client
    /// recomputes these on every place/move/sell and pushes them via
    /// update_restaurant_aggregates. The server reads them in
    /// accumulate_pending_visit_rollup to apply the vibe + bathroom
    /// modifiers exactly the way the foreground client's
    /// finalizeVisit does (the catalog lookups for style / comfort /
    /// ratingBonus / per-piece bathroom quality only exist in the
    /// client's TS data files, so caching the aggregates is cheaper
    /// than porting the catalog to Rust).
    ///
    /// Stored × 100 so the server can do integer arithmetic. Default
    /// 0 — a restaurant whose client never pushed these reads as
    /// "no furniture vibe / empty bathroom," matching the old
    /// no-modifier behaviour for backgrounded play.
    #[default(0i32)]
    pub cached_style_x100: i32,
    #[default(0i32)]
    pub cached_comfort_x100: i32,
    #[default(0i32)]
    pub cached_rating_bonus_x100: i32,
    /// Sum of style + comfort + 2×attractionBonus + 20×ratingBonus
    /// across BATHROOM-category placed furniture. Normalized
    /// server-side by /18 capped at 1.0 to match the client's qNorm.
    #[default(0i32)]
    pub cached_bathroom_quality_x100: i32,

    /// Phase H.30 — Server-side visual day clock. day_elapsed_ms
    /// counts up by dt_ms in restaurant_tick; every time it crosses
    /// DAY_LENGTH_MS (720_000 = 12 real minutes per game day) we
    /// subtract one full day's worth from it and bump
    /// pending_days_advanced. The foreground client periodically
    /// pushes its local elapsed via sync_day_clock so the cloud
    /// clock stays yoked while the tab is alive; backgrounded tabs
    /// let pending_days_advanced grow until the next
    /// consume_pending_day_advancement.
    ///
    /// All i64 / u32 with primitive 0 defaults — migration-safe
    /// end-of-struct additions.
    #[default(0i64)]
    pub day_elapsed_ms: i64,
    #[default(0u32)]
    pub pending_days_advanced: u32,

    /// Phase H.32 — Live cloud-side mirror of the player's current
    /// money, in cents. The foreground client pushes its absolute
    /// economy.getMoney() value via set_cloud_money on a few-second
    /// cadence; the server's H.22 pending_tips accrual ALSO bumps
    /// this directly during backgrounded play so visiting friends /
    /// the leaderboard see a near-current value instead of the
    /// autosave-stale save_snapshot.money.
    ///
    /// Distinct from save_snapshot.money: that column is a
    /// denormalized field on the JSON-blob save row, updated only
    /// when the client autosaves (~30 s cadence). cloud_money_cents
    /// is meant as the live observation channel for other clients +
    /// for the leaderboard to read without parsing the JSON.
    ///
    /// Default 0 — primitive i64, migration-safe end-of-struct add.
    /// Client's first sync_cloud_money fires shortly after spawn so
    /// the row stops reading as "$0".
    #[default(0i64)]
    pub cloud_money_cents: i64,
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

/// Per-player save snapshot, keyed directly by Identity (one save per
/// account, which matches today's "everyone has one restaurant"
/// model). This is distinct from the older `save_snapshot` table that
/// keys by Restaurant.id and goes through a Restaurant row — when P4
/// visitor mode landed we needed a single canonical save per player
/// to fetch by identity, and threading every save through a created
/// Restaurant row added needless ceremony. The legacy table stays
/// for the multi-restaurant future; this one drives visit mode.
///
/// Public so any client can subscribe + render another player's
/// restaurant. Capped at 512 KB by the reducer (today's saves are
/// ~20-50 KB so there's plenty of headroom).
#[table(name = player_save, public)]
pub struct PlayerSave {
    /// Owning player. One row per identity.
    #[primary_key]
    pub identity: Identity,
    /// JSON-serialized SaveGameState.
    pub data: String,
    /// Denormalized stats so the visit UI can show "$12k · Day 5 ·
    /// 4.3 stars" without parsing the blob.
    pub day_number: u32,
    pub money: i64,
    pub rating_avg: f32,
    pub luxury_tier: u32,
    pub updated_at: Timestamp,
    /// Whether the restaurant is currently open for business. The
    /// P5 attraction layer skips closed plots when picking the next
    /// walker's target. `#[default(true)]` so existing rows from
    /// before this column was added survive the migration as
    /// "assumed open" — players notice + start publishing the real
    /// value within their first autosave.
    #[default(true)]
    pub restaurant_open: bool,
    /// Functional seats currently free. Lets the attraction layer
    /// skip full restaurants — no point sending another walker who'll
    /// bounce off a full waiting area. Default 4 = a tiny baseline
    /// so legacy rows count as "has some seats" until autosaved.
    #[default(4)]
    pub free_seats: u32,
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

/// P5.8 — a single visit event. The visitor's client inserts a row
/// via record_visit when entering VisitMode; the host's client picks
/// the row up via subscription and renders a toast. Rows are
/// append-only — periodic cleanup is future work, but each row is
/// tiny and the table won't grow fast in practice.
#[table(name = visit_event, public)]
pub struct VisitEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Identity of the player who entered visit mode. Used to look
    /// up the display name for the host's toast.
    #[index(btree)]
    pub visitor: Identity,
    /// Identity of the visited plot's owner. The host's client
    /// filters incoming events to ones where host == self.
    #[index(btree)]
    pub host: Identity,
    pub visited_at: Timestamp,
}

/// P5 — a single shared pedestrian walking one of the city's avenues.
/// Stored as a "trajectory" (start, end, spawn time, duration) so the
/// client computes the current position by lerping with the elapsed
/// real time. No per-frame server updates needed; the scheduled
/// pedestrian_tick reducer only fires every couple of seconds to
/// spawn new ones + despawn ones whose trajectory has elapsed.
///
/// All clients subscribe to this table → everyone sees the same
/// pedestrians at the same time, no matter which plot they own.
/// Variant is the character GLB id ("guest-v0" .. "guest-v6") so the
/// shared crowd looks varied.
#[table(name = pedestrian, public)]
pub struct Pedestrian {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// World X coordinate at spawn.
    pub start_x: f32,
    /// World Z coordinate at spawn.
    pub start_z: f32,
    /// World X coordinate at despawn.
    pub end_x: f32,
    /// World Z coordinate at despawn.
    pub end_z: f32,
    /// When this pedestrian was spawned. Client lerps using
    /// (now - spawn_at) / duration_micros.
    pub spawn_at: Timestamp,
    /// Total trip duration in microseconds. Client despawns the
    /// rendered model once (now - spawn_at) > duration; the
    /// pedestrian_tick reducer removes the row shortly afterwards.
    pub duration_micros: i64,
    /// Character GLB id — one of the GUEST_VARIANT_IDS list in the
    /// client. Server picks pseudo-randomly via ctx.rng().
    pub variant: String,
    /// Set when this pedestrian is on its way to a specific plot's
    /// door (a "potential customer"). The trajectory ends at the
    /// plot's south-door position instead of the avenue's far end.
    /// When the pedestrian despawns, the plot owner's client picks
    /// up the event and spawns the customer in their local
    /// GuestSpawner. Zero = no target (just an ambient walker).
    pub target_plot_id: u64,
}

/// Global weather state shared by every connected client. Exactly
/// one row (id=1) maintained by the periodic weather_roll reducer;
/// clients subscribe and render whichever `kind` is currently set.
/// Making this server-side means rain in player A's town is rain
/// in player B's town at the same moment — same wallclock weather
/// across the whole map, instead of each client rolling its own.
///
/// `kind` is the same id the client's WeatherSystem already uses
/// ("sunny", "cloudy", "rainy", "heavy-rain", "festival", "cold",
/// "snowy"). The client falls back to "sunny" if the value is
/// missing or unknown.
#[table(name = weather_state, public)]
pub struct WeatherState {
    #[primary_key]
    pub id: u32,
    pub kind: String,
    /// When this weather started — clients can show a "since X
    /// minutes ago" hint if they want. Mostly diagnostic.
    pub since: Timestamp,
}

/// Scheduled-tick row that drives weather_roll. Single Interval
/// scheduled row inserted in init / bootstrap_weather_schedule
/// so the server picks a new weather every ~8 real minutes.
#[table(name = weather_schedule, scheduled(crate::reducers::weather_roll))]
pub struct WeatherSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

/// Periodic schedule row that triggers the pedestrian_tick reducer.
/// The init lifecycle reducer inserts ONE row with an Interval
/// schedule (every ~2 seconds); the SDK then fires pedestrian_tick on
/// that cadence until the row is deleted. The reducer itself lives
/// in reducers::pedestrians and is re-exported through reducers::mod
/// so the `scheduled(...)` attribute below resolves it via the crate
/// root.
#[table(name = pedestrian_tick_schedule, scheduled(crate::reducers::pedestrian_tick))]
pub struct PedestrianTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

/// P8 — a single chat message. One row per sent message. Used for
/// both the global channel and private 1:1 conversations; the
/// `channel` string distinguishes them:
///   - "global"       → everyone sees it
///   - "pm:<idA>|<idB>" → 1:1 conversation, where idA, idB are the
///     lowercased hex Identity strings of the two participants
///     sorted lexicographically (so each pair gets a stable channel
///     id regardless of which side sent the message)
///
/// `public` is necessary because subscriptions are per-table, not
/// per-row — every client sees every row. Clients filter by channel
/// to render only what's relevant for the currently-active tab.
/// Server-side rate limiting + a global row cap keep storage bounded.
///
/// Each chat tab in the client subscribes to changes on this table
/// and pulls the channel-filtered subset on each update.
#[table(name = chat_message, public)]
pub struct ChatMessage {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Sender Identity. Display name is resolved on the client by
    /// joining against auth_record / player.
    #[index(btree)]
    pub sender: Identity,
    /// Channel identifier — "global" or "pm:<hex_a>|<hex_b>" where
    /// hex_a < hex_b lexicographically. Indexed so the client's
    /// channel-filtered iteration is fast.
    #[index(btree)]
    pub channel: String,
    /// Message body. Server caps at 500 chars and rejects empty.
    pub text: String,
    pub sent_at: Timestamp,
}

/// P8 — periodic chat cleanup tick. Fires every ~5 min to delete
/// chat messages older than the retention window (configured in
/// the reducer) so the table stays bounded. Same pattern as
/// pedestrian_tick_schedule — single Interval row inserted at init.
#[table(name = chat_cleanup_schedule, scheduled(crate::reducers::chat_cleanup))]
pub struct ChatCleanupSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
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

/// Server-authoritative simulation — per-restaurant scheduled tick row.
/// One row per restaurant; each fires `restaurant_tick` at a fixed
/// interval so the live simulation (guests, tickets, staff actors)
/// advances on the server. Inserted by `create_restaurant`; removed
/// by `delete_restaurant`.
///
/// The schedule row carries `restaurant_id` so the reducer knows which
/// restaurant to step. SpacetimeDB passes the scheduled row to the
/// reducer as the second argument — that's how the dispatch fans out
/// per-restaurant without a global table scan on each tick.
///
/// Skeleton in Phase A4. The reducer doesn't simulate anything yet;
/// Phase B (guest spawning) lights up the first real branch.
#[table(name = restaurant_tick_schedule,
        scheduled(crate::reducers::restaurant_tick))]
pub struct RestaurantTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
    /// Which restaurant this schedule row drives. Used by the
    /// `restaurant_tick` reducer to look up the per-restaurant state
    /// it should advance.
    #[index(btree)]
    pub restaurant_id: u64,
}

/// Per-restaurant tick bookkeeping — when the last `restaurant_tick`
/// ran for this restaurant. Used by the reducer to compute dt in
/// microseconds; also used by the leak watcher / dev tools to confirm
/// the schedule is actually firing. One row per restaurant, upserted
/// by the first tick after creation.
#[table(name = restaurant_tick_state, public)]
pub struct RestaurantTickState {
    #[primary_key]
    pub restaurant_id: u64,
    pub last_tick_at: Timestamp,
    /// Monotonic counter of how many ticks have run. Useful for the
    /// dev banner ("server tick #N") + sanity-checking that the
    /// schedule didn't silently stop.
    pub tick_count: u64,
}

/// Phase B — server-authoritative guest. One row per live customer in
/// a restaurant from spawn (walking in) through despawn (leaving). The
/// scheduled `restaurant_tick` advances each row's state machine; the
/// client (when `serverSim.guests` is on) renders character poses
/// from the row + lerps body position toward `(target_x, target_z)`.
///
/// Same architecture as P5 pedestrians but with a richer state
/// machine. Pathfinding stays on the client for Phase B — server
/// publishes only the next destination; the client routes around
/// placed furniture locally. A future phase can port Pathfinding to
/// Rust if we need to validate routes server-side.
///
/// All struct fields are CONCRETE columns (no JSON blobs) per the
/// "split it" design review. CustomerTaste's six fields each get
/// their own column; same for any other nested struct we'd otherwise
/// have pickled.
#[table(name = active_guest, public)]
pub struct ActiveGuest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub restaurant_id: u64,

    /// Client-side correlation id. The local GuestSpawner generates
    /// these as "guest-N"; the client passes this through spawn_guest
    /// so it can later find its own row in the subscription cache
    /// without a server round-trip to learn the auto-inc id. Indexed
    /// for the matching read pattern. Phase B.3b (mirror mode) uses
    /// this; later phases that go fully server-authoritative can
    /// retire it once the server owns spawn timing.
    ///
    /// (No #[default] — String defaults aren't const-evaluable by the
    /// macro. Adding this column required `spacetime publish
    /// --delete-data=on-conflict` once. Future column additions on
    /// active_guest with default-able primitive types should use
    /// #[default(...)] instead.)
    #[index(btree)]
    pub client_temp_id: String,

    // === Identity / kind ===
    /// Character GLB id — "guest-v0".."guest-v6". Set at spawn from
    /// the pedestrian's `variant` so the same body that walked up
    /// keeps walking in.
    pub variant: String,
    /// CustomerArchetype enum value as a string. Drives patience
    /// scale + order size + tip multiplier. See client
    /// data/customerArchetypes.ts.
    pub archetype: String,

    // === CustomerTaste — expanded out of the JSON blob ===
    /// "food" | "drink" | "both" — hard filter on what they'll order.
    pub taste_diet: String,
    /// 0..1, how much nearby decor quality matters to their rating.
    pub taste_decor_pref: f32,
    /// 0..1, how much window adjacency matters.
    pub taste_window_pref: f32,
    /// Recipe category id ("appetizer", "main", "side", "drink", "dessert")
    /// they have an affinity for, or "" = no bias.
    pub taste_cuisine_bias: String,
    /// 0..1, how forgiving they are of drinks-only options when food
    /// is what they wanted (and vice versa).
    pub taste_drink_tolerance: f32,
    /// Rolled at spawn from the archetype's wcUseChance. True for
    /// heavy bathroom users — adds the WC detour after seated and
    /// makes bathroom quality matter to their final rating.
    pub will_use_toilet: bool,

    // === State machine ===
    /// One of: "walkingIn", "seated", "ordering", "waitingForFood",
    /// "eating", "leaving", "waiting" (overflow chair), "wcWalking",
    /// "wcSitting", "wcWashing", "done". The reducer's
    /// tick_guest_state transitions between these.
    pub state: String,
    /// Time spent in the current state, in milliseconds. Reset on
    /// each state transition.
    pub state_clock_ms: i64,
    /// Patience countdown — milliseconds before this guest gives up
    /// and leaves angry. Resets at state transitions that re-arm it
    /// (e.g. seated → ordering).
    pub patience_ms: i64,

    // === Seat assignment (nullable until they actually sit) ===
    /// Furniture uid of the assigned seat, or "" if waitlisted.
    pub seat_uid: String,
    pub seat_x: f32,
    pub seat_z: f32,
    pub seat_facing_y: f32,
    pub seat_floor: u32,
    /// True when the assigned seat lives at a bar counter (vs a
    /// regular dining/coffee table). Routes their order request to
    /// a barman instead of a waiter.
    pub seat_at_bar: bool,
    /// World plate position on the table — where the served dish
    /// renders. Computed at seat-assignment time from the seat slot.
    pub plate_x: f32,
    pub plate_z: f32,

    // === Body (position the client lerps toward target_*) ===
    pub x: f32,
    pub z: f32,
    pub floor: u32,
    pub target_x: f32,
    pub target_z: f32,
    pub target_floor: u32,

    // === Order ===
    /// Comma-separated recipe ids in the order the guest wants them
    /// served. Empty until ordering completes.
    pub order_recipes: String,
    /// Index of the course currently being cooked / delivered /
    /// eaten. 0 until the first ticket is created.
    pub order_index: u32,
    /// Ticket id from active_ticket for the current course, or None
    /// between courses.
    pub ticket_id: Option<u64>,
    /// CSV of tier numbers (u32 each) for plates / glasses already
    /// reserved by this guest. Index N is the tier of the plate
    /// reserved for course N. Capped at 5 entries (one per course).
    pub reserved_dish_tiers: String,

    // === Overflow waitlist (nullable until they're waitlisted) ===
    /// Furniture uid of the yellow overflow chair they're parked at,
    /// or "" when not waitlisted.
    pub waiting_chair_uid: String,
    /// Milliseconds left before a waitlisted guest gives up. Counts
    /// down only while state == "waiting".
    pub waiting_timeout_ms: i64,

    // === Bookkeeping ===
    /// Money this guest will pay (accumulates as courses are served).
    /// Stored in cents to avoid f32 drift over a long meal.
    pub total_paid_cents: i64,
    /// Cumulative satisfaction × 100 across courses; final rating
    /// averages this. Same i32 × 100 trick as elsewhere.
    pub total_satisfaction_x100: i32,
    /// True once settleGuestDishes-equivalent has run server-side.
    /// Mirrors the dishesSettled idempotency flag on the client's
    /// ActiveGuest — every despawn path checks it.
    pub dishes_settled: bool,
    pub spawned_at: Timestamp,

    /// Section A migration — Furniture uid of the toilet or sink the
    /// guest is currently using (set during wcWalking → wcSitting →
    /// wcWashing). Independent from seat_uid so the server can
    /// remember the dining seat to return to after washing.
    ///
    /// Option<String> default None (same migration-safe pattern as
    /// StaffActor.delivery_phase per the lessons-learned doc — bare
    /// String::new() defaults aren't const-evaluable by the macro,
    /// so we use Option<T> for ALL new String columns on populated
    /// tables).
    ///
    /// IMPORTANT: must stay at the end of the struct so this column
    /// addition is a non-destructive publish.
    #[default(None::<String>)]
    pub wc_target_uid: Option<String>,

    /// Phase H.14 — Per-course appliance ids parallel to
    /// order_recipes. e.g. "stove,toaster,coffee" matches a 3-course
    /// order_recipes "burger,toast,latte". Lets the server's
    /// auto-place-order step look up which appliance each course
    /// needs without reading the TS recipe catalog.
    ///
    /// End-of-struct + Option<String> + default None per the
    /// lessons-learned migration pattern.
    #[default(None::<String>)]
    pub order_appliances: Option<String>,

    /// Phase H.14 — Per-course cook times (ms) parallel to
    /// order_recipes. CSV of u32 strings (e.g. "5000,3500,4000").
    /// Server's auto-place-order parses one entry per course and
    /// passes it as base_cook_seconds_ms on the active_ticket row.
    #[default(None::<String>)]
    pub order_cook_seconds_csv: Option<String>,

    /// Phase H.15 — Door coords (restaurant-local) so the server
    /// can route guests back to the entrance when transitioning to
    /// "leaving". spawn_guest stores these from the door_x/z/floor
    /// parameters; tick_guest_state's eating→leaving transition
    /// rewrites target_x/z to these so the H.2 step walks the
    /// guest out instead of leaving them frozen at the seat.
    ///
    /// f32 + const default: 0.0 / 5.45 / 0 matches the canonical
    /// Floor 0 door coordinates the existing restaurant layout
    /// uses, so legacy rows that predate the column still walk to
    /// a sensible spot.
    #[default(0.0)]
    pub door_x: f32,
    #[default(5.45)]
    pub door_z: f32,
    #[default(0)]
    pub door_floor: u32,

    /// Phase H.16 — Per-course prices (cents) parallel to
    /// order_recipes. CSV of i64 strings. Server credits the
    /// guest's total_paid_cents on eating-completion of each
    /// course (the row counter is observation-only; the actual
    /// player money credit still happens client-side via
    /// Game.economy.earnMoney).
    #[default(None::<String>)]
    pub order_prices_csv: Option<String>,
    /// Phase H.16 — Per-course satisfaction ×100 parallel to
    /// order_recipes. CSV of i32 strings. Server credits the
    /// guest's total_satisfaction_x100 on eating-completion.
    #[default(None::<String>)]
    pub order_satisfactions_csv: Option<String>,

    /// Phase H.17 — Archetype patience multiplier × 100. The client's
    /// customerArchetypes table tags each archetype with a
    /// patienceMultiplier in the [0.5, 1.5] range (heavy customers wait
    /// longer; impatient ones leave faster). Stored as ×100 to keep the
    /// schema in integers; tick_guest_state multiplies the
    /// ORDER/SERVE base values by this on patience refreshes so a
    /// backgrounded tab's server-driven impatience matches what the
    /// local sim would have produced.
    ///
    /// Default 100 (= 1.0×) — legacy rows behave like the previous flat
    /// DEFAULT_PATIENCE_MS path.
    #[default(100)]
    pub patience_mult_x100: i32,

    /// Phase H.23 — Latch that the server-side WC attempt has resolved.
    /// True once either (a) the guest completed the toilet → wash cycle
    /// (wcWashing → seated transition sets it), OR (b) the seated WC-
    /// initiation branch ran the give-up countdown to 0 because no
    /// free toilet was available. Gates the seated → wcWalking branch
    /// so a guest who finished one trip doesn't immediately go again.
    ///
    /// Independent from will_use_toilet — that's the spawn-time "this
    /// archetype is a WC user" roll, set by the client and read-only
    /// after spawn. used_toilet is the runtime "did it actually happen
    /// or finalize" flag.
    ///
    /// Default false (= "not yet attempted") matches the spawn case for
    /// existing rows. Primitive bool default — migration-safe.
    #[default(false)]
    pub used_toilet: bool,

    /// Phase H.24 — Spawn-time roll, mirrored from the client. True
    /// for guests who'll attempt a pre-meal handwash (without a
    /// toilet detour first). Mutually exclusive with will_use_toilet
    /// in the client's spawn code, but the schema doesn't enforce
    /// that — both being true would just walk the toilet path because
    /// it tries first.
    #[default(false)]
    pub will_wash_only: bool,
    /// Phase H.24 — Latch that the wash-only attempt resolved. Same
    /// shape as used_toilet (true on completion OR give-up). For
    /// toilet trips the wcWashing → seated transition sets BOTH this
    /// AND used_toilet because the toilet flow ends with a sink wash.
    /// For wash-only trips only washed_hands flips.
    #[default(false)]
    pub washed_hands: bool,

    /// Phase H.29 — distinguishes "successful trip" from "gave up
    /// because every fixture was busy."  used_toilet / washed_hands
    /// latch on both paths so the seated state machine doesn't loop;
    /// wc_completed latches ONLY on cycle completion (wcWashing →
    /// seated transition). accumulate_pending_visit_rollup reads it
    /// to apply "wanted but couldn't" rating penalties separately
    /// from "successfully visited" bonuses. Default false; primitive
    /// bool — migration-safe end-of-struct add.
    #[default(false)]
    pub wc_completed: bool,
}

/// Phase C — server-authoritative cooking ticket. One row per
/// dish-in-flight from "ordered" through "delivered". The scheduled
/// restaurant_tick advances cook_seconds; client reducers (claim,
/// finish, deliver) drive the state transitions the server can't
/// own on its own (chef assignment, waiter pickup, delivery
/// confirmation — those live in client-rendered space until the
/// staff state machine moves server-side in Phase D).
///
/// guest_id is a foreign key into active_guest.id; the server side
/// keeps the relationship explicit so a guest-deleted cascade is
/// straightforward. The client_temp_id field lets the local
/// StaffRouter correlate its own ticket id ("ticket-12") with the
/// server's auto-inc u64.
#[table(name = active_ticket, public)]
pub struct ActiveTicket {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub restaurant_id: u64,
    #[index(btree)]
    pub guest_id: u64,
    /// Client's temp id (e.g. "ticket-12"). Used to find the
    /// server's auto-inc id from the subscription cache after spawn.
    #[index(btree)]
    pub client_temp_id: String,

    /// Recipe id from the client's recipeCatalog.
    pub recipe_id: String,
    /// "queued" | "cooking" | "ready" | "delivering" | "delivered"
    pub state: String,
    /// State-machine clock; ms elapsed in the current state. Reset
    /// on each transition.
    pub state_clock_ms: i64,

    /// Base cook time from the recipe (ms). Immutable across the
    /// ticket's lifetime — multipliers apply at chef-claim time and
    /// get folded into cook_seconds_ms, NOT this.
    pub base_cook_seconds_ms: i64,
    /// Effective cook time = base × current chef's multiplier. Set
    /// on claim. Compared against state_clock_ms while state="cooking"
    /// to know when the ticket flips to "ready".
    pub cook_seconds_ms: i64,
    /// Appliance the recipe needs ("stove", "oven", "counter", ...).
    pub appliance: String,

    /// Client memberId of the chef currently working this ticket, or
    /// "" when unclaimed. Per-chef-backlog routing uses this to
    /// distribute load.
    pub assigned_chef_id: String,

    /// Seat the plate goes to. Denormalised from the guest row so
    /// chef + waiter routing can read these without joining.
    pub seat_x: f32,
    pub seat_z: f32,
    pub seat_floor: u32,
    pub seat_at_bar: bool,

    /// Where the finished plate sits waiting for a waiter. Set on
    /// state="ready" transition; (0,0,0) until then.
    pub pickup_x: f32,
    pub pickup_z: f32,
    pub pickup_floor: u32,

    pub created_at: Timestamp,
}

/// Phase D — server-authoritative staff actor. One row per hired
/// member currently dispatched into a restaurant — chefs, waiters,
/// barmen, and the single errand helper. Persists across guests +
/// tickets; deleted on hire-reverse (fire) or restaurant deletion.
///
/// The local StaffRouter's `StaffActor` shape has 25+ fields driven
/// by tight per-frame logic. This server row captures the
/// SUBSCRIBABLE subset — the state-machine label, the position the
/// client lerps toward, the ticket / station / wash references —
/// without re-implementing the per-frame routing. Phase D mirrors
/// from the local sim; the full server-side state machine port lands
/// when Phases D.4+ rewrites the routing logic in Rust.
///
/// member_id is the primary key because that's the stable id the
/// client's HiredStaffMember already uses; mapping back from a
/// server row to its local actor is a direct string match (no
/// auto_inc correlation needed).
#[table(name = staff_actor, public)]
pub struct StaffActor {
    /// Matches HiredStaffMember.id on the client. Stable across the
    /// member's lifetime, so we use it as the PK instead of an
    /// auto-inc id (no client_temp_id correlation needed here).
    #[primary_key]
    pub member_id: String,
    #[index(btree)]
    pub restaurant_id: u64,

    /// "chef" | "waiter" | "barman" | "errand"
    pub role: String,
    /// Storey this actor is assigned to. Chefs only claim stations on
    /// this floor; waiters only deliver to seats on this floor.
    pub home_floor: u32,
    pub home_x: f32,
    pub home_z: f32,

    /// "idle" | "movingToWork" | "working" | "returningHome"
    pub state: String,
    /// Per-state timer (ms). Reset on transition.
    pub state_clock_ms: i64,
    /// Ticket they're currently bound to, or None when idle / returning.
    pub ticket_id: Option<u64>,

    // === Body ===
    pub x: f32,
    pub z: f32,
    pub floor: u32,
    pub target_x: f32,
    pub target_z: f32,
    pub target_floor: u32,

    // === Role-specific (empty strings / nulls when N/A) ===
    /// Chef / barman only: uid of the stove / bar station they're
    /// reserving. "" = unreserved.
    pub assigned_stove_uid: String,
    /// Chef only: most recently used stove uid, for their idle-loiter
    /// anchor. "" = never cooked.
    pub last_stove_uid: String,

    // === Waiter wash trip (expanded from the WashTrip blob) ===
    /// Furniture uid of the wash station the waiter is heading for,
    /// or "" when not on a wash trip.
    pub wash_target_uid: String,
    /// Id of the dirty piece they're carrying, or -1 when no wash trip
    /// OR when the trip is in the "go pick up the dirty" leg.
    pub wash_dirty_id: i64,
    /// "" | "pickup" | "scrub" | "drop"
    pub wash_phase: String,

    /// Waiter only: guest_id they're walking to in order to take an
    /// order, or None when not on a take-order trip.
    pub take_order_guest_id: Option<u64>,

    pub spawned_at: Timestamp,

    /// H.8 — Waiter delivery phase. None when not on a delivery,
    /// Some("pickup") while walking to the plate at the kitchen,
    /// Some("deliver") while carrying the plate to the seat.
    /// Distinguishes the two movingToWork legs of a delivery so
    /// the server's arrival-flip knows whether to transition into
    /// the carrying-plate leg or to mark the ticket delivered.
    ///
    /// IMPORTANT — must stay at the END of the struct. Inserting it
    /// mid-struct counts as reordering and trips
    /// "manual migration required" on a non-destructive publish.
    /// Option<String> + default None keeps the row migration safe
    /// for existing populated rows.
    #[default(None::<String>)]
    pub delivery_phase: Option<String>,
}

/// Phase F — server-authoritative placed furniture. One row per item
/// the player has built into a restaurant. Persists indefinitely
/// (until sold) — no per-tick state, so no tick dispatch needed.
///
/// uid is the primary key directly: the client generates a stable
/// id at placement time (UUID-ish string) and uses it for every
/// subsequent reference. Same pattern as staff_actor.member_id —
/// no client_temp_id correlation needed because the client owns
/// the id from the moment it fires `place_furniture`.
///
/// parent_uid + slot_index + local_rot_y track the surface-host
/// link for items that sit ON other items (toasters on counters,
/// books on shelves). Empty string / -1 when free-standing.
#[table(name = placed_furniture, public)]
pub struct PlacedFurniture {
    /// Client-supplied unique id. Stable across the placement's
    /// lifetime; the client uses the same uid in localStorage saves.
    #[primary_key]
    pub uid: String,
    #[index(btree)]
    pub restaurant_id: u64,

    /// Catalog id from data/furnitureCatalog.ts (e.g. "counter",
    /// "stove", "int-wall").
    pub def_id: String,
    pub x: f32,
    pub z: f32,
    pub rot_y: f32,
    pub floor: u32,

    /// uid of the host item this one sits ON, or "" when free-
    /// standing. Surface placement (toasters, lamps) only.
    pub parent_uid: String,
    /// Slot index within the host's surfaceSlots array, or -1 when
    /// not on a surface.
    pub slot_index: i32,
    /// Local rotation offset relative to the host's facing. Lets a
    /// player press R on a toaster to turn it 90° on the counter.
    pub local_rot_y: f32,
}

/// Phase E — server-authoritative dishware pool. One row per
/// (restaurant, kind, tier) triple. clean + dirty counts mirror the
/// client's DishwareSystem pools. Reservations held by mid-meal
/// guests live on active_guest.reserved_dish_tiers — this table is
/// only the persistent pool, not the in-flight set.
///
/// Composite primary key encoded as "{restaurant_id}:{kind}:{tier}"
/// — single PK lookups + the btree on restaurant_id covers
/// per-restaurant iteration.
#[table(name = dishware_pool, public)]
pub struct DishwarePool {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub restaurant_id: u64,
    /// "plate" | "glass"
    pub kind: String,
    pub tier: u32,
    pub clean: u32,
    pub dirty: u32,
}

/// Phase E — mid-cycle state of a placed dishwasher. The client's
/// DishwareSystem.update(dt) ticks the cycle locally; this row is
/// the snapshot a subscribed client can read to see "this dishwasher
/// has 8 plates 1.4 s from finishing." Updated on every load + every
/// time the cycle clock changes meaningfully.
///
/// Keyed on the dishwasher's furniture uid (matches the same id used
/// in placed_furniture) — when the dishwasher is sold the row goes
/// away alongside it via a separate delete call.
#[table(name = dishwasher_batch, public)]
pub struct DishwasherBatch {
    #[primary_key]
    pub furniture_uid: String,
    #[index(btree)]
    pub restaurant_id: u64,
    /// "dishwasher" | "dishwasher-pro"
    pub def_id: String,
    pub plates: u32,
    pub glasses: u32,
    pub cycle_time_remaining_ms: i64,
}

/// Phase H.36 — per-restaurant pantry stock mirror. One row per
/// (restaurant_id, ingredient_id) pair, keyed by the composite
/// "{restaurant_id}:{ingredient_id}" string. Quantity reflects how
/// many units of that ingredient the restaurant currently has on
/// hand.
///
/// Observational only at this layer: the client's CookingSystem
/// remains the source of truth in foreground play, mirroring every
/// consume / addStock via the bump_pantry_stock reducer.  Visit-mode
/// + leaderboard + future co-owner views read live counts here
/// instead of waiting for the periodic save_snapshot.
///
/// Server-side consumption ships in H.37 — auto_place_next_course
/// reads recipe_ingredients to know what to decrement on ticket
/// insert.
#[table(name = pantry_stock, public)]
pub struct PantryStock {
    /// Composite key: "{restaurant_id}:{ingredient_id}".
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub restaurant_id: u64,
    /// Ingredient id from the client's catalog (e.g. "tomato",
    /// "bread", "beef"). Server doesn't validate against the
    /// catalog — any string the client pushes is accepted.
    pub ingredient_id: String,
    /// Current stock count. Saturating math on underflow.
    pub quantity: u32,
}

/// Phase H.37 — static recipe → ingredient-list lookup. One row per
/// recipe id; the client seeds this from src/data/recipes.ts at boot
/// via set_recipe_ingredients. The server's auto_place_next_course
/// reads it to decrement pantry_stock when creating a ticket for an
/// offline owner, closing the "backgrounded play cooks without
/// consuming ingredients" loophole.
///
/// Pipe-separated ingredient ids — e.g. "bread|butter" for the toast
/// recipe. Each occurrence counts as one unit consumed. Empty string
/// = no ingredients (mostly catalog-edge-case recipes).
///
/// Catalog data, not per-player. Survives publishes (no per-row
/// mutation in normal play); first run after a publish re-seeds.
#[table(name = recipe_ingredients, public)]
pub struct RecipeIngredients {
    #[primary_key]
    pub recipe_id: String,
    pub ingredients: String,
}

/// Phase H.38 — static customer archetype catalog. One row per
/// archetype defined in src/data/customerArchetypes.ts; seeded by
/// the client at boot via set_customer_archetype. The server's
/// try_spawn_arrival_guest reads it to pick a weighted archetype
/// (instead of hardcoded "regular") + apply the patience multiplier
/// and WC-use-chance roll, so a backgrounded-tab guest spawned via
/// H.33 has the same flavor distribution as a foreground spawn.
///
/// All scalars × 100 / × N to stay in integer space:
///   - weight is the raw integer from the catalog (sums to ~100)
///   - patience_mult_x100: 100 = 1.0× (server uses scale_patience)
///   - tip_mult_x100: 100 = 1.0× (informational; server doesn't tip
///     yet, but mirrored so future work can use it)
///   - order_size_bias: -1 | 0 | 1
///   - wc_use_chance_x100: 0..100, probability×100 the guest opts
///     into a toilet trip
#[table(name = customer_archetype, public)]
pub struct CustomerArchetypeDef {
    #[primary_key]
    pub archetype_id: String,
    pub weight: u32,
    pub patience_mult_x100: i32,
    pub tip_mult_x100: i32,
    pub order_size_bias: i32,
    pub wc_use_chance_x100: i32,
}
