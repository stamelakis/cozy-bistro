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

use spacetimedb::{reducer, ReducerContext, ScheduleAt, Table, TimeDuration, Timestamp};
use crate::tables::{
    active_guest, active_ticket, dishware_pool, dishwasher_batch,
    placed_furniture, restaurant, restaurant_tick_schedule,
    restaurant_tick_state, staff_actor,
    ActiveGuest, ActiveTicket, DishwarePool, DishwasherBatch,
    PlacedFurniture, RestaurantTickSchedule, RestaurantTickState,
    StaffActor,
};

/// Manual backfill — install a tick schedule for every existing
/// restaurant that doesn't have one yet. lifecycle::init runs ONLY
/// on first publish, so when this feature lands on an already-
/// deployed module the existing restaurants are stranded with no
/// schedule rows. Call this once after each publish that adds new
/// per-restaurant scheduled work:
///
///     spacetime call cozy-bistro-andre bootstrap_sim_schedules
///
/// Idempotent — ensure_tick_schedule skips restaurants that already
/// have a row.
#[reducer]
pub fn bootstrap_sim_schedules(ctx: &ReducerContext) -> Result<(), String> {
    let rids: Vec<u64> = ctx.db.restaurant().iter().map(|r| r.id).collect();
    let count = rids.len();
    for rid in rids {
        ensure_tick_schedule(ctx, rid);
    }
    log::info!("bootstrap_sim_schedules: ensured tick schedule for {} restaurants", count);
    Ok(())
}

// === Phase B state-machine constants ===

/// Initial patience for a guest in walkingIn / seated / ordering /
/// waitingForFood states, in milliseconds. The client today rolls
/// patience per archetype; for B.2 we use a single baseline. B.3+
/// will pass the archetype's actual patience scale through
/// spawn_guest so heavy / patient archetypes feel different again.
const DEFAULT_PATIENCE_MS: i64 = 90_000; // 90 s

/// Dwell time in the "leaving" state before the row is deleted.
/// Lets the client play the walk-out animation before the model
/// vanishes. Client's despawnGuest matches this cadence.
const LEAVING_DWELL_MS: i64 = 4_000; // 4 s

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

    // Section C debt fix — capture the previous tick's timestamp
    // BEFORE we overwrite it, so compute_dt_ms can use real elapsed
    // time. Previously the function returned the scheduled interval
    // verbatim, which meant a tick delayed by load advanced state
    // machines by 100ms while real time moved by 500ms. Now state
    // machines stay calibrated to wall clock under load.
    let previous_tick_at: Option<Timestamp> = ctx.db
        .restaurant_tick_state()
        .restaurant_id()
        .find(rid)
        .map(|s| s.last_tick_at);

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

    // Iterate every active_guest belonging to this restaurant and
    // step its state machine (patience countdown, leaving dwell,
    // etc.). Phase B owns this branch.
    let dt_ms = compute_dt_ms(now, previous_tick_at);
    let guest_ids: Vec<u64> = ctx.db
        .active_guest()
        .iter()
        .filter(|g| g.restaurant_id == rid)
        .map(|g| g.id)
        .collect();
    for guest_id in guest_ids {
        tick_guest_state(ctx, guest_id, dt_ms);
    }

    // Phase C.1 — same pattern for tickets. Iterate this restaurant's
    // active_ticket rows + step each one's state-clock + cook timer.
    let ticket_ids: Vec<u64> = ctx.db
        .active_ticket()
        .iter()
        .filter(|t| t.restaurant_id == rid)
        .map(|t| t.id)
        .collect();
    for ticket_id in ticket_ids {
        tick_ticket_state(ctx, ticket_id, dt_ms);
    }

    // Phase D.1 — same pattern for staff actors. Mirror mode (the
    // client owns transitions and pushes them via reducers); the
    // server's per-tick work is just position smoothing in the
    // stub. D.4+ will add server-side state-machine logic once the
    // pathfinder + station registry are also server-side.
    let actor_ids: Vec<String> = ctx.db
        .staff_actor()
        .iter()
        .filter(|a| a.restaurant_id == rid)
        .map(|a| a.member_id.clone())
        .collect();
    for actor_id in actor_ids {
        tick_staff_actor(ctx, &actor_id, dt_ms);
    }

    // Phase H.4 — dishwasher batch cycle countdown. Each loaded
    // dishwasher's cycle clock ticks down by dt_ms; when it hits
    // zero the loaded plates / glasses flush back to the dirty pool
    // as CLEAN, and the batch row is deleted. Client mirror beats
    // the server to this transition every frame in mirror mode, but
    // once the dishware sim cuts over the server alone owns the
    // cycle — no client-side update() needed for that subsystem.
    let batch_uids: Vec<String> = ctx.db
        .dishwasher_batch()
        .iter()
        .filter(|b| b.restaurant_id == rid)
        .map(|b| b.furniture_uid.clone())
        .collect();
    for uid in batch_uids {
        tick_dishwasher_batch(ctx, &uid, rid, dt_ms);
    }

    // Phase H.6 — auto-claim queued tickets. Iterates queued tickets
    // in this restaurant and assigns each to an idle chef + free
    // stove. Means the kitchen keeps progressing when the host's tab
    // is backgrounded (the local sim throttles to 1Hz or worse in
    // background; without server auto-claim the queued tickets pile
    // up indefinitely).
    auto_claim_queued_tickets(ctx, rid);

    // Phase H.8 — auto-assign ready tickets to idle waiters. Same
    // pattern as H.6 but for the delivery side of the kitchen
    // workflow. Without this, plates would sit at the pickup spot
    // forever in a backgrounded tab. With it, the server pairs each
    // ready ticket with an idle waiter, sets their target to the
    // plate's pickup position, and marks the ticket "delivering".
    // The two-leg waiter trip (pickup → seat) is encoded in the new
    // delivery_phase field, which tick_staff_actor reads on arrival.
    auto_assign_ready_tickets(ctx, rid);

    Ok(())
}

/// Phase H.6 — server-side ticket auto-claim, with appliance-aware
/// routing (H.6 follow-up). For each queued ticket:
///   - bar appliance → match an idle barman + a free bar station.
///   - everything else → match an idle chef + a free station whose
///     def_id provides that appliance (stove, toaster, coffee, etc.).
/// Uses the ticket's own base_cook_seconds_ms (set at place_order
/// time from the recipe catalog) instead of a hardcoded default.
///
/// Mirror-mode safety: ticket-state recheck before claim, so a
/// race against the client's local claim_ticket call is harmless.
///
/// Remaining limitation: when no station of the required appliance
/// exists (e.g. the player hasn't placed a toaster), the ticket
/// stays queued indefinitely. The local sim's tickChef cross-floor
/// orphan path has the same constraint — without a toaster, that
/// recipe can never be cooked.
fn auto_claim_queued_tickets(ctx: &ReducerContext, rid: u64) {
    /// Fallback when ticket.base_cook_seconds_ms is 0 (legacy tickets
    /// or tickets where place_order didn't pass a value).
    const FALLBACK_COOK_SECONDS_MS: i64 = 5_000;

    let queued_ids: Vec<u64> = ctx.db
        .active_ticket()
        .iter()
        .filter(|t| t.restaurant_id == rid && t.state == "queued")
        .map(|t| t.id)
        .collect();
    if queued_ids.is_empty() {
        return;
    }

    // Split idle staff by role. We pop from these as we assign so
    // each actor is only claimed once per tick.
    let mut idle_chefs: Vec<StaffActor> = ctx.db
        .staff_actor()
        .iter()
        .filter(|a| a.restaurant_id == rid
            && a.role == "chef"
            && a.state == "idle"
            && a.ticket_id.is_none())
        .collect();
    let mut idle_barmen: Vec<StaffActor> = ctx.db
        .staff_actor()
        .iter()
        .filter(|a| a.restaurant_id == rid
            && a.role == "barman"
            && a.state == "idle"
            && a.ticket_id.is_none())
        .collect();
    if idle_chefs.is_empty() && idle_barmen.is_empty() {
        return;
    }

    // Initially-occupied stations (chefs/barmen mid-cook). We grow
    // this set as we assign new stations in the loop so the same
    // station can't be claimed twice in one tick.
    let mut occupied: std::collections::HashSet<String> = ctx.db
        .staff_actor()
        .iter()
        .filter(|a| a.restaurant_id == rid && !a.assigned_stove_uid.is_empty())
        .map(|a| a.assigned_stove_uid.clone())
        .collect();

    for ticket_id in queued_ids {
        let Some(ticket) = ctx.db.active_ticket().id().find(ticket_id) else { continue };
        if ticket.state != "queued" { continue; }
        let is_bar = ticket.appliance == "bar";
        // Choose role pool.
        let actor_opt: Option<StaffActor> = if is_bar {
            idle_barmen.pop()
        } else {
            idle_chefs.pop()
        };
        let Some(actor) = actor_opt else { continue; };
        // Find a free station whose `provides` matches the ticket's
        // appliance. Iterates placed_furniture; small N.
        let station: Option<PlacedFurniture> = ctx.db
            .placed_furniture()
            .iter()
            .find(|f| f.restaurant_id == rid
                && def_provides(&f.def_id) == Some(ticket.appliance.as_str())
                && !occupied.contains(&f.uid));
        let Some(station) = station else {
            // Put the actor back; no station for this appliance.
            if is_bar { idle_barmen.push(actor); } else { idle_chefs.push(actor); }
            continue;
        };
        // Lock the station so subsequent iterations don't reuse it.
        occupied.insert(station.uid.clone());

        let cook_seconds_ms = if ticket.base_cook_seconds_ms > 0 {
            ticket.base_cook_seconds_ms
        } else {
            FALLBACK_COOK_SECONDS_MS
        };

        let actor_member_id = actor.member_id.clone();
        let station_uid = station.uid.clone();
        let station_def_id = station.def_id.clone();
        let appliance_label = ticket.appliance.clone();
        ctx.db.active_ticket().id().update(ActiveTicket {
            state: "cooking".to_string(),
            state_clock_ms: 0,
            cook_seconds_ms,
            assigned_chef_id: actor_member_id.clone(),
            ..ticket
        });
        ctx.db.staff_actor().member_id().update(StaffActor {
            state: "movingToWork".to_string(),
            state_clock_ms: 0,
            ticket_id: Some(ticket_id),
            target_x: station.x,
            target_z: station.z,
            target_floor: station.floor,
            assigned_stove_uid: station_uid.clone(),
            ..actor
        });
        log::info!(
            "auto-claim: ticket {} ({}) → {} {} at {} {}",
            ticket_id, appliance_label,
            if is_bar { "barman" } else { "chef" }, actor_member_id,
            station_def_id, station_uid,
        );
    }
}

/// What "appliance" label a furniture def provides, if any. Mirrors
/// the catalog's `provides` field for the subset of defs the server
/// needs to recognise for auto-claim routing. New cookable defs need
/// a matching entry here.
fn def_provides(def_id: &str) -> Option<&'static str> {
    match def_id {
        "stove" | "stove-electric" => Some("stove"),
        "microwave" => Some("microwave"),
        "coffee-machine" => Some("coffee"),
        "blender" => Some("blender"),
        "toaster" => Some("toaster"),
        "bar-counter" | "bar-end" => Some("bar"),
        _ => None,
    }
}

/// Phase H.8 — server-side waiter auto-pickup. Same shape as H.6 but
/// for the delivery side: pairs each ready ticket with an idle
/// waiter, sets the waiter walking toward the plate's pickup spot,
/// and stamps delivery_phase = "pickup" so tick_staff_actor's arrival
/// flip knows it's the first leg of a two-leg trip.
///
/// Mirror-mode safety: the client's local StaffRouter races us. If
/// the local picked a ticket first, ticket.state will already be
/// "delivering" by the time we look — the state check skips it.
///
/// Limitation: assigns FIRST idle waiter found, no spatial sorting.
/// Foreground play still uses the client's distance-weighted picker
/// (W4/W5/W6 logic in StaffRouter); H.8 only kicks in when the local
/// sim is too throttled to fire.
fn auto_assign_ready_tickets(ctx: &ReducerContext, rid: u64) {
    let ready_ids: Vec<u64> = ctx.db
        .active_ticket()
        .iter()
        .filter(|t| t.restaurant_id == rid && t.state == "ready")
        .map(|t| t.id)
        .collect();
    if ready_ids.is_empty() { return; }

    // Idle waiters with no current ticket binding.
    let mut idle_waiters: Vec<StaffActor> = ctx.db
        .staff_actor()
        .iter()
        .filter(|a| a.restaurant_id == rid
            && a.role == "waiter"
            && a.state == "idle"
            && a.ticket_id.is_none())
        .collect();
    if idle_waiters.is_empty() { return; }

    for ticket_id in ready_ids {
        let Some(waiter) = idle_waiters.pop() else { break };
        let Some(ticket) = ctx.db.active_ticket().id().find(ticket_id) else { continue };
        // Recheck — local sim may have raced us.
        if ticket.state != "ready" { continue; }
        let pickup_x = ticket.pickup_x;
        let pickup_z = ticket.pickup_z;
        let pickup_floor = ticket.pickup_floor;
        let waiter_member = waiter.member_id.clone();
        ctx.db.active_ticket().id().update(ActiveTicket {
            state: "delivering".to_string(),
            state_clock_ms: 0,
            ..ticket
        });
        ctx.db.staff_actor().member_id().update(StaffActor {
            state: "movingToWork".to_string(),
            state_clock_ms: 0,
            ticket_id: Some(ticket_id),
            target_x: pickup_x,
            target_z: pickup_z,
            target_floor: pickup_floor,
            delivery_phase: Some("pickup".to_string()),
            ..waiter
        });
        log::info!(
            "auto-assign: ticket {} (ready) → waiter {} walking to pickup ({}, {}, F{})",
            ticket_id, waiter_member, pickup_x, pickup_z, pickup_floor,
        );
    }
}

// Pickup + delivery dwells are zero — we advance the waiter to the
// next leg on the same tick they arrive. The 10 Hz tick period
// (100 ms) already provides a brief "pause" visible to subscribers
// since the row stays at pickup coords for one full tick before the
// next update reroutes them. If we needed visibly longer pauses, a
// proper holdover state with state_clock_ms accumulator would slot
// in here (see WAITER_PICKUP_DWELL_MS in the H.8 design notes).

/// Phase H.7 — release a chef from their current ticket. Called when
/// tick_ticket_state auto-flips a ticket from "cooking" to "ready",
/// and any other path where the server cancels / completes a ticket
/// that had an assigned chef.
///
/// State machine: working/movingToWork → returningHome, target =
/// home_x/z. The H.3 arrival flip then transitions returningHome →
/// idle once the body actually reaches home. Clears the ticket_id +
/// assigned_stove_uid so the chef is available for the next
/// auto-claim pass.
///
/// Skips silently when the chef row no longer exists (was unhired
/// mid-cook). Idempotent: re-running on an already-idle chef
/// produces the same row.
fn release_chef_from_ticket(ctx: &ReducerContext, chef_member_id: &str) {
    let Some(c) = ctx.db.staff_actor().member_id().find(chef_member_id.to_string()) else { return };
    // Don't trample a chef who already moved on (e.g. client mirror
    // raced us and the chef is already idle / returningHome).
    if c.state == "idle" || c.state == "returningHome" {
        return;
    }
    let home_x = c.home_x;
    let home_z = c.home_z;
    let home_floor = c.home_floor;
    ctx.db.staff_actor().member_id().update(StaffActor {
        state: "returningHome".to_string(),
        state_clock_ms: 0,
        ticket_id: None,
        target_x: home_x,
        target_z: home_z,
        target_floor: home_floor,
        assigned_stove_uid: String::new(),
        ..c
    });
    log::info!(
        "release_chef_from_ticket: chef {} returning home to ({}, {}, F{})",
        chef_member_id, home_x, home_z, home_floor,
    );
}

/// Audit fix — companion to release_chef_from_ticket for waiters
/// mid-delivery. Called when the guest-leaving cascade deletes a
/// ticket that a waiter (H.8 auto-assigned) was carrying or walking
/// to. Without this, the waiter would keep walking to a now-vanished
/// seat target and sit there forever in delivery_phase="deliver".
///
/// Mirrors release_chef_from_ticket but clears delivery_phase (the
/// H.8-specific field) instead of assigned_stove_uid.
fn release_waiter_from_ticket(ctx: &ReducerContext, waiter_member_id: &str) {
    let Some(w) = ctx.db.staff_actor().member_id().find(waiter_member_id.to_string()) else { return };
    if w.state == "idle" || w.state == "returningHome" {
        return;
    }
    let home_x = w.home_x;
    let home_z = w.home_z;
    let home_floor = w.home_floor;
    ctx.db.staff_actor().member_id().update(StaffActor {
        state: "returningHome".to_string(),
        state_clock_ms: 0,
        ticket_id: None,
        target_x: home_x,
        target_z: home_z,
        target_floor: home_floor,
        delivery_phase: None,
        ..w
    });
    log::info!(
        "release_waiter_from_ticket: waiter {} returning home (guest left mid-delivery)",
        waiter_member_id,
    );
}

/// Phase H.4 — step one dishwasher batch's cycle clock. When the
/// clock reaches zero, flush every loaded plate / glass back to the
/// CLEAN pool at the highest-tier slot that currently holds dirty
/// stock (or tier 1 as a last resort, matching the client's washOne
/// fallback for an empty dirty pool). Deletes the batch row when
/// flushed so an empty dishwasher doesn't keep ticking.
fn tick_dishwasher_batch(ctx: &ReducerContext, furniture_uid: &str, restaurant_id: u64, dt_ms: i64) {
    let Some(b) = ctx.db.dishwasher_batch().furniture_uid().find(furniture_uid.to_string()) else { return };
    let new_remaining = b.cycle_time_remaining_ms.saturating_sub(dt_ms);
    if new_remaining > 0 {
        // Mid-cycle — just update the clock.
        ctx.db.dishwasher_batch().furniture_uid().update(DishwasherBatch {
            cycle_time_remaining_ms: new_remaining,
            ..b
        });
        return;
    }
    // Cycle finished — convert each loaded piece to a clean pool entry,
    // then delete the batch row.
    for _ in 0..b.plates { flush_one_dish(ctx, restaurant_id, "plate"); }
    for _ in 0..b.glasses { flush_one_dish(ctx, restaurant_id, "glass"); }
    ctx.db.dishwasher_batch().furniture_uid().delete(furniture_uid.to_string());
    log::info!(
        "dishwasher {} cycle finished: flushed {} plate(s) + {} glass(es) to clean pool",
        furniture_uid, b.plates, b.glasses,
    );
}

/// Convert one dirty piece of the given kind into a clean piece in
/// the same restaurant. Walks the pool rows newest-tier-first
/// looking for a dirty count > 0; on hit, decrements dirty +
/// increments clean. Falls back to tier 1 clean +1 (no dirty
/// adjustment) if every pool has dirty == 0 — matches the client's
/// washOne behaviour when the dirty pool is empty (a paranoid
/// "make a clean plate from thin air" path that keeps inventory
/// consistent across edge cases). Mirrors update_dishware_pool's
/// delete-on-zero semantics: we never insert "0/0" rows, but the
/// flush always produces at least 1 clean so a row exists post-call.
fn flush_one_dish(ctx: &ReducerContext, restaurant_id: u64, kind: &str) {
    // Find the highest-tier row with dirty > 0.
    let mut candidate: Option<(String, u32, u32)> = None; // (key, tier, clean)
    let mut best_tier = 0u32;
    for p in ctx.db.dishware_pool().iter() {
        if p.restaurant_id != restaurant_id { continue; }
        if p.kind != kind { continue; }
        if p.dirty == 0 { continue; }
        if p.tier >= best_tier {
            best_tier = p.tier;
            candidate = Some((p.key.clone(), p.tier, p.clean));
        }
    }
    if let Some((key, tier, clean)) = candidate {
        // Need fresh row for the update since the local fields can drift.
        let Some(p) = ctx.db.dishware_pool().key().find(key.clone()) else { return };
        let new_clean = clean.saturating_add(1);
        let new_dirty = p.dirty.saturating_sub(1);
        if new_clean == 0 && new_dirty == 0 {
            ctx.db.dishware_pool().key().delete(key);
        } else {
            ctx.db.dishware_pool().key().update(DishwarePool {
                clean: new_clean, dirty: new_dirty, ..p
            });
        }
        log::info!(
            "flush_one_dish: {} tier {} → clean +1 (now {}), dirty -1 (now {})",
            kind, tier, new_clean, new_dirty,
        );
        return;
    }
    // No dirty inventory — bump tier 1 clean as a safety net.
    let key = pool_key(restaurant_id, kind, 1);
    if let Some(p) = ctx.db.dishware_pool().key().find(key.clone()) {
        ctx.db.dishware_pool().key().update(DishwarePool {
            clean: p.clean.saturating_add(1), ..p
        });
    } else {
        ctx.db.dishware_pool().insert(DishwarePool {
            key,
            restaurant_id,
            kind: kind.to_string(),
            tier: 1,
            clean: 1,
            dirty: 0,
        });
    }
    log::info!(
        "flush_one_dish: no dirty {} found for restaurant {}, materialised one clean at tier 1",
        kind, restaurant_id,
    );
}

/// Per-role base walking speed in meters per second. Mirrors the
/// client-side CHEF_SPEED / WAITER_SPEED constants so cloud-driven
/// movement looks identical to the legacy client sim. Pulled into a
/// helper so future per-actor speed bonuses (training, perks) have
/// one place to override.
fn speed_for_role(role: &str) -> f32 {
    match role {
        // Waiters do all the long walks (table runs, take-order); they
        // need to feel fast so service rate keeps up.
        "waiter" => 2.4,
        // Chef + barman shuffle around their stations — slow on purpose.
        _ => 1.2,
    }
}

/// Phase H.1 — server-side body step. Each tick advances (x, z)
/// toward (target_x, target_z) at the role's walking speed, capped so
/// we never overshoot the target. When the actor arrives (distance <
/// SNAP_EPS meters) we snap position to target so the next tick's
/// distance is 0 and the actor reads as "at rest" to the client.
///
/// Position only — the actor's STATE (idle / movingToWork / working /
/// returningHome) is still client-driven via update_staff_actor. The
/// client decides when to set a new target; the server is now in
/// charge of actually walking there.
///
/// Run regardless of feature flag — when the client is the only
/// writer the cloud row's x/z gets clobbered by the next ~1 Hz
/// streamActorsToCloud call anyway, so this is a no-op in mirror
/// mode. When isServerSim("staff") flips on for the owner (Phase
/// H.3), the client stops mirroring position and the server takes
/// full ownership.
fn tick_staff_actor(ctx: &ReducerContext, member_id: &str, dt_ms: i64) {
    let Some(a) = ctx.db.staff_actor().member_id().find(member_id.to_string()) else { return };
    let (new_x, new_z) = step_toward_target(
        a.x, a.z, a.target_x, a.target_z,
        speed_for_role(&a.role),
        dt_ms,
    );

    // Phase H.3 + H.8 — auto state flips on arrival. Base transitions:
    //   - movingToWork → working when the actor reaches target.
    //   - returningHome → idle when they get home.
    // H.8 waiter additions (when delivery_phase is set):
    //   - working at pickup → after WAITER_PICKUP_DWELL_MS,
    //     movingToWork again with target = seat (carry leg).
    //   - working at seat → after WAITER_DELIVERY_DWELL_MS,
    //     returningHome + ticket flips to "delivered".
    let arrived = (a.target_x - new_x).abs() < 0.01 && (a.target_z - new_z).abs() < 0.01;
    let (transition, advance_clock) = compute_waiter_transition(ctx, &a, arrived, dt_ms);
    let (new_state, new_clock, new_target_x, new_target_z, new_target_floor,
         new_delivery_phase, new_ticket_id) = transition;

    ctx.db.staff_actor().member_id().update(StaffActor {
        x: new_x,
        z: new_z,
        state: new_state,
        state_clock_ms: if advance_clock {
            new_clock.saturating_add(dt_ms)
        } else { new_clock },
        target_x: new_target_x,
        target_z: new_target_z,
        target_floor: new_target_floor,
        delivery_phase: new_delivery_phase,
        ticket_id: new_ticket_id,
        ..a
    });
}

/// Returns the next-tick state + target + delivery_phase + ticket_id
/// for a staff actor, plus a flag for whether the clock should
/// advance by dt_ms (false on transitions that reset the clock to 0).
///
/// Encapsulates the H.3 arrival flips + the H.8 waiter multi-leg
/// transitions in one place so tick_staff_actor stays readable.
type WaiterTransition = (
    String,           // new state
    i64,              // new state_clock_ms (BEFORE adding dt if advance flag is true)
    f32, f32, u32,    // target_x, target_z, target_floor
    Option<String>,   // delivery_phase
    Option<u64>,      // ticket_id
);
fn compute_waiter_transition(ctx: &ReducerContext, a: &StaffActor, arrived: bool, dt_ms: i64)
    -> (WaiterTransition, bool /* advance clock */) {
    // Section A migration fix — proper pickup/delivery dwells so
    // subscribers see the waiter pause at the plate/seat instead of
    // instantly teleporting to the next leg. Encoded as a working
    // state that the function holds the waiter in until the dwell
    // elapses.
    const WAITER_PICKUP_DWELL_MS: i64 = 400;
    const WAITER_DELIVERY_DWELL_MS: i64 = 500;

    if !arrived {
        // Mid-walk — keep everything the same, advance clock.
        return ((
            a.state.clone(), a.state_clock_ms, a.target_x, a.target_z, a.target_floor,
            a.delivery_phase.clone(), a.ticket_id,
        ), true);
    }

    // Arrived. Standard H.3 returningHome → idle flip.
    if a.state == "returningHome" {
        return ((
            "idle".to_string(), 0, a.target_x, a.target_z, a.target_floor,
            None, // clear delivery phase on idle
            None, // and ticket binding
        ), false);
    }

    // working + arrived: this is the dwell hold. Check if the dwell
    // window has elapsed; if not, stay in "working" and advance the
    // clock. If yes, advance to the next leg.
    if a.state == "working" {
        let phase = a.delivery_phase.as_deref().unwrap_or("");
        // Non-waiter "working" (e.g. chef at stove) — no dwell logic,
        // leave it to tick_ticket_state. Advance clock as normal.
        if phase != "pickup" && phase != "deliver" {
            return ((
                a.state.clone(), a.state_clock_ms, a.target_x, a.target_z, a.target_floor,
                a.delivery_phase.clone(), a.ticket_id,
            ), true);
        }
        let dwell_ms = if phase == "pickup" {
            WAITER_PICKUP_DWELL_MS
        } else {
            WAITER_DELIVERY_DWELL_MS
        };
        if a.state_clock_ms + dt_ms < dwell_ms {
            // Still dwelling — stay in working, accumulate clock.
            return ((
                a.state.clone(), a.state_clock_ms, a.target_x, a.target_z, a.target_floor,
                a.delivery_phase.clone(), a.ticket_id,
            ), true);
        }
        // Dwell elapsed — fall through to the leg transition below.
        return advance_waiter_leg(ctx, a, phase);
    }

    if a.state != "movingToWork" {
        return ((
            a.state.clone(), a.state_clock_ms, a.target_x, a.target_z, a.target_floor,
            a.delivery_phase.clone(), a.ticket_id,
        ), true);
    }

    // movingToWork + arrived. Flip to "working" (dwell entry point).
    // Non-delivery actors (chefs) get the same flip; ticket cooking
    // is governed by tick_ticket_state's clock so they stay "working"
    // there.
    ((
        "working".to_string(), 0, a.target_x, a.target_z, a.target_floor,
        a.delivery_phase.clone(), a.ticket_id,
    ), false)
}

/// Advance a waiter to their next delivery leg AFTER the dwell at
/// the current spot has elapsed. Called from compute_waiter_transition
/// when state == "working" and the dwell window passed.
fn advance_waiter_leg(ctx: &ReducerContext, a: &StaffActor, phase: &str)
    -> (WaiterTransition, bool) {
    let Some(ticket_id) = a.ticket_id else {
        // Defensive: phase set but no ticket — return home.
        return ((
            "returningHome".to_string(), 0, a.home_x, a.home_z, a.home_floor,
            None, None,
        ), false);
    };
    let Some(ticket) = ctx.db.active_ticket().id().find(ticket_id) else {
        // Ticket vanished (guest left, cancellation cascade) — send
        // waiter home with no further action. release_waiter_from_ticket
        // would have hit this path for the cascade case already.
        return ((
            "returningHome".to_string(), 0, a.home_x, a.home_z, a.home_floor,
            None, None,
        ), false);
    };
    if phase == "pickup" {
        // Plate grabbed — walk to seat. Ticket stays in "delivering";
        // only the waiter's target advances.
        return ((
            "movingToWork".to_string(), 0,
            ticket.seat_x, ticket.seat_z, ticket.seat_floor,
            Some("deliver".to_string()), Some(ticket_id),
        ), false);
    }
    // phase == "deliver" — plate landed. Flip ticket to "delivered"
    // (tick_ticket_state will delete after dwell); waiter returns home.
    ctx.db.active_ticket().id().update(ActiveTicket {
        state: "delivered".to_string(),
        state_clock_ms: 0,
        ..ticket
    });
    ((
        "returningHome".to_string(), 0, a.home_x, a.home_z, a.home_floor,
        None, None,
    ), false)
}

/// Compute elapsed time between this tick and the previous one for
/// the same restaurant, in milliseconds. Used to advance state-
/// machine clocks at wall-clock pace under server load.
///
/// Section C debt fix — previously this pinned to the scheduled
/// interval (100ms) regardless of real elapsed time. If a tick was
/// delayed by load (e.g. lots of restaurants ticking, GC pause),
/// state machines advanced by 100ms while the wall clock moved
/// further. Guests appeared to slow down on a busy host.
///
/// Falls back to the scheduled interval (100ms) when previous_tick_at
/// is None — first tick after schedule creation OR a restart where
/// the row hadn't been written yet.
///
/// Clamps to [50ms, 1000ms]. Lower clamp protects against clock
/// jitter producing zero / negative diffs (single-tick double-fires
/// from internal retry); upper clamp prevents a multi-second pause
/// from advancing everything to "leaving" in one go (a guest
/// 30 seconds into eating shouldn't jump straight to leaving after
/// a long stall — the clamp lets them catch up across a few ticks
/// instead).
fn compute_dt_ms(now: Timestamp, previous_tick_at: Option<Timestamp>) -> i64 {
    let Some(prev) = previous_tick_at else {
        return SIM_TICK_INTERVAL_MICROS / 1_000;
    };
    // duration_since returns Result<std::time::Duration, ...> — micros
    // converted to ms with saturating_cast since i64::MAX > u128::MAX
    // is impossible for any realistic tick gap.
    let diff_micros = now.duration_since(prev).map(|d| d.as_micros()).unwrap_or(0);
    let diff_ms = (diff_micros / 1_000) as i64;
    diff_ms.clamp(50, 1_000)
}

/// Advance one guest's state machine by `dt_ms`. Phase B.2 handles
/// the transitions the server fully owns:
///   - patience_ms hits zero (in any in-restaurant state) → "leaving"
///     and the patience counter goes idle.
///   - "leaving" dwell elapses → row is deleted (despawn).
///
/// Mid-game transitions that depend on systems still living on the
/// client (seat assignment, order placement, ticket completion) are
/// driven by CLIENT REDUCERS (assign_guest_seat, place_guest_order,
/// deliver_guest_course, etc.) — added below. tick_guest_state only
/// owns the timer-driven half.
fn tick_guest_state(ctx: &ReducerContext, guest_id: u64, dt_ms: i64) {
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else { return };

    // === Despawn path: leaving state has its own dwell timer ===
    if g.state == "leaving" || g.state == "done" {
        let advanced_clock = g.state_clock_ms.saturating_add(dt_ms);
        if advanced_clock >= LEAVING_DWELL_MS {
            // Time's up — drop the row. Client subscription receives
            // a Delete event and removes the rendered character.
            // Cascade: also delete any active_ticket rows still bound
            // to this guest. The chef shouldn't keep cooking food
            // for a customer who already left.
            //
            // Collect (ticket_id, assigned_chef_id) pairs so we can
            // also release the assigned chef from each ticket — H.6
            // auto-claimed them, so without an explicit release here
            // the chef would be stuck "cooking" a ticket that just
            // got deleted, with H.7's release path never firing
            // because tick_ticket_state's cooking→ready transition
            // never runs (the ticket row is gone).
            let orphan_pairs: Vec<(u64, String)> = ctx.db
                .active_ticket()
                .iter()
                .filter(|t| t.guest_id == g.id)
                .map(|t| (t.id, t.assigned_chef_id.clone()))
                .collect();
            // Audit fix — also find waiters mid-delivery with these
            // ticket ids. The H.8 server auto-pickup binds waiter.
            // ticket_id to the ticket; without an explicit release
            // here, a waiter walking a plate to this leaving guest
            // would arrive at an empty seat, never get state-flipped
            // by compute_waiter_transition (the ticket lookup fails
            // → branch to "returningHome", which is fine), but only
            // IF the waiter arrives. If the guest leaves mid-walk and
            // the cascade fires first, the ticket vanishes BEFORE
            // the waiter arrives, leaving the waiter stuck in
            // movingToWork heading to a dead target.
            let orphan_tids: std::collections::HashSet<u64> =
                orphan_pairs.iter().map(|(tid, _)| *tid).collect();
            let waiters_to_release: Vec<String> = ctx.db
                .staff_actor()
                .iter()
                .filter(|a| a.role == "waiter")
                .filter(|a| match a.ticket_id {
                    Some(tid) => orphan_tids.contains(&tid),
                    None => false,
                })
                .map(|a| a.member_id.clone())
                .collect();
            for (tid, chef_id) in orphan_pairs {
                ctx.db.active_ticket().id().delete(tid);
                if !chef_id.is_empty() {
                    release_chef_from_ticket(ctx, &chef_id);
                }
            }
            for waiter_id in waiters_to_release {
                release_waiter_from_ticket(ctx, &waiter_id);
            }
            ctx.db.active_guest().id().delete(g.id);
            return;
        }
        ctx.db.active_guest().id().update(ActiveGuest {
            state_clock_ms: advanced_clock,
            // Patience stops mattering once they're already on the
            // way out — pin to zero so any display reads "0s" instead
            // of going negative.
            patience_ms: 0,
            ..g
        });
        return;
    }

    // === In-restaurant path: advance clock + patience ===
    let new_clock = g.state_clock_ms.saturating_add(dt_ms);
    // Audit fix (B.2) — patience only counts down in states where the
    // guest is genuinely waiting for service (menu / kitchen / seat).
    // WC trips, leaving variants, and unknown client-emitted
    // transitional states (walkingToToilet, atToilet, walkingToWait,
    // walkingToDoor, etc.) DON'T decrement patience — a guest on a
    // long bathroom break shouldn't time out and be force-flipped to
    // leaving mid-pee. The "waiting" overflow chair has its own
    // waiting_timeout_ms clock (Phase H.5) so it's excluded here too.
    let patience_active = matches!(g.state.as_str(),
        "walkingIn" | "seated" | "ordering" | "waitingForFood" | "eating"
    );
    let new_patience = if patience_active {
        (g.patience_ms - dt_ms).max(0)
    } else {
        g.patience_ms
    };

    // Patience timeout → kick into leaving. Same effect as the
    // client's existing "guest gives up" path, surfaced as a single
    // server-side transition so the timing is consistent across
    // clients. Gated on patience_active so non-impatient states (WC
    // trips, transitional walks) can't trigger it even if a stale
    // 0 patience value lingered from a prior state.
    if patience_active && new_patience == 0 && g.patience_ms > 0 {
        ctx.db.active_guest().id().update(ActiveGuest {
            state: "leaving".to_string(),
            state_clock_ms: 0,
            patience_ms: 0,
            ..g
        });
        log::info!("guest {} timed out — transitioning to leaving", g.id);
        return;
    }

    // Phase H.5 — overflow-chair waiting timeout. Guests parked on a
    // yellow waiting chair use a SEPARATE clock from the patience
    // timer (which represents in-seat impatience). waiting_timeout_ms
    // counts down only while state == "waiting"; when it hits zero
    // the guest leaves in disgust. Same client-side transition the
    // local GuestSpawner runs today; mirroring it here keeps the
    // two devices in sync when the player switches mid-meal.
    if g.state == "waiting" && g.waiting_timeout_ms > 0 {
        let new_wait = (g.waiting_timeout_ms - dt_ms).max(0);
        if new_wait == 0 {
            ctx.db.active_guest().id().update(ActiveGuest {
                state: "leaving".to_string(),
                state_clock_ms: 0,
                patience_ms: 0,
                waiting_timeout_ms: 0,
                ..g
            });
            log::info!("guest {} gave up at overflow chair — transitioning to leaving", g.id);
            return;
        }
        // Mid-wait: just decrement the waiting clock alongside the
        // standard clock advance. Flow through to the position step
        // below in case the client moved the guest's body separately
        // (e.g. they shuffled to a different overflow chair).
        let (new_x, new_z) = (g.x, g.z); // anchored to the chair
        ctx.db.active_guest().id().update(ActiveGuest {
            state_clock_ms: new_clock,
            patience_ms: new_patience,
            waiting_timeout_ms: new_wait,
            x: new_x,
            z: new_z,
            ..g
        });
        return;
    }

    // Phase H.12 — fallback seat assignment. If the guest is still
    // in walkingIn with no seat_uid after ASSIGN_SEAT_GRACE_MS, the
    // client's local sim either hasn't picked one (backgrounded tab)
    // or never will (no local sim at all). Pick the nearest free
    // table server-side so the guest doesn't stand at the door
    // forever. Grace period lets the local sim's smarter pick run
    // first on a foreground tab.
    let (assigned_seat, assigned_target) =
        if g.state == "walkingIn" && g.seat_uid.is_empty()
            && new_clock >= ASSIGN_SEAT_GRACE_MS {
            match try_assign_seat(ctx, &g) {
                Some((uid, tx, tz, tf)) => {
                    log::info!("guest {} assigned table {} (server fallback)", g.id, uid);
                    (uid, Some((tx, tz, tf)))
                }
                None => (g.seat_uid.clone(), None),
            }
        } else {
            (g.seat_uid.clone(), None)
        };
    let (effective_target_x, effective_target_z, effective_target_floor) =
        match assigned_target {
            Some((tx, tz, tf)) => (tx, tz, tf),
            None => (g.target_x, g.target_z, g.target_floor),
        };

    // Phase H.2 — server steps the guest's body toward target_x/z
    // at GUEST_SPEED. Same model as tick_staff_actor: snap on arrival,
    // cap step to max_step to avoid overshoot. Skipped for "seated" /
    // "ordering" / "eating" — those states pin the guest to a seat and
    // target_x/z would just match position. Cheap to do unconditionally
    // (dist == 0 → no move), so we keep the branch tight by checking
    // the obvious anchored states once.
    // Audit fix — "waiting" removed from the anchored list. The
    // client's local sim may shuffle a waiting guest between
    // overflow chairs (relocateGuestToBetterChair etc.); without
    // the position step running, server's row stayed pinned to
    // the FIRST chair's coords. The H.5 waiting_timeout_ms branch
    // above already early-returns for "waiting" guests, so this
    // branch only fires for in-restaurant states that aren't yet
    // waiting — position step is a no-op anyway when target ≈ x.
    let anchored = matches!(
        g.state.as_str(),
        "seated" | "ordering" | "eating" | "wcSitting" | "wcWashing"
    );
    let (new_x, new_z) = if anchored {
        (g.x, g.z)
    } else {
        step_toward_target(g.x, g.z, effective_target_x, effective_target_z, GUEST_SPEED, dt_ms)
    };

    // Phase H.9 — server-side guest state-machine transitions. Each
    // branch returns the new (state, state_clock) pair. None means
    // "no transition, advance the clock". Mirror-mode safety: every
    // branch rechecks the precondition; if the client already
    // transitioned via update_guest_position the cloud's state will
    // already be the next one and the branch skips.
    let arrived = (g.target_x - new_x).abs() < 0.01
        && (g.target_z - new_z).abs() < 0.01;
    let transition: Option<(String, i64)> = match g.state.as_str() {
        // walkingIn → seated when the guest reaches their seat. Two
        // gates: (1) arrived at target; (2) state_clock_ms >=
        // WALKING_IN_MIN_MS so a freshly-spawned guest whose spawn
        // position already equals its target (target_x = door_x at
        // insert time, until client mirrors the seat position) isn't
        // instantly "seated" while still rendering the door walk.
        // Without (2), a server tick fires walkingIn → seated within
        // 100ms of spawn, the client mirror then re-pushes
        // state="walkingIn" via update_guest_position, the server's
        // next arrival check fires again, and the state ping-pongs.
        // 500 ms is one client mirror-cycle worth of grace.
        "walkingIn" if arrived && new_clock >= WALKING_IN_MIN_MS =>
            Some(("seated".to_string(), 0)),
        // seated → ordering after a brief dwell (the guest reads the
        // menu). Same SEATED_DWELL_MS the client uses (TIME_TO_ORDER).
        // The state_clock_ms is the elapsed dwell.
        "seated" if new_clock >= SEATED_DWELL_MS => Some(("ordering".to_string(), 0)),
        // waitingForFood → eating when ANY active_ticket bound to this
        // guest has state "delivered" (H.8 waiter set it on arrival
        // at the seat). The plate has landed, customer starts eating.
        "waitingForFood" if has_delivered_ticket_for_guest(ctx, g.id) =>
            Some(("eating".to_string(), 0)),
        // eating → next course or leaving after EATING_DURATION_MS.
        // (See order_index advance below — server now owns this too.)
        //
        // Race-safety: skip the transition entirely when
        // order_recipes is empty. The client hasn't yet mirrored
        // the order CSV (set_guest_order is async after buildOrder),
        // so total_courses=0 would incorrectly fire "leaving" on
        // the first course. We'd rather extend the eating dwell a
        // tick or two than send a paying customer home with a
        // forgotten order. The local sim's own eating→leaving still
        // fires at the matching time.
        "eating" if new_clock >= EATING_DURATION_MS && !g.order_recipes.is_empty() => {
            let total_courses = g.order_recipes
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .count() as u32;
            if g.order_index + 1 < total_courses {
                Some(("seated".to_string(), 0))
            } else {
                Some(("leaving".to_string(), 0))
            }
        },
        // wcWalking → wcSitting on arrival at the toilet.
        "wcWalking" if arrived => Some(("wcSitting".to_string(), 0)),
        // wcSitting → wcWashing after WC_USE_MS — the toilet trip.
        "wcSitting" if new_clock >= WC_USE_MS => Some(("wcWashing".to_string(), 0)),
        // wcWashing → seated after WC_WASH_MS — back to the seat.
        // (Walking back is a separate state in the client; here we
        // collapse it into a direct return since the client's local
        // sim handles the walk model. Server-side this means
        // wcWashing → seated and the client picks up rendering.)
        "wcWashing" if new_clock >= WC_WASH_MS => Some(("seated".to_string(), 0)),
        // No other server-driven transitions yet. ordering →
        // waitingForFood depends on waiter take-order which is
        // client-driven; eating → leaving needs order count (not
        // currently in the cloud schema).
        _ => None,
    };
    let (final_state, final_clock) = match &transition {
        Some((new_state, new_clk)) => {
            log::info!("guest {} {} → {}", g.id, g.state, new_state);
            (new_state.clone(), *new_clk)
        }
        None => (g.state.clone(), new_clock),
    };

    // H.11 — server-side order_index advance when transitioning
    // eating → seated. The client's local sim ALSO advances this on
    // its own eating→seated path; idempotent because the new
    // order_index value lines up with what the client would have
    // set after EATING_DURATION_MS elapsed. Necessary for the
    // server's "next course or leaving" branch to fire correctly
    // on subsequent ticks — without bumping it, the server would
    // re-trigger the same transition indefinitely.
    let new_order_index = if g.state == "eating" && final_state == "seated" {
        g.order_index.saturating_add(1)
    } else {
        g.order_index
    };

    ctx.db.active_guest().id().update(ActiveGuest {
        state: final_state,
        state_clock_ms: final_clock,
        patience_ms: new_patience,
        order_index: new_order_index,
        x: new_x,
        z: new_z,
        // H.12 — apply server fallback seat assignment if it fired.
        // When assigned_target is None, these read back to the
        // existing row values (no change).
        seat_uid: assigned_seat,
        target_x: effective_target_x,
        target_z: effective_target_z,
        target_floor: effective_target_floor,
        ..g
    });
}

/// Minimum time a guest must spend in "walkingIn" before the server
/// will flip them to "seated" on arrival. Prevents the spawn-tick
/// ping-pong where a guest spawned at (door, target=door) instantly
/// arrives, the server flips to seated, and the client's still-in-
/// flight mirror reverts to walkingIn. 500ms covers one client
/// position-stream tick.
const WALKING_IN_MIN_MS: i64 = 500;
/// Grace period before the server's fallback seat assignment fires.
/// Longer than WALKING_IN_MIN_MS because the client may pick a seat
/// AFTER the mirror catches up — 1.5s gives the local sim ~15 ticks
/// to make its choice before the server takes over.
const ASSIGN_SEAT_GRACE_MS: i64 = 1_500;
/// Time the guest dwells in "seated" before transitioning to
/// "ordering". Matches the client's TIME_TO_ORDER constant
/// (config/customer-config.ts). 4 seconds = the customer pretends to
/// read the menu before flagging the waiter.
const SEATED_DWELL_MS: i64 = 4_000;
/// Time the guest dwells in "eating" before either advancing to the
/// next course or leaving. Matches the client's TIME_TO_EAT constant.
/// 8 seconds = generous enough for the plate animation to read.
const EATING_DURATION_MS: i64 = 8_000;
/// Time the guest dwells on the toilet before washing hands.
const WC_USE_MS: i64 = 6_000;
/// Time the guest dwells at the sink before returning to seat.
const WC_WASH_MS: i64 = 3_000;

/// True if the given guest has any active_ticket row in state
/// "delivered" — i.e. a plate has just landed at their seat. H.10
/// uses this to flip waitingForFood → eating server-side.
///
/// active_guest.ticket_id is also set by client mirroring (eventually)
/// but the more reliable signal is on the ticket side: active_ticket.
/// guest_id is set at place_order and never changes. We walk the
/// (short) ticket list filtered by guest_id and look for "delivered".
fn has_delivered_ticket_for_guest(ctx: &ReducerContext, guest_id: u64) -> bool {
    for t in ctx.db.active_ticket().iter() {
        if t.guest_id == guest_id && t.state == "delivered" {
            return true;
        }
    }
    false
}

/// Furniture def_ids the server recognises as guest-seating tables.
/// Mirrors the entries in v2/src/data/furnitureCatalog.ts that have
/// category=="table" with seatSlots. Hardcoded because the server
/// doesn't load the TypeScript catalog. Bar furniture (bar-counter,
/// bar-end) is excluded — bar seating goes through the barman path
/// which has different state machine semantics.
///
/// New tables added to the client catalog need a corresponding entry
/// here for the server-side seat-assignment fallback to consider
/// them. Without an entry, those tables exist but server-side
/// auto-seating skips them (the local sim still works).
fn is_seat_providing_def(def_id: &str) -> bool {
    matches!(def_id,
        "small-table" | "round-table" | "dining-table" | "fancy-table"
        | "cloth-table" | "glass-table"
        | "coffee-table" | "coffee-glass" | "coffee-square" | "coffee-glass-sq"
    )
}

/// H.12 — Server-side fallback seat assignment. Called from
/// tick_guest_state when a guest has been in "walkingIn" for
/// ASSIGN_SEAT_GRACE_MS without the client having mirrored a seat
/// target. Picks the closest unoccupied table.
///
/// "Unoccupied" = no other active_guest in the same restaurant has
/// this table's uid in their seat_uid field. Conservative — a guest
/// who's mid-meal still holds the seat even on their leaving leg
/// (intentional; prevents instant double-booking when one guest
/// leaves and another spawns the same tick).
///
/// Returns the (uid, x, z, floor) of the assigned table, or None if
/// no free table exists. Caller is responsible for writing it back
/// to the guest row.
///
/// Limitations vs the client's pickBestSeatForTaste:
/// - Distance-based pick only; no scoring on decor / window / taste /
///   diet. The client still owns the "good seat" decision when the
///   local sim is running; H.12 is a backstop for backgrounded tabs.
/// - Sets target = table center, not a chair slot. Visit-mode
///   subscribers see the guest standing at the table centre, not on
///   a specific chair. The client's local sim, if running, will
///   override with proper chair coords.
fn try_assign_seat(ctx: &ReducerContext, g: &ActiveGuest) -> Option<(String, f32, f32, u32)> {
    let rid = g.restaurant_id;
    // Build set of taken seat uids (other guests' seat_uid).
    let mut taken_uids: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Audit fix (B.5) — also collect other guests' walking targets.
    // The client's local seat pick sets target_x/z to the chair but
    // doesn't mirror seat_uid (no field in update_guest_position).
    // Without this, the server would re-assign a chair the local sim
    // already chose. We treat any (target_x, target_z) within
    // SEAT_OCCUPANCY_RADIUS_SQ of a chair as "taken too".
    const SEAT_OCCUPANCY_RADIUS_SQ: f32 = 0.25; // 0.5m radius
    let mut taken_targets: Vec<(f32, f32)> = Vec::new();
    for other in ctx.db.active_guest().iter() {
        if other.restaurant_id != rid { continue; }
        if other.id == g.id { continue; }
        if !other.seat_uid.is_empty() {
            taken_uids.insert(other.seat_uid.clone());
        } else if other.state == "walkingIn" {
            // Walking-in guest with no explicit seat assignment
            // (probably picked locally; cloud row's seat_uid lags
            // until/unless we add it to the mirror reducer).
            taken_targets.push((other.target_x, other.target_z));
        }
    }
    // Find the closest free table.
    let mut best: Option<(String, f32, f32, u32)> = None;
    let mut best_dist = f32::INFINITY;
    for f in ctx.db.placed_furniture().iter() {
        if f.restaurant_id != rid { continue; }
        if !is_seat_providing_def(&f.def_id) { continue; }
        if taken_uids.contains(&f.uid) { continue; }
        // Skip chairs another guest is walking toward (catches the
        // local-pick race).
        let occupied_by_target = taken_targets.iter().any(|(tx, tz)| {
            let dx = f.x - tx;
            let dz = f.z - tz;
            dx * dx + dz * dz < SEAT_OCCUPANCY_RADIUS_SQ
        });
        if occupied_by_target { continue; }
        let dx = f.x - g.x;
        let dz = f.z - g.z;
        let dist = dx * dx + dz * dz;
        if dist < best_dist {
            best_dist = dist;
            best = Some((f.uid.clone(), f.x, f.z, f.floor));
        }
    }
    best
}

/// Guest walking speed in m/s. Matches the client-side default that
/// drives in-restaurant character movement. One value covers every
/// in-restaurant state — the variation customers SEEM to have on
/// screen is just the pathfinder picking longer / shorter routes, not
/// per-state speed.
const GUEST_SPEED: f32 = 1.5;

/// Distance below which a step snaps to the target. One eighth of a
/// pathfinder cell — far enough below "at rest" to read clean to
/// subscribers, large enough not to wobble on f32 drift.
const STEP_SNAP_EPS: f32 = 0.125;

/// Step (x, z) toward (target_x, target_z) at `speed` m/s over `dt_ms`
/// milliseconds. Returns the new (x, z). Shared by staff + guest body
/// movement so they snap / cap identically.
fn step_toward_target(x: f32, z: f32, target_x: f32, target_z: f32, speed: f32, dt_ms: i64) -> (f32, f32) {
    let dt_sec = (dt_ms as f32) / 1000.0;
    let max_step = speed * dt_sec;
    let dx = target_x - x;
    let dz = target_z - z;
    let dist = (dx * dx + dz * dz).sqrt();
    if dist <= STEP_SNAP_EPS {
        (target_x, target_z)
    } else if dist <= max_step {
        (target_x, target_z)
    } else {
        let scale = max_step / dist;
        (x + dx * scale, z + dz * scale)
    }
}

/// Phase C.1 — step one ticket's state machine. Stub for now: only
/// the dwell-then-delete leg of "delivered" tickets is wired so a
/// completed ticket cleans up automatically. State transitions
/// driven by the server (cooking → ready when timer elapses) land
/// in Phase C.2 alongside the place_order / claim_ticket /
/// finish_cooking / deliver_ticket reducers.
fn tick_ticket_state(ctx: &ReducerContext, ticket_id: u64, dt_ms: i64) {
    let Some(t) = ctx.db.active_ticket().id().find(ticket_id) else { return };

    // Delivered tickets dwell briefly so the client gets one more
    // subscription event with the final state, then disappear.
    // 1 s is enough — much shorter than the leaving-guest dwell
    // because there's no walk-out animation to play.
    const DELIVERED_DWELL_MS: i64 = 1_000;
    if t.state == "delivered" {
        let advanced = t.state_clock_ms.saturating_add(dt_ms);
        if advanced >= DELIVERED_DWELL_MS {
            ctx.db.active_ticket().id().delete(t.id);
            return;
        }
        ctx.db.active_ticket().id().update(ActiveTicket {
            state_clock_ms: advanced,
            ..t
        });
        return;
    }

    // Phase C.2 — cooking tickets advance their state-clock and
    // auto-transition to "ready" when the clock reaches the chef-
    // adjusted cook_seconds_ms. The client picks up the "ready"
    // event via subscription and walks a waiter to pickup_x/z.
    if t.state == "cooking" {
        let advanced = t.state_clock_ms.saturating_add(dt_ms);
        if advanced >= t.cook_seconds_ms && t.cook_seconds_ms > 0 {
            let chef_id = t.assigned_chef_id.clone();
            ctx.db.active_ticket().id().update(ActiveTicket {
                state: "ready".to_string(),
                state_clock_ms: 0,
                ..t
            });
            // Phase H.7 — release the assigned chef when cooking
            // finishes. Auto-claim (H.6) hooked the chef to this
            // ticket; without a release, the chef stays in "working"
            // at the stove forever and never claims the next ticket.
            // Sends them home_x/z so H.3's auto-flip transitions
            // them back to "idle" on arrival.
            if !chef_id.is_empty() {
                release_chef_from_ticket(ctx, &chef_id);
            }
            return;
        }
        ctx.db.active_ticket().id().update(ActiveTicket {
            state_clock_ms: advanced,
            ..t
        });
        return;
    }

    // Other states (queued / ready / delivering) are client-driven —
    // the local StaffRouter calls reducers to transition them.
    // Nothing to do here per-tick.
}

// =============================================================
//                        Phase B reducers
// =============================================================
// User-action reducers that the client calls into. spawn_guest is
// the first; subsequent phases add assign_guest_seat,
// place_guest_order, finish_guest_course, despawn_guest.
//
// Authorisation: today every reducer here is gated on
// "ctx.sender owns the restaurant_id" via the restaurant table.
// Co-owners + admin overrides plug in later when needed.

/// Spawn a new active_guest row in a restaurant. Called by the client
/// (the owner's session) when a P5 pedestrian destined for THIS plot
/// reaches its door. The same data the client used to build a local
/// ActiveGuest now goes through this reducer so the row appears in
/// the server-authoritative table instead.
///
/// All taste / archetype fields are passed in by the client — the
/// roll happens client-side for now using the existing
/// data/customerArchetypes.ts logic, then the result is forwarded.
/// Phase B.3+ can move the roll server-side once the customer-taste
/// catalog is also in Rust.
///
/// Returns Err if the caller doesn't own the restaurant.
#[reducer]
pub fn spawn_guest(
    ctx: &ReducerContext,
    restaurant_id: u64,
    client_temp_id: String,
    variant: String,
    archetype: String,
    taste_diet: String,
    taste_decor_pref: f32,
    taste_window_pref: f32,
    taste_cuisine_bias: String,
    taste_drink_tolerance: f32,
    will_use_toilet: bool,
    door_x: f32,
    door_z: f32,
    door_floor: u32,
) -> Result<(), String> {
    // Auth — only the owning client (or a co-owner, when that lands)
    // can spawn guests into a restaurant. Prevents one client
    // injecting customers into another's shop.
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can spawn guests".into());
    }

    ctx.db.active_guest().insert(ActiveGuest {
        id: 0, // auto_inc
        restaurant_id,
        client_temp_id,
        // Identity
        variant,
        archetype,
        // Taste
        taste_diet,
        taste_decor_pref,
        taste_window_pref,
        taste_cuisine_bias,
        taste_drink_tolerance,
        will_use_toilet,
        // State — they spawn outside, walking toward the door.
        state: "walkingIn".to_string(),
        state_clock_ms: 0,
        patience_ms: DEFAULT_PATIENCE_MS,
        // Seat (unassigned until they arrive at the door)
        seat_uid: String::new(),
        seat_x: 0.0,
        seat_z: 0.0,
        seat_facing_y: 0.0,
        seat_floor: 0,
        seat_at_bar: false,
        plate_x: 0.0,
        plate_z: 0.0,
        // Body — start AT the door so the first frame's lerp doesn't
        // teleport. Client picks up the exterior approach handoff via
        // its existing pedestrian→customer path.
        x: door_x,
        z: door_z,
        floor: door_floor,
        target_x: door_x,
        target_z: door_z,
        target_floor: door_floor,
        // Order — empty until ordering completes (Phase C).
        order_recipes: String::new(),
        order_index: 0,
        ticket_id: None,
        reserved_dish_tiers: String::new(),
        // Overflow waitlist — not waitlisted at spawn.
        waiting_chair_uid: String::new(),
        waiting_timeout_ms: 0,
        // Bookkeeping
        total_paid_cents: 0,
        total_satisfaction_x100: 0,
        dishes_settled: false,
        spawned_at: ctx.timestamp,
    });
    Ok(())
}

/// Mark a guest as "leaving" right now (e.g. they finished their meal
/// in the client-side simulation, or the player triggered a manual
/// despawn). The row stays for LEAVING_DWELL_MS so the client can
/// play the walk-out animation before the model disappears.
///
/// Idempotent — re-marking a leaving guest is a no-op.
#[reducer]
pub fn mark_guest_leaving(ctx: &ReducerContext, guest_id: u64) -> Result<(), String> {
    let g = ctx.db.active_guest().id().find(guest_id)
        .ok_or_else(|| format!("Guest {guest_id} not found"))?;
    // Auth — only the owning restaurant's client can transition its
    // own guests.
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can manage guests".into());
    }
    if g.state == "leaving" || g.state == "done" {
        return Ok(()); // idempotent
    }
    ctx.db.active_guest().id().update(ActiveGuest {
        state: "leaving".to_string(),
        state_clock_ms: 0,
        patience_ms: 0,
        ..g
    });
    Ok(())
}

/// Client-driven position update — replaces the body coords on a
/// guest. Until pathfinding moves server-side (later phase) the
/// client owns "where is this guest right now" and just streams its
/// position back so other clients (P4 visit mode, future co-owner
/// view) see the same body location.
///
/// Throttled by the caller — typical cadence ~5 Hz. The reducer
/// itself doesn't rate-limit; future hardening can add a min-delta
/// guard if abuse appears.
/// H.11 — Client tells the server which recipes the guest ordered so
/// the server can drive the multi-course eating cycle. Comma-separated
/// recipe ids; order_index = 0 is the first course.
///
/// Idempotent: re-setting the same CSV is a no-op. The client
/// typically calls this once per guest, right after buildOrder
/// populates g.order.
#[reducer]
pub fn set_guest_order(
    ctx: &ReducerContext,
    guest_id: u64,
    recipes_csv: String,
) -> Result<(), String> {
    let g = ctx.db.active_guest().id().find(guest_id)
        .ok_or_else(|| format!("Guest {guest_id} not found"))?;
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set guest orders".into());
    }
    if g.order_recipes == recipes_csv {
        return Ok(()); // idempotent
    }
    ctx.db.active_guest().id().update(ActiveGuest {
        order_recipes: recipes_csv,
        ..g
    });
    Ok(())
}

#[reducer]
pub fn update_guest_position(
    ctx: &ReducerContext,
    guest_id: u64,
    x: f32,
    z: f32,
    floor: u32,
    target_x: f32,
    target_z: f32,
    target_floor: u32,
    state: String,
) -> Result<(), String> {
    let g = ctx.db.active_guest().id().find(guest_id)
        .ok_or_else(|| format!("Guest {guest_id} not found"))?;
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can move their guests".into());
    }
    // Reset state_clock when the state label actually flips so the
    // server tick's countdown (eating timer, ordering wait) starts
    // from zero on the transition rather than carrying the prior
    // state's elapsed time forward.
    let state_changed = g.state != state;
    let new_clock = if state_changed { 0 } else { g.state_clock_ms };
    // Audit fix (B.3) — "leaving" writes via this reducer USED to
    // be silently blocked under the theory that mark_guest_leaving
    // owned the LEAVING_DWELL countdown. But client paths that flip
    // state to "leaving" without going through mark_guest_leaving
    // (the markLostAndExit / "all courses done" branches) relied on
    // the position mirror to push the transition. Blocking it left
    // those guests permanently stuck in their pre-leaving state on
    // the cloud row. We now allow the write — when the state truly
    // changes to "leaving", new_clock=0 above gives us a fresh
    // LEAVING_DWELL countdown anyway. Subsequent same-state mirror
    // writes preserve the clock (state_changed=false), so duplicate
    // pushes don't reset the despawn timer.
    let new_state = state;
    ctx.db.active_guest().id().update(ActiveGuest {
        x, z, floor, target_x, target_z, target_floor,
        state: new_state,
        state_clock_ms: new_clock,
        ..g
    });
    Ok(())
}

// =============================================================
//                        Phase C reducers
// =============================================================
// Client-driven ticket lifecycle. Cook-timer auto-transition (from
// "cooking" → "ready") happens server-side in tick_ticket_state;
// every other state flip is initiated by the local StaffRouter
// because it owns the chef + waiter routing (until Phase D moves
// that server-side too).

/// Helper: load a ticket and verify the caller owns its restaurant.
fn require_ticket_owner(
    ctx: &ReducerContext,
    ticket_id: u64,
) -> Result<ActiveTicket, String> {
    let t = ctx.db.active_ticket().id().find(ticket_id)
        .ok_or_else(|| format!("Ticket {ticket_id} not found"))?;
    let r = ctx.db.restaurant().id().find(t.restaurant_id)
        .ok_or_else(|| "Ticket's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can manage their tickets".into());
    }
    Ok(t)
}

/// A guest just placed their order — create one ticket per course.
/// The client supplies the recipe + cook-time base (read from its
/// catalog), the seat position (denormalised so the kitchen can
/// route without joining), and a client_temp_id for correlation
/// back to its local Ticket id.
#[reducer]
pub fn place_order(
    ctx: &ReducerContext,
    guest_id: u64,
    client_temp_id: String,
    recipe_id: String,
    base_cook_seconds_ms: i64,
    appliance: String,
    seat_x: f32,
    seat_z: f32,
    seat_floor: u32,
    seat_at_bar: bool,
) -> Result<(), String> {
    let g = ctx.db.active_guest().id().find(guest_id)
        .ok_or_else(|| format!("Guest {guest_id} not found"))?;
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can place orders".into());
    }
    ctx.db.active_ticket().insert(ActiveTicket {
        id: 0, // auto_inc
        restaurant_id: g.restaurant_id,
        guest_id,
        client_temp_id,
        recipe_id,
        state: "queued".to_string(),
        state_clock_ms: 0,
        base_cook_seconds_ms,
        // cook_seconds_ms is set on claim with chef multiplier; 0 here.
        cook_seconds_ms: 0,
        appliance,
        assigned_chef_id: String::new(),
        seat_x, seat_z, seat_floor, seat_at_bar,
        pickup_x: 0.0,
        pickup_z: 0.0,
        pickup_floor: 0,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// A chef just picked this ticket off the queue. Records who's
/// cooking + the chef-specific cook duration, flips state to
/// "cooking", and resets the state-machine clock so tick_ticket_state
/// can start counting toward cook_seconds_ms. Idempotent: claiming
/// an already-claimed ticket by the SAME chef is a no-op; by a
/// different chef rejects.
#[reducer]
pub fn claim_ticket(
    ctx: &ReducerContext,
    ticket_id: u64,
    chef_member_id: String,
    cook_seconds_ms: i64,
) -> Result<(), String> {
    let t = require_ticket_owner(ctx, ticket_id)?;
    if t.state == "cooking" {
        if t.assigned_chef_id == chef_member_id {
            return Ok(()); // idempotent re-claim
        }
        return Err(format!(
            "Ticket already claimed by {}", t.assigned_chef_id
        ));
    }
    if t.state != "queued" {
        return Err(format!("Ticket is in state {}, can't claim", t.state));
    }
    ctx.db.active_ticket().id().update(ActiveTicket {
        state: "cooking".to_string(),
        state_clock_ms: 0,
        cook_seconds_ms,
        assigned_chef_id: chef_member_id,
        ..t
    });
    Ok(())
}

/// Chef finished cooking — explicit override of the auto-transition
/// (which fires on its own when cook_seconds_ms elapse). The client
/// calls this if its local timer fires first OR to set the pickup
/// position before the waiter scan looks for a "ready" plate. State
/// flips to "ready", pickup coords stored for the waiter.
#[reducer]
pub fn finish_cooking(
    ctx: &ReducerContext,
    ticket_id: u64,
    pickup_x: f32,
    pickup_z: f32,
    pickup_floor: u32,
) -> Result<(), String> {
    let t = require_ticket_owner(ctx, ticket_id)?;
    if t.state == "ready" || t.state == "delivering" || t.state == "delivered" {
        return Ok(()); // idempotent past the cooking step
    }
    if t.state != "cooking" {
        return Err(format!("Ticket is in state {}, can't finish cooking", t.state));
    }
    ctx.db.active_ticket().id().update(ActiveTicket {
        state: "ready".to_string(),
        state_clock_ms: 0,
        pickup_x, pickup_z, pickup_floor,
        ..t
    });
    Ok(())
}

/// Waiter has picked the plate off the pickup spot and is en route
/// to the seat. "ready" → "delivering". From this point the plate
/// is in transit; the server doesn't simulate the walk (Phase D
/// will, when staff actors move server-side).
#[reducer]
pub fn pickup_ticket(ctx: &ReducerContext, ticket_id: u64) -> Result<(), String> {
    let t = require_ticket_owner(ctx, ticket_id)?;
    if t.state == "delivering" || t.state == "delivered" {
        return Ok(());
    }
    if t.state != "ready" {
        return Err(format!("Ticket is in state {}, can't pick up", t.state));
    }
    ctx.db.active_ticket().id().update(ActiveTicket {
        state: "delivering".to_string(),
        state_clock_ms: 0,
        ..t
    });
    Ok(())
}

/// Plate landed at the guest. "delivering" → "delivered". The tick
/// loop's dwell timer then deletes the row after DELIVERED_DWELL_MS
/// so a final subscription event ships before the row vanishes.
#[reducer]
pub fn deliver_ticket(ctx: &ReducerContext, ticket_id: u64) -> Result<(), String> {
    let t = require_ticket_owner(ctx, ticket_id)?;
    if t.state == "delivered" {
        return Ok(());
    }
    ctx.db.active_ticket().id().update(ActiveTicket {
        state: "delivered".to_string(),
        state_clock_ms: 0,
        ..t
    });
    Ok(())
}

/// Drop a ticket outright (e.g. the guest left before their food
/// arrived). Bypasses the dwell — the chef shouldn't keep an
/// orphan order on screen. Idempotent: missing ticket is a no-op.
#[reducer]
pub fn cancel_ticket(ctx: &ReducerContext, ticket_id: u64) -> Result<(), String> {
    let t = match ctx.db.active_ticket().id().find(ticket_id) {
        Some(t) => t,
        None => return Ok(()), // already gone
    };
    let r = ctx.db.restaurant().id().find(t.restaurant_id)
        .ok_or_else(|| "Ticket's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can cancel their tickets".into());
    }
    ctx.db.active_ticket().id().delete(t.id);
    Ok(())
}

// =============================================================
//                        Phase D reducers
// =============================================================
// Staff actor lifecycle. Three reducers in D.2: register / update /
// unregister. The client mirrors its local StaffRouter actors via
// these calls; the comprehensive update_staff_actor takes the full
// row's worth of fields so the StaffRouter mirror can stream any
// combination of changes in a single network call.

/// First registration of an actor into the restaurant. The client
/// calls this when a hired staff member is dispatched into the
/// world (just after the GLB character loads). Idempotent against
/// the same member_id — a re-register updates the existing row's
/// metadata + resets state to "idle".
#[reducer]
pub fn register_staff_actor(
    ctx: &ReducerContext,
    restaurant_id: u64,
    member_id: String,
    role: String,
    home_floor: u32,
    home_x: f32,
    home_z: f32,
    spawn_x: f32,
    spawn_z: f32,
    spawn_floor: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can register staff actors".into());
    }
    let existing = ctx.db.staff_actor().member_id().find(member_id.clone());
    if let Some(prev) = existing {
        // Re-register — refresh metadata + reset state. Useful when
        // the player rehires the same member after a fire/refresh
        // round-trip, or when an old session's row lingered.
        ctx.db.staff_actor().member_id().update(StaffActor {
            role, home_floor, home_x, home_z,
            state: "idle".to_string(),
            state_clock_ms: 0,
            ticket_id: None,
            x: spawn_x, z: spawn_z, floor: spawn_floor,
            target_x: home_x, target_z: home_z, target_floor: home_floor,
            assigned_stove_uid: String::new(),
            last_stove_uid: String::new(),
            wash_target_uid: String::new(),
            wash_dirty_id: -1,
            wash_phase: String::new(),
            take_order_guest_id: None,
            ..prev
        });
        return Ok(());
    }
    ctx.db.staff_actor().insert(StaffActor {
        member_id,
        restaurant_id,
        role,
        home_floor,
        home_x, home_z,
        state: "idle".to_string(),
        state_clock_ms: 0,
        ticket_id: None,
        x: spawn_x, z: spawn_z, floor: spawn_floor,
        target_x: home_x, target_z: home_z, target_floor: home_floor,
        assigned_stove_uid: String::new(),
        last_stove_uid: String::new(),
        wash_target_uid: String::new(),
        wash_dirty_id: -1,
        wash_phase: String::new(),
        take_order_guest_id: None,
        delivery_phase: None,
        spawned_at: ctx.timestamp,
    });
    Ok(())
}

/// Comprehensive staff actor mutation. The client's StaffRouter
/// calls this whenever an actor's state-machine state, position,
/// ticket binding, or role-specific fields change — single network
/// call covers any combination. Idempotent: identical inputs
/// produce the same row.
///
/// Position fields are passed every call so the server row always
/// reflects the actor's live pose. State + ticket_id reset their
/// state_clock_ms when state changes (mirror flag changing); the
/// server tick advances the clock between mutations.
#[reducer]
pub fn update_staff_actor(
    ctx: &ReducerContext,
    member_id: String,
    state: String,
    ticket_id: Option<u64>,
    x: f32,
    z: f32,
    floor: u32,
    target_x: f32,
    target_z: f32,
    target_floor: u32,
    assigned_stove_uid: String,
    last_stove_uid: String,
    wash_target_uid: String,
    wash_dirty_id: i64,
    wash_phase: String,
    take_order_guest_id: Option<u64>,
) -> Result<(), String> {
    let a = ctx.db.staff_actor().member_id().find(member_id.clone())
        .ok_or_else(|| format!("Staff actor {member_id} not found"))?;
    let r = ctx.db.restaurant().id().find(a.restaurant_id)
        .ok_or_else(|| "Actor's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can update their staff actors".into());
    }
    // Reset the state-machine clock when the state label actually
    // flips — otherwise leave it alone so the tick's countdown
    // continues uninterrupted across a position-only update.
    let state_changed = a.state != state;
    let new_clock = if state_changed { 0 } else { a.state_clock_ms };
    // H.8 audit fix: clear delivery_phase whenever the state label
    // changes. The client doesn't know about server-side deliveries,
    // so it never sends a deliveryPhase value. Preserving it across
    // state changes via `..a` spread caused a stale "pickup" /
    // "deliver" to hijack subsequent waiter trips (wash, take-order)
    // when tick_staff_actor's arrival flip read the leftover phase.
    // Preserving across same-state updates is fine — the row's just
    // moving along its current target.
    let new_delivery_phase = if state_changed { None } else { a.delivery_phase.clone() };
    ctx.db.staff_actor().member_id().update(StaffActor {
        state,
        state_clock_ms: new_clock,
        ticket_id,
        x, z, floor,
        target_x, target_z, target_floor,
        assigned_stove_uid,
        last_stove_uid,
        wash_target_uid,
        wash_dirty_id,
        wash_phase,
        take_order_guest_id,
        delivery_phase: new_delivery_phase,
        ..a
    });
    Ok(())
}

/// Drop a staff actor's row (fired / restaurant deleted /
/// player-explicit despawn). Idempotent: missing actor is a no-op.
///
/// H.8 audit fix: if the actor was mid-delivery (delivery_phase set
/// on a waiter) OR mid-cook (assigned a ticket on a chef), reset
/// that ticket back to a state another actor can pick up before
/// dropping the row. Without this, firing a waiter mid-delivery
/// leaves the ticket stuck in "delivering" forever — H.8 auto-claim
/// only re-considers "ready" tickets, so the kitchen jams.
#[reducer]
pub fn unregister_staff_actor(ctx: &ReducerContext, member_id: String) -> Result<(), String> {
    let a = match ctx.db.staff_actor().member_id().find(member_id.clone()) {
        Some(a) => a,
        None => return Ok(()),
    };
    let r = ctx.db.restaurant().id().find(a.restaurant_id)
        .ok_or_else(|| "Actor's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can unregister their staff".into());
    }
    // Release any ticket the actor was holding so it's re-pickable.
    if let Some(tid) = a.ticket_id {
        if let Some(t) = ctx.db.active_ticket().id().find(tid) {
            // For waiters mid-delivery: roll back to "ready" so
            // auto_assign_ready_tickets picks up.
            // For chefs mid-cook: roll back to "queued" so
            // auto_claim_queued_tickets picks up — same path
            // recoverStalledTickets uses on the client.
            let rollback_state = match a.role.as_str() {
                "waiter" => "ready",
                _ => "queued",
            };
            ctx.db.active_ticket().id().update(ActiveTicket {
                state: rollback_state.to_string(),
                state_clock_ms: 0,
                assigned_chef_id: String::new(),
                ..t
            });
            log::info!(
                "unregister_staff_actor: released ticket {} → {} (was held by {} {})",
                tid, rollback_state, a.role, member_id,
            );
        }
    }
    ctx.db.staff_actor().member_id().delete(member_id);
    Ok(())
}

// =============================================================
//                        Phase F reducers
// =============================================================
// Placed furniture lifecycle. No tick logic — furniture has no
// per-frame state, so we never enter `restaurant_tick` for it.
// Three operations: place, move, sell. The client owns uid
// generation so mirror correlation is trivial.

/// Place a new furniture item into a restaurant. Re-placing the
/// same uid is treated as a "move" — useful when a save reload
/// re-inserts the row with a fresh seat / surface assignment.
#[reducer]
pub fn place_furniture(
    ctx: &ReducerContext,
    restaurant_id: u64,
    uid: String,
    def_id: String,
    x: f32,
    z: f32,
    rot_y: f32,
    floor: u32,
    parent_uid: String,
    slot_index: i32,
    local_rot_y: f32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can place furniture".into());
    }
    let row = PlacedFurniture {
        uid: uid.clone(),
        restaurant_id,
        def_id,
        x, z, rot_y, floor,
        parent_uid, slot_index, local_rot_y,
    };
    if ctx.db.placed_furniture().uid().find(uid).is_some() {
        ctx.db.placed_furniture().uid().update(row);
    } else {
        ctx.db.placed_furniture().insert(row);
    }
    Ok(())
}

/// Move (or otherwise mutate) an existing placement. Same field
/// list as place — caller passes the full row each time. Auth
/// re-checks because the client should never trust its own
/// restaurant_id cache for someone else's item.
#[reducer]
pub fn move_furniture(
    ctx: &ReducerContext,
    uid: String,
    x: f32,
    z: f32,
    rot_y: f32,
    floor: u32,
    parent_uid: String,
    slot_index: i32,
    local_rot_y: f32,
) -> Result<(), String> {
    let existing = ctx.db.placed_furniture().uid().find(uid.clone())
        .ok_or_else(|| format!("Furniture {uid} not found"))?;
    let r = ctx.db.restaurant().id().find(existing.restaurant_id)
        .ok_or_else(|| "Item's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can move their furniture".into());
    }
    ctx.db.placed_furniture().uid().update(PlacedFurniture {
        x, z, rot_y, floor,
        parent_uid, slot_index, local_rot_y,
        ..existing
    });
    Ok(())
}

/// Delete a placement. Idempotent — missing item is a no-op so
/// fast double-clicks on the sell button don't error.
#[reducer]
pub fn sell_furniture(ctx: &ReducerContext, uid: String) -> Result<(), String> {
    let existing = match ctx.db.placed_furniture().uid().find(uid.clone()) {
        Some(f) => f,
        None => return Ok(()),
    };
    let r = ctx.db.restaurant().id().find(existing.restaurant_id)
        .ok_or_else(|| "Item's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can sell their furniture".into());
    }
    ctx.db.placed_furniture().uid().delete(uid.clone());
    // Cascade — if the deleted item was a dishwasher, drop its batch
    // row too so a fresh placement of the same uid starts clean.
    if ctx.db.dishwasher_batch().furniture_uid().find(uid.clone()).is_some() {
        ctx.db.dishwasher_batch().furniture_uid().delete(uid);
    }
    Ok(())
}

// =============================================================
//                        Phase E reducers
// =============================================================
// Dishware pool + dishwasher batch mirroring. Upsert semantics
// everywhere — the local DishwareSystem owns the truth; this side
// just publishes snapshots for cross-client subscribers.

fn pool_key(restaurant_id: u64, kind: &str, tier: u32) -> String {
    format!("{}:{}:{}", restaurant_id, kind, tier)
}

/// Upsert one pool entry. Called by the local DishwareSystem mirror
/// whenever a (kind, tier) pool's clean OR dirty count changes
/// (reservation, mark-dirty, wash, buy, settle). Single reducer
/// covers all those mutations because the inputs map 1:1 to the
/// row's columns.
#[reducer]
pub fn update_dishware_pool(
    ctx: &ReducerContext,
    restaurant_id: u64,
    kind: String,
    tier: u32,
    clean: u32,
    dirty: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can update dishware pools".into());
    }
    if kind != "plate" && kind != "glass" {
        return Err(format!("Unknown dishware kind: {kind}"));
    }
    let key = pool_key(restaurant_id, &kind, tier);
    let row = DishwarePool {
        key: key.clone(),
        restaurant_id, kind, tier, clean, dirty,
    };
    // Delete empty pool rows so the table doesn't accumulate zeros.
    if clean == 0 && dirty == 0 {
        if ctx.db.dishware_pool().key().find(key.clone()).is_some() {
            ctx.db.dishware_pool().key().delete(key);
        }
        return Ok(());
    }
    if ctx.db.dishware_pool().key().find(key).is_some() {
        ctx.db.dishware_pool().key().update(row);
    } else {
        ctx.db.dishware_pool().insert(row);
    }
    Ok(())
}

/// Upsert one dishwasher's mid-cycle state. The client streams this
/// whenever it loads a piece OR the cycle clock advances by a
/// meaningful amount (~1 s throttle on the mirror side). When the
/// batch is empty (cycle finished, all pieces flushed back to the
/// pool) the row is deleted so we don't accumulate "empty
/// dishwasher" rows.
#[reducer]
pub fn update_dishwasher_batch(
    ctx: &ReducerContext,
    restaurant_id: u64,
    furniture_uid: String,
    def_id: String,
    plates: u32,
    glasses: u32,
    cycle_time_remaining_ms: i64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can update dishwashers".into());
    }
    if plates == 0 && glasses == 0 {
        if ctx.db.dishwasher_batch().furniture_uid().find(furniture_uid.clone()).is_some() {
            ctx.db.dishwasher_batch().furniture_uid().delete(furniture_uid);
        }
        return Ok(());
    }
    let row = DishwasherBatch {
        furniture_uid: furniture_uid.clone(),
        restaurant_id,
        def_id,
        plates,
        glasses,
        cycle_time_remaining_ms,
    };
    if ctx.db.dishwasher_batch().furniture_uid().find(furniture_uid).is_some() {
        ctx.db.dishwasher_batch().furniture_uid().update(row);
    } else {
        ctx.db.dishwasher_batch().insert(row);
    }
    Ok(())
}
