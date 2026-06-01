//! Server-authoritative restaurant simulation.
//!
//! Phase A4 — skeleton tick. Each restaurant gets its own scheduled
//! `restaurant_tick_schedule` row firing at SIM_TICK_INTERVAL_MICROS;
//! the reducer below does the per-restaurant work. Right now it only
//! upserts `restaurant_tick_state` so we can see ticks happening +
//! exit immediately. Phase B starts adding real simulation branches
//! gated on which subsystem has migrated.
//!
//! The schedule lifecycle is wired in restaurants.rs (insertion on
//! create_restaurant / delete_restaurant) and in lifecycle.rs's init
//! (backfill for restaurants that existed before this feature shipped).

use spacetimedb::{reducer, ReducerContext, ScheduleAt, Table, TimeDuration};
use crate::tables::{
    restaurant_tick_schedule, restaurant_tick_state,
    RestaurantTickSchedule, RestaurantTickState,
};

/// Interval the simulation ticks at, in microseconds. 100 ms = 10 Hz —
/// matches the rate planned in docs/server-authoritative-plan.md.
/// Pedestrians fire at 0.5 Hz; the live game sim needs finer
/// resolution so patience countdowns + cook timers feel right.
pub const SIM_TICK_INTERVAL_MICROS: i64 = 100_000; // 100ms

/// Insert a per-restaurant tick schedule row if one doesn't exist yet.
/// Idempotent — used both by create_restaurant for new restaurants
/// AND by the init backfill loop for ones that predate this feature.
pub fn ensure_tick_schedule(ctx: &ReducerContext, restaurant_id: u64) {
    let already = ctx.db
        .restaurant_tick_schedule()
        .iter()
        .any(|s| s.restaurant_id == restaurant_id);
    if already {
        return;
    }
    ctx.db.restaurant_tick_schedule().insert(RestaurantTickSchedule {
        id: 0, // auto_inc
        restaurant_id,
        scheduled_at: ScheduleAt::Interval(
            TimeDuration::from_micros(SIM_TICK_INTERVAL_MICROS),
        ),
    });
    log::info!(
        "Installed restaurant_tick_schedule for restaurant {} (every {} µs)",
        restaurant_id, SIM_TICK_INTERVAL_MICROS,
    );
}

/// Remove the tick schedule + tick-state rows for a restaurant. Called
/// from delete_restaurant so a deleted restaurant stops ticking and
/// doesn't leak rows.
pub fn drop_tick_schedule(ctx: &ReducerContext, restaurant_id: u64) {
    let schedule_ids: Vec<u64> = ctx.db
        .restaurant_tick_schedule()
        .iter()
        .filter(|s| s.restaurant_id == restaurant_id)
        .map(|s| s.id)
        .collect();
    for id in schedule_ids {
        ctx.db.restaurant_tick_schedule().id().delete(id);
    }
    if ctx.db.restaurant_tick_state().restaurant_id().find(restaurant_id).is_some() {
        ctx.db.restaurant_tick_state().restaurant_id().delete(restaurant_id);
    }
}

/// Scheduled tick. Fires every SIM_TICK_INTERVAL_MICROS for each
/// restaurant_tick_schedule row. The schedule row carries the
/// restaurant_id so the dispatch is implicit — no global iteration.
///
/// Phase A4 (this commit): just upsert tick-state so we can verify
/// ticks are firing. No simulation logic yet.
///
/// Phase B will add:
///   - try_spawn_guest when below the guest cap
///   - tick_guest_state for each active_guest
///
/// Subsequent phases add tickets, staff, etc.
#[reducer]
pub fn restaurant_tick(
    ctx: &ReducerContext,
    schedule: RestaurantTickSchedule,
) -> Result<(), String> {
    let rid = schedule.restaurant_id;
    let now = ctx.timestamp;

    // Upsert tick-state — first tick after schedule creation INSERTs;
    // every tick after UPDATEs. Tick count helps dev tools / logs
    // confirm the schedule is genuinely firing.
    if let Some(existing) = ctx.db.restaurant_tick_state().restaurant_id().find(rid) {
        ctx.db.restaurant_tick_state().restaurant_id().update(RestaurantTickState {
            restaurant_id: rid,
            last_tick_at: now,
            tick_count: existing.tick_count.saturating_add(1),
        });
    } else {
        ctx.db.restaurant_tick_state().insert(RestaurantTickState {
            restaurant_id: rid,
            last_tick_at: now,
            tick_count: 1,
        });
    }

    // Phase B+ logic slots in below here, gated on subsystem flags
    // the client sets via reducers (or a server-side config table
    // we add later). For now: no-op past the bookkeeping.

    Ok(())
}
