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
    active_guest, restaurant_tick_schedule, restaurant_tick_state,
    ActiveGuest, RestaurantTickSchedule, RestaurantTickState,
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

    // Phase B.1 — iterate every active_guest belonging to this
    // restaurant and step its state machine. tick_guest_state is a
    // no-op stub in B.1 (just exercise the dispatch + table access);
    // B.2 fills in real patience / state transitions.
    let dt_ms = compute_dt_ms(ctx, &schedule);
    let guest_ids: Vec<u64> = ctx.db
        .active_guest()
        .iter()
        .filter(|g| g.restaurant_id == rid)
        .map(|g| g.id)
        .collect();
    for guest_id in guest_ids {
        tick_guest_state(ctx, guest_id, dt_ms);
    }

    Ok(())
}

/// Compute elapsed time since the previous tick for this restaurant,
/// in milliseconds. Used to advance state-machine clocks. Falls back
/// to the scheduled interval (100 ms) on the first tick after a
/// restart, since `last_tick_at` won't exist yet.
fn compute_dt_ms(_ctx: &ReducerContext, _schedule: &RestaurantTickSchedule) -> i64 {
    // The reducer body itself just upserted restaurant_tick_state
    // ABOVE this call site; so by the time we read, last_tick_at is
    // already "now". We instead pin to the configured interval — the
    // schedule is what guarantees pacing, and any per-tick drift is
    // sub-millisecond and not worth a more complex bookkeeping field.
    SIM_TICK_INTERVAL_MICROS / 1_000
}

/// Advance one guest's state machine by `dt_ms`. Phase B.1 is a stub
/// — it exists so the master tick has the per-guest dispatch wired
/// up before B.2 starts filling in real logic.
///
/// Even as a stub it's NOT a literal no-op: it advances `state_clock_ms`
/// + `patience_ms` countdown so client subscribers can already see
/// the row tick. The actual state transitions (e.g. seated → ordering
/// after dwell) land in Phase B.2.
fn tick_guest_state(ctx: &ReducerContext, guest_id: u64, dt_ms: i64) {
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else { return };
    let new_clock = g.state_clock_ms.saturating_add(dt_ms);
    // Patience counts DOWN; clamp at zero, transition happens in B.2.
    let new_patience = (g.patience_ms - dt_ms).max(0);
    ctx.db.active_guest().id().update(ActiveGuest {
        state_clock_ms: new_clock,
        patience_ms: new_patience,
        ..g
    });
}
