//! P5 — shared pedestrian pool. Server spawns + despawns; clients
//! interpolate positions locally from elapsed time.
//!
//! Avenues (centerlines, world coords — match WorldScene.EW_AVENUES /
//! NS_AVENUES on the client):
//!   EW: z = -34, +14, +62
//!   NS: x = -70, +70
//!
//! Routing policy: every pedestrian walks ALONG one pavement of one
//! avenue. Their trajectory is a near-straight line at a fixed perp
//! offset from the avenue centerline — no diagonals across the road
//! or grass. Plot-bound walkers (the ones who'll convert into
//! customers) spawn on the pavement CLOSEST to their target plot so
//! they can walk a straight line right to its front face. Ambient
//! walkers pick any pavement + direction and walk it end-to-end.
//!
//! Walk speed is fixed at ~1.0 m/s; the full ~225 m trip takes
//! ~225 s, which keeps the city looking busy without overloading
//! the table.

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

/// Perpendicular distance from the avenue centerline to where the
/// pedestrian's walking line sits. The rendered pavement plane spans
/// perp [3, 8] from the centerline; this range (4.5 → 5.5) keeps
/// walkers cleanly between the road-side lamps/planters (perp 4)
/// and the scenery house facades (perp 5.55+). Randomised per-walker
/// so a busy pavement reads as a slight spread, not a single tight
/// conga line.
const PAVEMENT_OFFSET_MIN: f32 = 4.5;
const PAVEMENT_OFFSET_MAX: f32 = 5.5;

/// How far the plot-bound walker steps perpendicular OFF the pavement
/// at the end of their trip — toward the plot's front face. Combined
/// with the pavement perp this puts the despawn point right at the
/// south wall for the typical h=12 plot; smaller plots see the
/// walker disappear 1-2 m short of the wall, then the customer
/// teleports to the actual door inside.
const PLOT_APPROACH_NUDGE: f32 = 3.0;

const EW_AVENUES: &[f32] = &[-34.0, 14.0, 62.0]; // matches WorldScene.EW_AVENUES
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
    let variant = VARIANTS[rng.gen_range(0..VARIANTS.len())].to_string();
    // Per-walker perp jitter so multiple pedestrians on the same
    // pavement spread across its width instead of stacking on the
    // exact same line.
    let pavement_perp = PAVEMENT_OFFSET_MIN
        + rng.gen::<f32>() * (PAVEMENT_OFFSET_MAX - PAVEMENT_OFFSET_MIN);

    // ~35% chance this walker is a potential customer. Pick TARGET
    // BEFORE picking spawn so we can put them on the right pavement
    // and walk a straight line — the old code picked spawn first
    // and got diagonal cross-road trajectories whenever the spawn
    // pavement didn't match the target plot's row.
    if rng.gen_bool(0.35) {
        if let Some(plot) = pick_target_plot(ctx, &mut rng, 0.0, 0.0) {
            spawn_plot_bound(ctx, &mut rng, &plot, variant, pavement_perp);
            return;
        }
        // No claimed plots yet — fall through to ambient walker.
    }

    spawn_ambient(ctx, &mut rng, variant, pavement_perp);
}

/// Plot-bound walker: spawn on the pavement of the EW avenue closest
/// to the target plot, on the SIDE of that avenue facing the plot,
/// and walk along the pavement to the X (or Z) of the plot — then
/// step a short perpendicular distance toward the plot's front face
/// at the very end so the despawn looks like "stepping inside" not
/// "vanishing on the pavement".
fn spawn_plot_bound(
    ctx: &ReducerContext,
    rng: &mut impl Rng,
    plot: &Building,
    variant: String,
    pavement_perp: f32,
) {
    let plot_x = plot.plot_x as f32;
    let plot_z = plot.plot_z as f32;
    // All city plots sit in EW rows (z = -48 / 0 / +48), so the
    // closest avenue is always EW. Walk that avenue's pavement.
    let avenue_z = closest_value(EW_AVENUES, plot_z);
    // plot_z < avenue_z → plot is on the negative-Z (lower-z) side
    // of the avenue, so the walker uses the pavement at perp -.
    let side: f32 = if plot_z < avenue_z { -1.0 } else { 1.0 };
    let pavement_z = avenue_z + side * pavement_perp;
    // Random direction along the avenue.
    let dir: f32 = if rng.gen_bool(0.5) { -1.0 } else { 1.0 };
    let start_x = dir * STREET_HALF;
    let start_z = pavement_z;
    let end_x = plot_x;
    // Step toward the plot's front face at the end. For h=12 plots
    // this lands the walker right at the south wall; smaller plots
    // see them disappear 1-2 m short, which is fine (the customer
    // teleports to the actual door inside the building anyway).
    let end_z = pavement_z + side * PLOT_APPROACH_NUDGE;

    let dx = end_x - start_x;
    let dz = end_z - start_z;
    let length = (dx * dx + dz * dz).sqrt().max(1.0);
    let duration_secs = length / WALK_SPEED_MPS;

    ctx.db.pedestrian().insert(Pedestrian {
        id: 0, // auto_inc
        start_x,
        start_z,
        end_x,
        end_z,
        spawn_at: ctx.timestamp,
        duration_micros: (duration_secs * 1_000_000.0) as i64,
        variant,
        target_plot_id: plot.id,
    });
}

/// Ambient walker: picks any avenue + pavement side + direction and
/// walks the full visible-city strip end-to-end. Stays on the
/// pavement the whole trip — no diagonals.
fn spawn_ambient(
    ctx: &ReducerContext,
    rng: &mut impl Rng,
    variant: String,
    pavement_perp: f32,
) {
    let is_ew = rng.gen_bool(0.6);
    let side: f32 = if rng.gen_bool(0.5) { -1.0 } else { 1.0 };
    let dir: f32 = if rng.gen_bool(0.5) { -1.0 } else { 1.0 };

    let (start_x, start_z, end_x, end_z);
    if is_ew {
        let avenue_z = EW_AVENUES[rng.gen_range(0..EW_AVENUES.len())];
        let pavement_z = avenue_z + side * pavement_perp;
        start_x = dir * -STREET_HALF;
        start_z = pavement_z;
        end_x = dir * STREET_HALF;
        end_z = pavement_z;
    } else {
        let avenue_x = NS_AVENUES[rng.gen_range(0..NS_AVENUES.len())];
        let pavement_x = avenue_x + side * pavement_perp;
        start_x = pavement_x;
        start_z = dir * -STREET_HALF;
        end_x = pavement_x;
        end_z = dir * STREET_HALF;
    }
    let length = 2.0 * STREET_HALF;
    let duration_secs = length / WALK_SPEED_MPS;
    ctx.db.pedestrian().insert(Pedestrian {
        id: 0, // auto_inc
        start_x,
        start_z,
        end_x,
        end_z,
        spawn_at: ctx.timestamp,
        duration_micros: (duration_secs * 1_000_000.0) as i64,
        variant,
        target_plot_id: 0,
    });
}

/// Pick the value from `values` closest to `target`. Used to find
/// the EW avenue nearest a given plot's z coordinate so the walker
/// uses the right avenue's pavement.
fn closest_value(values: &[f32], target: f32) -> f32 {
    let mut best = values[0];
    let mut best_dist = (best - target).abs();
    for &v in values.iter().skip(1) {
        let d = (v - target).abs();
        if d < best_dist {
            best_dist = d;
            best = v;
        }
    }
    best
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
