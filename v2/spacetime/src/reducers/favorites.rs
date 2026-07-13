//! Favorite (bookmark) other players' restaurants. Persistent per-player;
//! powers the Social hub's quick-visit list and a restaurant's favorite count.

use spacetimedb::{reducer, ReducerContext, Table};
use crate::tables::{favorite, restaurant, Favorite};

/// Favorite a restaurant. Idempotent — a second call for the same restaurant
/// is a no-op. You may favorite any real restaurant, including your own.
#[reducer]
pub fn add_favorite(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    if ctx.db.restaurant().id().find(restaurant_id).is_none() {
        return Err("Restaurant not found".into());
    }
    let already = ctx.db.favorite().player().filter(ctx.sender)
        .any(|f| f.restaurant_id == restaurant_id);
    if already { return Ok(()); }
    ctx.db.favorite().insert(Favorite {
        id: 0, // auto_inc
        player: ctx.sender,
        restaurant_id,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Un-favorite a restaurant. No-op if it wasn't favorited.
#[reducer]
pub fn remove_favorite(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    let row = ctx.db.favorite().player().filter(ctx.sender)
        .find(|f| f.restaurant_id == restaurant_id);
    if let Some(row) = row {
        ctx.db.favorite().id().delete(row.id);
    }
    Ok(())
}
