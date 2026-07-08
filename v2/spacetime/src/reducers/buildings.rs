//! City-map building seeding + claim reducers. Each building is a
//! physical plot on the shared map that a single player can claim
//! and develop into their restaurant. The seed runs ONCE on module
//! init (per database lifetime); claims happen as players sign up.
//!
//! Layout strategy: a loose Greek-Island-style grid that's not too
//! rigidly Manhattan. Buildings are placed on a coarse 24-tile
//! pitch with small random perturbations so the city reads as
//! organic rather than perfectly aligned. The plot footprints
//! (kind = "small" | "medium" | "large") drive how much building
//! space each player gets.

use spacetimedb::{reducer, ReducerContext, Table, Identity};
use crate::tables::{building, restaurant, player, player_save, neighborhood_slot, Building, NeighborhoodSlot, Restaurant};

/// Seed N unowned buildings on the city map. Called once from the
/// `init` lifecycle reducer when the module is first published —
/// re-published modules don't re-seed (the existing building rows
/// are kept). If you ever need to reset the layout, drop the
/// `building` table and republish.
pub fn seed_buildings_if_empty(ctx: &ReducerContext) {
    if ctx.db.building().iter().next().is_some() {
        log::info!("Buildings already seeded — skipping");
        return;
    }
    log::info!("Seeding city buildings (first-time module init)");

    // Sample plot layout — 12 starter buildings of mixed sizes
    // arrayed on a coarse grid. The pitch (~24 tiles) gives each
    // building room to grow gardens / rooftops + leaves space for
    // streets and shops between plots.
    //
    // Coordinate origin is roughly the city center; plots fan out
    // along a soft grid with size-driven offsets.
    //
    // The "kind" string drives the procedural building shell in
    // WorldScene (small → 8×8, medium → 10×10, large → 12×12).
    // Future architectural variants (corner shops, Greek towers
    // etc.) join the enum without a schema migration.
    let plots: &[(&str, i32, i32, u32, u32)] = &[
        // Row 1 (north of center)
        ("small",   -48, -48, 8,  8),
        ("medium",  -24, -48, 10, 10),
        ("large",     0, -48, 12, 12),
        ("medium",   24, -48, 10, 10),
        ("small",    48, -48, 8,  8),
        // Row 2 (center, behind the main street)
        ("medium",  -48,   0, 10, 10),
        ("large",   -24,   0, 12, 12),
        ("large",    24,   0, 12, 12),
        ("medium",   48,   0, 10, 10),
        // Row 3 (south of center)
        ("small",   -24,  48, 8,  8),
        ("medium",    0,  48, 10, 10),
        ("small",    24,  48, 8,  8),
    ];

    for (kind, x, z, w, h) in plots {
        ctx.db.building().insert(Building {
            id: 0, // auto_inc
            kind: kind.to_string(),
            plot_x: *x,
            plot_z: *z,
            plot_w: *w,
            plot_h: *h,
            owner_identity: Identity::__dummy(),
            claimed_at: None,
        });
    }
    log::info!("Seeded {} buildings", plots.len());
}

/// Claim an unowned building. Validates the building exists and
/// has the zero owner_identity (= unowned), then stamps the sender
/// as the new owner. Rejects if the caller is already a building
/// owner — one plot per player for P2.
#[reducer]
pub fn claim_building(ctx: &ReducerContext, building_id: u64) -> Result<(), String> {
    let me = ctx.sender;

    // One plot per player — enforce here so a stray reducer call
    // can't grant a second building.
    for b in ctx.db.building().owner_identity().filter(me) {
        return Err(format!("You already own building #{}", b.id));
    }

    let target = ctx.db.building().id().find(building_id)
        .ok_or_else(|| "No such building".to_string())?;
    if target.owner_identity != Identity::__dummy() {
        return Err("That building is already claimed".into());
    }

    ctx.db.building().id().update(crate::tables::Building {
        owner_identity: me,
        claimed_at: Some(ctx.timestamp),
        ..target
    });
    log::info!("Building #{} claimed by {}", building_id, me);

    // Phase I (H.96) — Atomically materialise a Restaurant row for
    // the new owner if they don't already have one. Pre-H.96 the
    // client auto-created on subscription-ready, which raced the
    // claim flow and could leave the user with a Building but no
    // Restaurant (or vice versa) after a wipe / partial migration.
    // Doing both in one reducer means the post-condition is always
    // "owns building => has restaurant".
    let has_restaurant = ctx.db.restaurant().iter().any(|r| r.owner == me);
    if !has_restaurant {
        crate::reducers::restaurants::create_default_restaurant_for(ctx, me);
        log::info!("Auto-created Restaurant for new building owner {}", me);
    }
    Ok(())
}

/// Public bootstrap — force-seed the buildings table when it's
/// empty. Used to recover the city when `init` already ran on
/// an earlier publish without the seed call (init fires ONCE per
/// database lifetime; adding the seed call after init's first
/// run means it never executes naturally). Idempotent — once
/// buildings exist this is a no-op, so leaving the reducer
/// callable by anyone is harmless.
#[reducer]
pub fn bootstrap_city(ctx: &ReducerContext) -> Result<(), String> {
    seed_buildings_if_empty(ctx);
    Ok(())
}

// ---------- Phase M.34 — dynamic neighborhoods + cold/storage lifecycle ----------

/// Owner-time-away thresholds for the neighborhood lifecycle (tunable).
const NBR_COLD_AFTER_MICROS: i64 = 7 * 24 * 3_600 * 1_000_000;      // 1 week
const NBR_ARCHIVE_AFTER_MICROS: i64 = 14 * 24 * 3_600 * 1_000_000; // 2 weeks
/// Neighbors rotate on this cadence — the selection re-shuffles equal-level
/// candidates each bucket so the faces around you cycle without churning wildly.
const NBR_ROTATE_MICROS: i64 = 5 * 60 * 1_000_000; // 5 min

/// A restaurant's neighborhood lifecycle from how long its owner has been away.
/// "active" | "cold" | "archived". The identity/home is preserved in every case
/// (archival is a display/rotation state, never a deletion), so a returning
/// owner drops straight back into the pool at their same plot.
fn nbr_lifecycle(ctx: &ReducerContext, owner: Identity, now_micros: i64) -> &'static str {
    let last_seen = ctx.db.player().identity().find(owner)
        .map(|p| p.last_seen_at.to_micros_since_unix_epoch())
        .unwrap_or(0);
    let away = now_micros - last_seen;
    if away >= NBR_ARCHIVE_AFTER_MICROS { "archived" }
    else if away >= NBR_COLD_AFTER_MICROS { "cold" }
    else { "active" }
}

/// The plot a restaurant calls home: its explicit `home_building_id`, or (for
/// legacy rows) the building it claimed 1:1. Backfills the field the first time
/// so later reads are cheap.
fn home_building_of(ctx: &ReducerContext, r: &Restaurant) -> u64 {
    if r.home_building_id != 0 { return r.home_building_id; }
    let home = ctx.db.building().owner_identity().filter(r.owner).next().map(|b| b.id).unwrap_or(0);
    if home != 0 {
        if let Some(owned) = ctx.db.restaurant().id().find(r.id) {
            ctx.db.restaurant().id().update(Restaurant { home_building_id: home, ..owned });
        }
    }
    home
}

fn tier_of(ctx: &ReducerContext, owner: Identity) -> i64 {
    ctx.db.player_save().identity().find(owner).map(|s| s.luxury_tier as i64).unwrap_or(1)
}

/// Rebuild the caller's per-viewer neighborhood: their own restaurant pinned at
/// their home plot, and the other 11 plots filled with level-matched OTHER
/// restaurants (preferring ones whose own home is that plot — the "same
/// identity" rotation), skipping archived ones. Called by the client on entering
/// the neighborhood + periodically. Writes `neighborhood_slot` rows the caller
/// subscribes to.
#[reducer]
pub fn refresh_neighborhood(ctx: &ReducerContext) -> Result<(), String> {
    let viewer = ctx.sender;
    let now = ctx.timestamp.to_micros_since_unix_epoch();

    let mut buildings: Vec<Building> = ctx.db.building().iter().collect();
    buildings.sort_by_key(|b| b.id);
    if buildings.is_empty() { return Ok(()); }

    let my_rest = ctx.db.restaurant().iter().find(|r| r.owner == viewer);
    let my_home = match &my_rest { Some(r) => home_building_of(ctx, r), None => 0 };
    let my_tier = tier_of(ctx, viewer);
    let bucket = now / NBR_ROTATE_MICROS;

    // Candidate pool — every OTHER non-archived restaurant, tagged with its home
    // plot, level-distance to the viewer, and a per-bucket rotation jitter.
    // Tuple: (rid, owner, home, dist, rot).
    let mut cands: Vec<(u64, Identity, u64, i64, u64)> = Vec::new();
    for r in ctx.db.restaurant().iter() {
        if r.owner == viewer { continue; }
        if nbr_lifecycle(ctx, r.owner, now) == "archived" { continue; }
        let home = if r.home_building_id != 0 { r.home_building_id }
            else { ctx.db.building().owner_identity().filter(r.owner).next().map(|b| b.id).unwrap_or(0) };
        let dist = (tier_of(ctx, r.owner) - my_tier).abs();
        let rot = r.id.wrapping_mul(2654435761).wrapping_add(bucket as u64) % 100_003;
        cands.push((r.id, r.owner, home, dist, rot));
    }
    // Closest level first; equal levels shuffle by the rotation jitter.
    cands.sort_by_key(|c| (c.3, c.4));

    // Replace the viewer's previous view.
    let old: Vec<u64> = ctx.db.neighborhood_slot().viewer().filter(viewer).map(|s| s.id).collect();
    for id in old { ctx.db.neighborhood_slot().id().delete(id); }

    let mut used: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for b in &buildings {
        let (rid, owner, life, is_you) = if b.id == my_home && my_rest.is_some() {
            (my_rest.as_ref().unwrap().id, viewer, "active".to_string(), true)
        } else {
            // Prefer a candidate whose OWN home is this plot; else the closest unused.
            let pick = cands.iter().find(|c| c.2 == b.id && !used.contains(&c.0))
                .or_else(|| cands.iter().find(|c| !used.contains(&c.0)))
                .copied();
            match pick {
                Some((rid, owner, _h, _d, _r)) => {
                    used.insert(rid);
                    (rid, owner, nbr_lifecycle(ctx, owner, now).to_string(), false)
                }
                None => (0u64, Identity::__dummy(), "active".to_string(), false),
            }
        };
        ctx.db.neighborhood_slot().insert(NeighborhoodSlot {
            id: 0, // auto_inc
            viewer,
            building_id: b.id,
            restaurant_id: rid,
            owner,
            lifecycle: life,
            is_you,
            refreshed_at: ctx.timestamp,
        });
    }
    Ok(())
}

/// Admin-only: release a building back to the unowned pool. Used
/// during testing / by Dunnin to recover an abandoned plot. The
/// auth check is the same one admin_reset_password uses.
#[reducer]
pub fn admin_release_building(ctx: &ReducerContext, building_id: u64) -> Result<(), String> {
    let is_admin = ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin);
    if !is_admin {
        return Err("Admin only".into());
    }
    let target = ctx.db.building().id().find(building_id)
        .ok_or_else(|| "No such building".to_string())?;
    ctx.db.building().id().update(Building {
        owner_identity: Identity::__dummy(),
        claimed_at: None,
        ..target
    });
    log::info!("Building #{} released by admin", building_id);
    Ok(())
}

use crate::tables::auth_record;
