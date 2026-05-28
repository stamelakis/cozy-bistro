//! Restaurant CRUD + save snapshots.

use spacetimedb::{reducer, ReducerContext, Table};
use crate::tables::{restaurant, save_snapshot, co_owner, Restaurant, SaveSnapshot};

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
