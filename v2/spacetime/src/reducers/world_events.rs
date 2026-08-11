//! Patch D — street-wide world events. One singleton row (world_event
//! id=1, weather_state pattern) driven by a 60 s scheduled tick.
//!
//! Today's only kind: **critic_sweep**. The tick occasionally ANNOUNCES a
//! sweep (state="announced"); every client sees the row change and banners
//! "🕵️ A food critic is touring the street — 10 minutes!". When fires_at
//! passes, the tick spawns one critic-archetype guest at every OPEN
//! restaurant (their 3× rating weight + 3× tip already exist in the
//! archetype catalog) and the row returns to "idle".
//!
//! Appointment mechanics, zero cost to ignore: the announcement is the
//! point — players get 10 real minutes to tidy up (bus tables, restock)
//! before the critic walks in.

use spacetimedb::{reducer, ReducerContext, ScheduleAt, Table, TimeDuration};
use crate::tables::{
    placed_furniture, player_save, restaurant, world_event, world_event_schedule,
    WorldEvent, WorldEventSchedule,
};

/// How far ahead a sweep is announced.
const ANNOUNCE_LEAD_MICROS: i64 = 10 * 60 * 1_000_000; // 10 min
/// Minimum quiet time after a sweep fires before another can be announced.
const SWEEP_COOLDOWN_MICROS: i64 = 45 * 60 * 1_000_000; // 45 min
/// Announce chance per 60 s tick once off cooldown — 1/60 ≈ one sweep per
/// real hour of quiet time on average.
const ANNOUNCE_ONE_IN: u64 = 60;

#[reducer]
pub fn world_event_tick(ctx: &ReducerContext, _schedule: WorldEventSchedule) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("world_event_tick is scheduler-only".into());
    }
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let Some(ev) = ctx.db.world_event().id().find(1u32) else {
        seed_idle_row(ctx);
        return Ok(());
    };
    if ev.state == "announced" {
        if now >= ev.fires_at_micros {
            fire_critic_sweep(ctx);
            ctx.db.world_event().id().update(WorldEvent {
                state: "idle".to_string(),
                announce_at_micros: 0,
                fires_at_micros: 0,
                last_fired_micros: now,
                ..ev
            });
        }
        return Ok(());
    }
    // Idle — roll a rare announce (hash the tick time; no rng in ticks).
    if ev.last_fired_micros != 0 && now - ev.last_fired_micros < SWEEP_COOLDOWN_MICROS {
        return Ok(());
    }
    let seed = (now as u64) ^ ((now as u64) >> 17);
    let roll = (seed.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33) % ANNOUNCE_ONE_IN;
    if roll == 0 {
        ctx.db.world_event().id().update(WorldEvent {
            kind: "critic_sweep".to_string(),
            state: "announced".to_string(),
            announce_at_micros: now,
            fires_at_micros: now + ANNOUNCE_LEAD_MICROS,
            ..ev
        });
        log::info!("world_event_tick: critic sweep announced, fires in 10min");
    }
    Ok(())
}

/// Spawn one critic at every open, built-out restaurant. Seat assignment
/// happens inside try_spawn_arrival_guest — a full house simply refuses
/// the spawn (the critic "couldn't get a table"), which is fine.
fn fire_critic_sweep(ctx: &ReducerContext) {
    const VARIANTS: &[&str] = &[
        "guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6",
    ];
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let mut spawned = 0u32;
    let rids: Vec<u64> = ctx.db.restaurant().iter().map(|r| r.id).collect();
    for rid in rids {
        let Some(r) = ctx.db.restaurant().id().find(rid) else { continue; };
        let open = ctx.db.player_save().identity().find(r.owner)
            .map(|s| s.restaurant_open)
            .unwrap_or(true);
        if !open { continue; }
        if ctx.db.placed_furniture().restaurant_id().filter(rid).next().is_none() {
            continue; // empty shell — no critic material
        }
        let h = (now as u64).wrapping_mul(rid.wrapping_add(7));
        let variant = VARIANTS[(h as usize) % VARIANTS.len()];
        if crate::reducers::restaurant_sim::try_spawn_arrival_guest(
            ctx, rid, variant, 0.0, 5.45, Some("critic"),
        ) {
            spawned += 1;
        }
    }
    log::info!("critic sweep fired: {spawned} critic(s) dispatched");
}

fn seed_idle_row(ctx: &ReducerContext) {
    ctx.db.world_event().insert(WorldEvent {
        id: 1,
        kind: "critic_sweep".to_string(),
        state: "idle".to_string(),
        announce_at_micros: 0,
        fires_at_micros: 0,
        last_fired_micros: 0,
    });
}

// ─── Admin test triggers (rare events on demand) ────────────────────────

fn require_admin(ctx: &ReducerContext) -> Result<(), String> {
    use crate::tables::auth_record;
    let is_admin = ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin);
    if !is_admin { return Err("Admin only".into()); }
    Ok(())
}

/// Announce a critic sweep NOW, firing in `fires_in_seconds` (1..=1200).
/// Lets the admin demo/verify the whole flow without waiting an hour.
#[reducer]
pub fn admin_announce_critic(ctx: &ReducerContext, fires_in_seconds: u32) -> Result<(), String> {
    require_admin(ctx)?;
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let fuse = (fires_in_seconds.clamp(1, 1200) as i64) * 1_000_000;
    let Some(ev) = ctx.db.world_event().id().find(1u32) else {
        seed_idle_row(ctx);
        return Err("world_event row was missing — seeded; call again".into());
    };
    ctx.db.world_event().id().update(WorldEvent {
        kind: "critic_sweep".to_string(),
        state: "announced".to_string(),
        announce_at_micros: now,
        fires_at_micros: now + fuse,
        ..ev
    });
    log::info!("admin_announce_critic: sweep fires in {}s", fires_in_seconds.clamp(1, 1200));
    Ok(())
}

/// Spawn one VIP-archetype guest at the admin's own restaurant right now.
#[reducer]
pub fn admin_spawn_vip(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    require_admin(ctx)?;
    let ok = crate::reducers::restaurant_sim::try_spawn_arrival_guest(
        ctx, restaurant_id, "guest-v3", 0.0, 5.45, Some("vip"),
    );
    if !ok { return Err("No free seat — VIP couldn't get a table".into()); }
    Ok(())
}

/// Zero the supply-crate cooldown so the next claim is instantly ready.
#[reducer]
pub fn admin_reset_crate(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    require_admin(ctx)?;
    use crate::tables::{restaurant, Restaurant};
    let Some(r) = ctx.db.restaurant().id().find(restaurant_id) else { return Ok(()); };
    ctx.db.restaurant().id().update(Restaurant { last_crate_micros: 0, ..r });
    Ok(())
}

/// Idempotent bootstrap — installs the 60 s schedule + the singleton row.
/// Callable manually (existing databases never re-run init) and from
/// lifecycle::init for fresh ones. Mirrors bootstrap_weather.
#[reducer]
pub fn bootstrap_world_events(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.world_event_schedule().iter().next().is_none() {
        ctx.db.world_event_schedule().insert(WorldEventSchedule {
            id: 0,
            scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(60 * 1_000_000)),
        });
        log::info!("bootstrap_world_events: 60s schedule installed");
    }
    if ctx.db.world_event().id().find(1u32).is_none() {
        seed_idle_row(ctx);
        log::info!("bootstrap_world_events: idle world_event row seeded");
    }
    Ok(())
}
