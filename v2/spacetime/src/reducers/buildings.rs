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
use crate::tables::{building, restaurant, Building};

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
