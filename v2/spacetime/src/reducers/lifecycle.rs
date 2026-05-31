//! Init + connect/disconnect hooks. These are special lifecycle reducers
//! called automatically by SpacetimeDB; they don't need a client RPC.

use spacetimedb::{reducer, ReducerContext, ScheduleAt, Table, TimeDuration};
use crate::tables::{
    player, pedestrian_tick_schedule, chat_cleanup_schedule,
    Player, PedestrianTickSchedule, ChatCleanupSchedule,
};

/// Runs once when the module is first published. Anything that needs a
/// seed (default values, system messages, building inventory, etc)
/// goes here.
#[reducer(init)]
pub fn init(ctx: &ReducerContext) {
    log::info!("Cozy Bistro module initialized");
    // Seed the city buildings if the table is empty (first publish
    // or after a manual reset). Subsequent re-publishes preserve
    // existing rows.
    crate::reducers::buildings::seed_buildings_if_empty(ctx);
    // P5 — start the periodic pedestrian_tick. Interval schedule
    // means the row persists and the reducer fires every interval.
    // We only insert ONE schedule row; subsequent re-publishes
    // detect the existing row and skip (so the tick doesn't pile
    // up after each republish).
    if ctx.db.pedestrian_tick_schedule().iter().next().is_none() {
        ctx.db.pedestrian_tick_schedule().insert(PedestrianTickSchedule {
            id: 0, // auto_inc
            scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(2_000_000)), // 2s
        });
        log::info!("Pedestrian tick schedule installed (every 2s)");
    }
    // P8 — chat cleanup every 5 minutes. Trims expired messages
    // and caps the global channel.
    if ctx.db.chat_cleanup_schedule().iter().next().is_none() {
        ctx.db.chat_cleanup_schedule().insert(ChatCleanupSchedule {
            id: 0,
            scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(5 * 60 * 1_000_000)),
        });
        log::info!("Chat cleanup schedule installed (every 5 min)");
    }
    // Global weather schedule + seed the initial weather_state row.
    // bootstrap_weather is idempotent (skips if either already
    // exists) so it's safe to call from both init AND as a
    // standalone manual reducer after a deploy.
    if let Err(e) = crate::reducers::weather::bootstrap_weather(ctx) {
        log::warn!("bootstrap_weather failed during init: {}", e);
    }
}

/// Called automatically whenever a client connects (after the WebSocket
/// handshake but before they send any reducer). We use it to create the
/// Player row on first sight and bump last_seen_at otherwise. The new
/// row is created in the UNAUTHENTICATED state (username + password_hash
/// = None); the client must call `sign_up` or `login` to populate
/// credentials.
#[reducer(client_connected)]
pub fn on_client_connected(ctx: &ReducerContext) {
    let identity = ctx.sender;
    let now = ctx.timestamp;
    if let Some(p) = ctx.db.player().identity().find(identity) {
        // Returning player — bump last_seen_at.
        ctx.db.player().identity().update(Player {
            last_seen_at: now,
            ..p
        });
    } else {
        // First connect — generate a default name from the identity hash.
        let short = identity.to_hex().chars().take(6).collect::<String>();
        ctx.db.player().insert(Player {
            identity,
            name: format!("Chef #{short}"),
            created_at: now,
            last_seen_at: now,
        });
        log::info!("New player joined: {identity}");
    }
}

/// Player updates their own display name. Anyone else's identity is
/// silently rejected.
#[reducer]
pub fn set_player_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 32 {
        return Err("Name must be 1-32 characters".into());
    }
    let me = ctx.db.player().identity().find(ctx.sender)
        .ok_or_else(|| "Player row missing — reconnect first".to_string())?;
    ctx.db.player().identity().update(Player {
        name: trimmed.to_string(),
        ..me
    });
    Ok(())
}

/// Bump the caller's last_seen_at — clients call this every ~30 s
/// to keep their presence fresh so the "👥 N online" HUD indicator
/// can count them as live. Without this, last_seen_at only updates
/// on (re)connection so a player who's been in the tab for an hour
/// would still report their initial-connect timestamp.
///
/// Cheap: single-row update by primary key. If the player row is
/// missing (shouldn't happen but defensive), silently no-op so a
/// bad reducer call can't stall the client.
#[reducer]
pub fn ping_presence(ctx: &ReducerContext) {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender) {
        ctx.db.player().identity().update(Player {
            last_seen_at: ctx.timestamp,
            ..p
        });
    }
}
