//! P5 — shared pedestrian pool. Server spawns + despawns; clients
//! interpolate positions locally from elapsed time.
//!
//! Avenues (centerlines, world coords — match WorldScene.EW_AVENUES /
//! NS_AVENUES on the client):
//!   EW: z = -36, +13.5, +62
//!   NS: x = -70, +70
//!
//! Each pedestrian walks along one of those avenues on ONE pavement
//! side (north/south for EW, west/east for NS), from one end of the
//! visible city span (~±112 m) to the other. Speed is fixed at
//! ~1.0 m/s so the full ~225 m trip takes ~225 s — gives the city
//! enough density without overloading the table.

use spacetimedb::{rand::Rng, reducer, ReducerContext, ScheduleAt, Table, TimeDuration};
use crate::tables::{building, pedestrian, pedestrian_tick_schedule, player_save, visit_event, Building, Pedestrian, PedestrianTickSchedule};

/// Cap on simultaneously active pedestrians. Each is one row in the
/// pedestrian table; client renders one character model per row.
/// Bumped up from the legacy per-client count (14) because this pool
/// is now shared across every connected client.
const MAX_ACTIVE: usize = 24;

/// Walk speed in m/s. Trip duration = route length / WALK_SPEED.
const WALK_SPEED_MPS: f32 = 1.0;

/// Half-extent of the visible city span — pedestrians spawn at
/// ±STREET_HALF along the avenue's free axis and walk to the other
/// end. Matches WorldScene.AVENUE_WALK_HALF_LEN on the client.
const STREET_HALF: f32 = 112.0;

/// Perpendicular pavement offset from the avenue centerline — the
/// pedestrian walks along one of two pavements, not on the asphalt.
/// Matches AVENUE_PAVEMENT_OFFSET in PedestrianSpawner.ts.
const PAVEMENT_OFFSET: f32 = 8.0;

const EW_AVENUES: &[f32] = &[-24.0, 24.0, 62.0]; // matches WorldScene.EW_AVENUES
const NS_AVENUES: &[f32] = &[-70.0, 70.0];

const VARIANTS: &[&str] = &[
    "guest-v0", "guest-v1", "guest-v2", "guest-v3",
    "guest-v4", "guest-v5", "guest-v6",
];

/// Fires every 2 s via the pedestrian_tick_schedule row inserted by
/// lifecycle::init. Each tick:
///   - despawns any pedestrians whose trip duration has elapsed
///   - spawns NEW pedestrians up to MAX_ACTIVE if below the cap
///
/// Note the schedule row is auto-passed as the second arg; we don't
/// re-insert because it's an Interval schedule (persists, fires
/// repeatedly).
#[reducer]
pub fn pedestrian_tick(ctx: &ReducerContext, _schedule: PedestrianTickSchedule) -> Result<(), String> {
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    // Pass 1 — despawn expired pedestrians.
    let mut alive_count: usize = 0;
    let to_despawn: Vec<u64> = ctx.db.pedestrian().iter().filter_map(|p| {
        let elapsed = now_micros - p.spawn_at.to_micros_since_unix_epoch();
        if elapsed > p.duration_micros {
            Some(p.id)
        } else {
            alive_count += 1;
            None
        }
    }).collect();
    for id in to_despawn {
        ctx.db.pedestrian().id().delete(id);
    }
    // Pass 2 — spawn up to N new pedestrians per tick, respecting
    // the cap. Spawning one per tick keeps the city feeling alive
    // without bursting too many at once.
    let want_to_spawn = (MAX_ACTIVE.saturating_sub(alive_count)).min(2);
    for _ in 0..want_to_spawn {
        spawn_one(ctx);
    }
    // Pass 3 — prune visit_event rows older than 10 minutes. Each
    // toast only needs to fire once, so a stale row's only effect is
    // a phantom notification for a player coming online after the
    // event. 10 min is a comfortable cushion for legitimate "real-
    // time" toasts without letting the table grow unbounded.
    let stale_cutoff = now_micros - 10 * 60 * 1_000_000;
    let stale: Vec<u64> = ctx.db.visit_event().iter()
        .filter(|v| v.visited_at.to_micros_since_unix_epoch() < stale_cutoff)
        .map(|v| v.id)
        .collect();
    for id in stale {
        ctx.db.visit_event().id().delete(id);
    }
    Ok(())
}

/// Public bootstrap — installs the pedestrian_tick_schedule row if
/// it doesn't already exist. Needed because the init lifecycle
/// reducer only runs ONCE per database lifetime; if the schedule
/// table was added after init's first firing, init's installer is
/// never re-run. Idempotent: a second call is a no-op once the
/// schedule row exists.
#[reducer]
pub fn bootstrap_pedestrian_schedule(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.pedestrian_tick_schedule().iter().next().is_some() {
        log::info!("Pedestrian schedule already installed — skipping");
        return Ok(());
    }
    ctx.db.pedestrian_tick_schedule().insert(PedestrianTickSchedule {
        id: 0,
        scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(2_000_000)),
    });
    log::info!("Pedestrian tick schedule installed via bootstrap (every 2s)");
    Ok(())
}

fn spawn_one(ctx: &ReducerContext) {
    let mut rng = ctx.rng();
    let is_ew = rng.gen_bool(0.6);
    let side: f32 = if rng.gen_bool(0.5) { -1.0 } else { 1.0 };
    let dir: f32 = if rng.gen_bool(0.5) { -1.0 } else { 1.0 };
    // Pavement start point — same for both variants below (with or
    // without a plot target). The end either runs to the OTHER end
    // of the avenue (ambient walker) or to a chosen plot's door
    // (potential customer).
    let (start_x, start_z);
    if is_ew {
        let avenue_z = EW_AVENUES[rng.gen_range(0..EW_AVENUES.len())];
        start_x = dir * -STREET_HALF;
        start_z = avenue_z + side * PAVEMENT_OFFSET;
    } else {
        let avenue_x = NS_AVENUES[rng.gen_range(0..NS_AVENUES.len())];
        start_x = avenue_x + side * PAVEMENT_OFFSET;
        start_z = dir * -STREET_HALF;
    }

    // ~35% chance this walker is a potential customer headed to a
    // specific claimed plot. Pick a claimed plot near the spawn
    // point — biases the picks toward plots the walker would
    // realistically reach, instead of cross-city marathons.
    let mut target_plot_id: u64 = 0;
    let (end_x, end_z);
    if rng.gen_bool(0.35) {
        if let Some(plot) = pick_target_plot(ctx, &mut rng, start_x, start_z) {
            // Door sits on the +Z (south) face of the building's
            // shell. Approach 1.5 m south of the door so the
            // despawn looks like "stepping inside" instead of
            // teleporting into the wall.
            target_plot_id = plot.id;
            end_x = plot.plot_x as f32;
            end_z = plot.plot_z as f32 + (plot.plot_h as f32) / 2.0 + 1.5;
            let dx = end_x - start_x;
            let dz = end_z - start_z;
            let length = (dx * dx + dz * dz).sqrt().max(1.0);
            let duration_secs = length / WALK_SPEED_MPS;
            let variant = VARIANTS[rng.gen_range(0..VARIANTS.len())];
            ctx.db.pedestrian().insert(Pedestrian {
                id: 0, // auto_inc
                start_x,
                start_z,
                end_x,
                end_z,
                spawn_at: ctx.timestamp,
                duration_micros: (duration_secs * 1_000_000.0) as i64,
                variant: variant.to_string(),
                target_plot_id,
            });
            return;
        }
        // No claimed plots yet — fall through to ambient walker.
    }
    // Ambient walker — runs the full ±STREET_HALF avenue strip.
    if is_ew {
        end_x = -start_x;
        end_z = start_z;
    } else {
        end_x = start_x;
        end_z = -start_z;
    }
    let length = 2.0 * STREET_HALF;
    let duration_secs = length / WALK_SPEED_MPS;
    let variant = VARIANTS[rng.gen_range(0..VARIANTS.len())];
    ctx.db.pedestrian().insert(Pedestrian {
        id: 0, // auto_inc
        start_x,
        start_z,
        end_x,
        end_z,
        spawn_at: ctx.timestamp,
        duration_micros: (duration_secs * 1_000_000.0) as i64,
        variant: variant.to_string(),
        target_plot_id,
    });
}

/// Pick a claimed plot to target, weighted by the owner's published
/// rating. Higher-rated restaurants attract more walkers (rating² is
/// the weight, so a 4.5★ place is ~3× as attractive as a 2.5★ one).
/// Plots without a published rating yet (never autosaved) fall back
/// to a baseline weight so they still receive some traffic on day 1.
///
/// Closed restaurants (restaurant_open = false) are skipped entirely
/// so walkers don't waste a trip on a locked door. Full restaurants
/// (free_seats == 0) are also skipped — no point sending another
/// customer to a place that'd bounce them at the door. Both checks
/// only run when the owner has actually published a save; legacy
/// rows pre-dating those columns default to open + 4 seats so the
/// behaviour is "include unless the player explicitly said otherwise".
///
/// Returns None when no claimed plot survives those filters — caller
/// falls back to an ambient avenue-to-avenue walker.
fn pick_target_plot(ctx: &ReducerContext, rng: &mut impl Rng, _from_x: f32, _from_z: f32) -> Option<Building> {
    let zero = spacetimedb::Identity::__dummy();
    // Materialise the claim list with each plot's attraction weight.
    let mut weighted: Vec<(Building, f32)> = Vec::new();
    let mut total_weight: f32 = 0.0;
    for b in ctx.db.building().iter() {
        if b.owner_identity == zero { continue; }
        // Look up the owner's published save row — None means the
        // player hasn't autosaved yet. Use a neutral baseline so
        // fresh accounts still receive some traffic.
        let save = ctx.db.player_save().identity().find(b.owner_identity);
        // Hard filters first — closed or full plots are out.
        if let Some(s) = &save {
            if !s.restaurant_open { continue; }
            if s.free_seats == 0 { continue; }
        }
        let rating = save.as_ref().map(|s| s.rating_avg.max(0.0)).unwrap_or(3.0);
        // Weight = rating² + 1 so even a 0★ restaurant gets a small
        // chance and a 5★ blows the competition away.
        let weight = rating * rating + 1.0;
        weighted.push((b, weight));
        total_weight += weight;
    }
    if weighted.is_empty() || total_weight <= 0.0 { return None; }
    // Reservoir-style weighted pick — single pass, no allocations
    // beyond the Vec already built.
    let mut target = rng.gen::<f32>() * total_weight;
    for (b, w) in weighted {
        target -= w;
        if target <= 0.0 {
            return Some(b);
        }
    }
    None
}
