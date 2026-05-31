//! Restaurant CRUD + save snapshots.

use spacetimedb::{reducer, ReducerContext, Identity, Table};
use crate::tables::{restaurant, save_snapshot, co_owner, player_save, visit_event, Restaurant, SaveSnapshot, PlayerSave, VisitEvent};

/// Create a new restaurant owned by the caller.
#[reducer]
pub fn create_restaurant(ctx: &ReducerContext, name: String, public: bool) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 48 {
        return Err("Name must be 1-48 characters".into());
    }
    ctx.db.restaurant().insert(Restaurant {
        id: 0, // auto_inc
        owner: ctx.sender,
        name: trimmed.to_string(),
        public,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Toggle a restaurant's public-ness (whether it appears in friends'
/// browse lists / leaderboards).
#[reducer]
pub fn set_restaurant_public(ctx: &ReducerContext, restaurant_id: u64, public: bool) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can change visibility".into());
    }
    ctx.db.restaurant().id().update(Restaurant { public, ..r });
    Ok(())
}

/// Delete a restaurant and its save snapshot + co-owner rows. Only the
/// owner can delete.
#[reducer]
pub fn delete_restaurant(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can delete".into());
    }
    // Cascade — save_snapshot + co_owner rows.
    if ctx.db.save_snapshot().restaurant_id().find(restaurant_id).is_some() {
        ctx.db.save_snapshot().restaurant_id().delete(restaurant_id);
    }
    for c in ctx.db.co_owner().restaurant_id().filter(restaurant_id) {
        ctx.db.co_owner().id().delete(c.id);
    }
    ctx.db.restaurant().id().delete(restaurant_id);
    Ok(())
}

/// Upsert the save snapshot for a restaurant. The caller must be the
/// owner or a co-owner. `data` is the JSON-serialized SaveGameState
/// blob the client builds. (Reducer name distinct from the table
/// accessor so they don't shadow each other.)
#[reducer]
pub fn save_restaurant_snapshot(
    ctx: &ReducerContext,
    restaurant_id: u64,
    data: String,
    day_number: u32,
    money: i64,
    rating_avg: f32,
    luxury_tier: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    let allowed = r.owner == ctx.sender
        || ctx.db.co_owner().restaurant_id().filter(restaurant_id)
            .any(|c| c.player == ctx.sender);
    if !allowed {
        return Err("You are not an owner or co-owner of this restaurant".into());
    }
    if data.len() > 256 * 1024 {
        return Err("Save blob too large (>256 KB)".into());
    }
    let row = SaveSnapshot {
        restaurant_id,
        data,
        day_number,
        money,
        rating_avg,
        luxury_tier,
        saved_at: ctx.timestamp,
    };
    if ctx.db.save_snapshot().restaurant_id().find(restaurant_id).is_some() {
        ctx.db.save_snapshot().restaurant_id().update(row);
    } else {
        ctx.db.save_snapshot().insert(row);
    }
    Ok(())
}

/// Upsert THIS player's save snapshot. Called by the client every
/// autosave so the latest restaurant state is on the server and any
/// other client can subscribe to see it (used by P4 visit mode).
/// Owner is always ctx.sender; the public `player_save` table holds
/// at most one row per Identity.
///
#[reducer]
pub fn publish_player_save(
    ctx: &ReducerContext,
    data: String,
    day_number: u32,
    money: i64,
    rating_avg: f32,
    luxury_tier: u32,
    restaurant_open: bool,
    free_seats: u32,
) -> Result<(), String> {
    if data.len() > 512 * 1024 {
        return Err("Save blob too large (>512 KB)".into());
    }
    let row = PlayerSave {
        identity: ctx.sender,
        data,
        day_number,
        money,
        rating_avg,
        luxury_tier,
        updated_at: ctx.timestamp,
        restaurant_open,
        free_seats,
    };
    if ctx.db.player_save().identity().find(ctx.sender).is_some() {
        ctx.db.player_save().identity().update(row);
    } else {
        ctx.db.player_save().insert(row);
    }
    Ok(())
}

/// P5.8 — record that ctx.sender just entered visit mode on `host`'s
/// plot. Inserts a single visit_event row; the host's client picks it
/// up via subscription and toasts a "👀 X is visiting" notification.
///
/// Self-visits are silently ignored (the visitor IS the host — no
/// notification needed). Visits to non-existent identities also
/// no-op rather than erroring so a stale shell click doesn't surface
/// a confusing message.
#[reducer]
pub fn record_visit(ctx: &ReducerContext, host: Identity) -> Result<(), String> {
    if host == ctx.sender { return Ok(()); }
    let zero = Identity::__dummy();
    if host == zero { return Ok(()); }
    ctx.db.visit_event().insert(VisitEvent {
        id: 0, // auto_inc
        visitor: ctx.sender,
        host,
        visited_at: ctx.timestamp,
    });
    Ok(())
}
