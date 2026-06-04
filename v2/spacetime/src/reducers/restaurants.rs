//! Restaurant CRUD + save snapshots.

use spacetimedb::{reducer, ReducerContext, Identity, Table};
use crate::tables::{restaurant, save_snapshot, co_owner, player_save, recipe_upgrade_in_flight, visit_event, Restaurant, SaveSnapshot, PlayerSave, VisitEvent};

/// Create a new restaurant owned by the caller.
#[reducer]
pub fn create_restaurant(ctx: &ReducerContext, name: String, public: bool) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 48 {
        return Err("Name must be 1-48 characters".into());
    }
    let inserted = ctx.db.restaurant().insert(Restaurant {
        id: 0, // auto_inc
        owner: ctx.sender,
        name: trimmed.to_string(),
        public,
        created_at: ctx.timestamp,
        // H.22 — pending rollup counters start at zero for new restaurants.
        // The defaults on the schema also cover existing rows that predate
        // these fields, so the migration is non-destructive.
        pending_served: 0,
        pending_tips_cents: 0,
        pending_rating_sum_x100: 0,
        pending_rating_count: 0,
        // H.28 — cached aggregate stats start empty; the client fires
        // update_restaurant_aggregates after the first furniture mutation.
        cached_style_x100: 0,
        cached_comfort_x100: 0,
        cached_rating_bonus_x100: 0,
        cached_bathroom_quality_x100: 0,
        // H.30 — day clock starts fresh; client syncs in foreground.
        day_elapsed_ms: 0,
        pending_days_advanced: 0,
        // H.32 — money mirror starts at zero; client's first
        // sync_cloud_money fires within seconds of spawn.
        cloud_money_cents: 0,
        // H.41 — pending auto-shop debt starts at zero; client drains
        // on reconnect.
        pending_restock_cost_cents: 0,
        // H.43 / H.44 / H.45 — server-side timer pendings all start
        // empty / zero on a fresh restaurant; client fires the
        // matching set_* reducers as the player schedules upgrades,
        // training, or as payroll changes.
        pending_recipe_upgrades_completed_csv: None,
        pending_training_completions_csv: None,
        pending_salary_cost_cents: 0,
        pending_salary_remainder_x: 0,
        last_salary_tick_micros: 0,
        cloud_base_payroll_per_min_cents: 0,
        // H.46 — live daily totals start at zero; foreground client
        // syncs after each economy update.
        cloud_daily_revenue_cents: 0,
        cloud_daily_expenses_cents: 0,
        // H.60 — rating history starts empty (None); client pushes
        // the full snapshot on every recordRating.
        cloud_rating_history_csv: None,
        // H.61 + H.63 — transaction log + day history start empty;
        // foreground client pushes periodically.
        cloud_transaction_log_json: None,
        cloud_day_history_json: None,
        // H.68 — waiter rest spot starts unset.  Client falls back
        // to a default position (near a counter / door) until the
        // player explicitly picks one via the sidebar tool.
        waiter_rest_set: false,
        waiter_rest_x: 0.0,
        waiter_rest_z: 0.0,
        waiter_rest_floor: 0,
    });
    // Boot the simulation tick for this restaurant. Idempotent; skips
    // if a schedule row already exists for the id (e.g. someone
    // calls create_restaurant twice during init backfill).
    crate::reducers::restaurant_sim::ensure_tick_schedule(ctx, inserted.id);
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
    // H.43 cascade — drop any in-flight recipe-upgrade timers for
    // this restaurant so they don't outlive the restaurant deletion.
    let upgrade_keys: Vec<String> = ctx.db.recipe_upgrade_in_flight().restaurant_id()
        .filter(restaurant_id)
        .map(|f| f.key.clone())
        .collect();
    for k in upgrade_keys {
        ctx.db.recipe_upgrade_in_flight().key().delete(k);
    }
    // Stop the simulation tick + drop its bookkeeping row. Idempotent
    // — silent no-op if the schedule never existed (e.g. legacy
    // restaurant deleted before sim ticks shipped).
    crate::reducers::restaurant_sim::drop_tick_schedule(ctx, restaurant_id);
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
