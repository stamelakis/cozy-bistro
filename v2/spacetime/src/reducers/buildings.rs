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
use crate::tables::{building, favorite, friendship, restaurant, player, player_save, neighborhood_slot, Building, NeighborhoodSlot, Restaurant};

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

    // Phase M.34 — plots are SHARED identities now: picking one just sets it as
    // your HOME plot (many players may share it), not an exclusive deed. So no
    // one-plot-per-player / already-claimed rejections — that's what lets more
    // than 12 players into the neighborhood.
    let target = ctx.db.building().id().find(building_id)
        .ok_or_else(|| "No such building".to_string())?;

    // Ensure the player has a restaurant (H.96 post-condition), then stamp its
    // home plot.
    if !ctx.db.restaurant().iter().any(|r| r.owner == me) {
        crate::reducers::restaurants::create_default_restaurant_for(ctx, me);
    }
    if let Some(r) = ctx.db.restaurant().iter().find(|r| r.owner == me) {
        ctx.db.restaurant().id().update(Restaurant { home_building_id: target.id, ..r });
    }
    // Keep the legacy Building.owner_identity pointing at the FIRST claimer so
    // the home_building_of fallback + any pre-Phase-3 reads still resolve; later
    // pickers of the same plot don't overwrite it (it's no longer exclusive).
    if target.owner_identity == Identity::__dummy() {
        ctx.db.building().id().update(crate::tables::Building {
            owner_identity: me,
            claimed_at: Some(ctx.timestamp),
            ..target
        });
    }
    log::info!("Building #{} chosen as home by {}", building_id, me);
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
    // Pin the viewer's FAVORITES first, then their FRIENDS, then everyone else —
    // so a favorited or friended restaurant always claims a neighborhood plot
    // (up to the ~11 available) and becomes a permanent, one-click-visitable
    // neighbour. Within each rank it's still closest-level first, then jitter.
    let favs: std::collections::HashSet<u64> = ctx.db.favorite().player().filter(viewer)
        .map(|f| f.restaurant_id).collect();
    let mut friend_owners: std::collections::HashSet<Identity> = std::collections::HashSet::new();
    for f in ctx.db.friendship().player_a().filter(viewer) { friend_owners.insert(f.player_b); }
    for f in ctx.db.friendship().player_b().filter(viewer) { friend_owners.insert(f.player_a); }
    cands.sort_by_key(|c| {
        let rank = if favs.contains(&c.0) { 0u8 }
            else if friend_owners.contains(&c.1) { 1u8 }
            else { 2u8 };
        (rank, c.3, c.4)
    });

    // Two-pass assignment. Pass 1 honors each candidate's HOME plot (the "same
    // identity" rule) — the closest-level candidate wins a contested home. Pass
    // 2 fills the leftover plots with the remaining closest-level candidates.
    // (A single greedy pass would drop a candidate into the first empty plot
    // instead of its own home.)
    let plot_ids: std::collections::HashSet<u64> =
        buildings.iter().map(|b| b.id).filter(|&id| id != my_home).collect();
    let mut assigned: std::collections::HashMap<u64, (u64, Identity)> = std::collections::HashMap::new();
    let mut used: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for &(rid, owner, home, _d, _r) in &cands {
        if home != 0 && home != my_home && plot_ids.contains(&home)
            && !assigned.contains_key(&home) && !used.contains(&rid) {
            assigned.insert(home, (rid, owner));
            used.insert(rid);
        }
    }
    for b in &buildings {
        if b.id == my_home || assigned.contains_key(&b.id) { continue; }
        if let Some(&(rid, owner, _h, _d, _r)) = cands.iter().find(|c| !used.contains(&c.0)) {
            used.insert(rid);
            assigned.insert(b.id, (rid, owner));
        }
    }

    // Replace the viewer's previous view.
    let old: Vec<u64> = ctx.db.neighborhood_slot().viewer().filter(viewer).map(|s| s.id).collect();
    for id in old { ctx.db.neighborhood_slot().id().delete(id); }

    for b in &buildings {
        let (rid, owner, life, is_you) = if b.id == my_home && my_rest.is_some() {
            (my_rest.as_ref().unwrap().id, viewer, "active".to_string(), true)
        } else if let Some(&(rid, owner)) = assigned.get(&b.id) {
            (rid, owner, nbr_lifecycle(ctx, owner, now).to_string(), false)
        } else {
            (0u64, Identity::__dummy(), "active".to_string(), false)
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
