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
    active_guest, active_menu, active_ticket, auth_record, building, customer_archetype, dirty_pile,
    dishware_pool, dishwasher_batch, furniture_cost, furniture_inventory, furniture_meta, hired_staff_member, ingredient_cost, layout_preset, pantry_stock,
    pantry_target, placed_furniture, player, player_save, prepared_serving,
    recipe_ingredients, recipe_level, recipe_meta,
    recipe_upgrade_in_flight, restaurant, restaurant_tick_schedule,
    restaurant_tick_state, seat_slot, seat_appeal, staff_actor, staff_stat, weather_state, money_cutover, money_event,
    ActiveGuest, ActiveMenu, ActiveTicket, CustomerArchetypeDef, DirtyPile, DishwarePool, FurnitureCost, FurnitureInventory, FurnitureMeta, LayoutPreset,
    DishwasherBatch, HiredStaffMember, IngredientCost, PantryStock, PantryTarget,
    PlacedFurniture, PreparedServing, RecipeIngredients, RecipeLevel, RecipeMeta,
    RecipeUpgradeInFlight, Restaurant, RestaurantTickSchedule, RestaurantTickState,
    SeatSlot, SeatAppeal, StaffActor, StaffStat, MoneyCutover, MoneyEvent,
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

/// Energy audit — re-install every restaurant's tick schedule with
/// the CURRENT SIM_TICK_INTERVAL_MICROS.  Existing schedule rows
/// bake the interval at insert time; changing the constant doesn't
/// re-apply to live rows.  Call once after publishing a new
/// SIM_TICK_INTERVAL_MICROS to actually take effect on all
/// restaurants:
///
///     spacetime call cozy-bistro-andre reset_sim_schedules
///
/// Deletes every existing restaurant_tick_schedule + restaurant_tick_state
/// row, then re-installs each schedule at the new interval.  Safe
/// because: (1) tick_state is just diagnostic bookkeeping, (2) the
/// dropped schedule's pending fire (if any) is replaced by the new
/// row's first fire (one interval later), (3) all server-tracked
/// state lives in active_guest / active_ticket / etc., not in the
/// schedule rows.
#[reducer]
pub fn reset_sim_schedules(ctx: &ReducerContext) -> Result<(), String> {
    // Admin-only: this wipes EVERY restaurant's tick schedules + state.
    // Without the gate any client could call it to stall the whole
    // server's simulation (cross-player DoS).
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Admin only".into());
    }
    let schedule_ids: Vec<u64> = ctx.db.restaurant_tick_schedule().iter()
        .map(|s| s.id)
        .collect();
    for id in schedule_ids {
        ctx.db.restaurant_tick_schedule().id().delete(id);
    }
    let state_rids: Vec<u64> = ctx.db.restaurant_tick_state().iter()
        .map(|s| s.restaurant_id)
        .collect();
    for rid in state_rids {
        ctx.db.restaurant_tick_state().restaurant_id().delete(rid);
    }
    // Now reinstall at the current interval.
    let rids: Vec<u64> = ctx.db.restaurant().iter().map(|r| r.id).collect();
    let count = rids.len();
    for rid in rids {
        ensure_tick_schedule(ctx, rid);
    }
    log::info!(
        "reset_sim_schedules: re-installed {} schedules at {}µs interval",
        count, SIM_TICK_INTERVAL_MICROS,
    );
    Ok(())
}

// === Phase B state-machine constants ===

/// Initial patience pool, in milliseconds. Mirrors the client's
/// ORDER_PATIENCE_BASE_SECONDS — the window a guest waits for a
/// waiter to start taking their order. Multiplied by the spawned
/// patience_mult_x100 (×100 to stay integer; e.g. 150 = 1.5× = 90 s).
const ORDER_PATIENCE_BASE_MS: i64 = 60_000; // 60 s
/// Refreshed patience pool used from waiter-takes-order onward
/// (waitingForFood + eating). Mirrors the client's
/// SERVE_PATIENCE_BASE_SECONDS. The server bumps patience_ms to this
/// (× the multiplier) on the ordering → waitingForFood transition AND
/// at each course boundary (eating → seated), matching the client.
const SERVE_PATIENCE_BASE_MS: i64 = 90_000; // 90 s
/// Compute the scaled patience pool from a base value and a guest's
/// stored multiplier (×100). 150 means 1.5×, so 60000 × 150 / 100 =
/// 90000 ms. Clamped to a sane floor so a wildly low multiplier
/// can't produce a 0-patience guest who times out on tick 1.
fn scale_patience(base_ms: i64, mult_x100: i32) -> i64 {
    let mult = mult_x100.max(10) as i64; // ≥0.1× floor
    (base_ms.saturating_mul(mult) / 100).max(5_000)
}

/// Dwell time in the "leaving" state before the row is deleted.
/// Lets the client play the walk-out animation before the model
/// vanishes. Client's despawnGuest matches this cadence.
const LEAVING_DWELL_MS: i64 = 4_000; // 4 s

/// H.18 — Safety-net dwell for the client's three "leaving variant"
/// states (`walkingToDoor`, `exitingDoor`, `walkingOut`). The client
/// uses these instead of the bare "leaving" string for the
/// rendered walk-out — and once the client writes one of those
/// strings via update_guest_position, the server's normal
/// LEAVING_DWELL_MS branch can't fire (it gates on
/// state=="leaving"||"done"). Without this, the server's earlier
/// `eating → leaving` transition for a backgrounded tab gets
/// silently overwritten when the foreground tab resumes and starts
/// pushing position mirrors with the variant string, the despawn
/// dwell never elapses on the cloud row, and the guest holds their
/// seat forever from the cloud's perspective.
///
/// 30 s matches the client-side `stuckLeaving` watchdog in
/// GuestSpawner.ts so a guest the client would have force-despawned
/// also gets dropped server-side. Longer than LEAVING_DWELL_MS
/// because these are mid-walk states (client is animating); the
/// server only despawns if the client is taking abnormally long.
const LEAVING_VARIANT_DWELL_MS: i64 = 30_000; // 30 s

/// True if this state name represents the client's "in the process
/// of leaving" set. The server treats these the same as bare
/// "leaving" for despawn purposes — see H.18.
fn is_leaving_state(s: &str) -> bool {
    matches!(s, "leaving" | "done" | "walkingToDoor" | "exitingDoor" | "walkingOut")
}

/// True if this state name represents an "overflow waiting" guest —
/// parked on a yellow waiting chair because no real seat was free
/// at spawn. The plan doc lists "waiting" but the client actually
/// writes "waitingForSeat"; we accept both so H.5's timeout-leave
/// branch (which gated only on "waiting") fires correctly on the
/// mirror state the client produces. See H.19.
fn is_waiting_state(s: &str) -> bool {
    matches!(s, "waiting" | "waitingForSeat")
}

/// True for guest states the server's state machine actually models and
/// drives. Used to REJECT client-mirrored LOCAL-only render states
/// (returningFromToilet, walkingToToilet, atToilet, walkingToSink, atSink,
/// walkingToWait) in update_guest_position — adopting one would strand the
/// row in a state tick_guest_state can't advance, and the unknown-state
/// watchdog would then force-leave the guest (e.g. a seated guest despawned
/// mid-meal seconds after a cross-floor wash). Also drives that watchdog so
/// the accept-list and the leave-list stay in lockstep.
fn server_models_guest_state(s: &str) -> bool {
    matches!(s,
        "walkingIn" | "seated" | "ordering" | "waitingForFood"
        | "eating" | "wcWalking" | "wcSitting" | "wcWashing")
        || is_waiting_state(s)
        || is_leaving_state(s)
}

/// Phase 6.2 — server-side weather tip multiplier, in x100 units.
/// Mirrors the WEATHER_KINDS catalog in src/game/WeatherSystem.ts
/// (sunny / cloudy = 1.0×, festival = 1.25×, etc.). Used by
/// accumulate_pending_visit_rollup so backgrounded-tab tips track the
/// same +25% festival or +20% cold-snap bump the foreground client
/// applies via this.game.weather.getCurrent().tipMultiplier. Unknown
/// kinds default to 1.0× — same fallback as the client's lookup.
///
/// Keep these constants in lockstep with WeatherSystem.ts. The
/// numbers are intentionally small (1.0 → 1.25) so a drift between
/// the two only shows up as a few percent in tip totals.
fn weather_tip_mult_x100(kind: &str) -> i64 {
    match kind {
        "sunny" | "cloudy" | "rainy" => 100,
        "heavy-rain" => 110,
        "festival" => 125,
        "cold" => 120,
        "snowy" => 115,
        _ => 100,
    }
}

/// Phase 6.5 — server-side weather spawn-rate multiplier, in x100
/// units. Mirrors WEATHER_KINDS[*].spawnRateMultiplier exactly. The
/// FOREGROUND client multiplies its spawn INTERVAL by this value —
/// higher = longer cooldown = SLOWER spawns. Rainy / snowy weather
/// pulls the rate down (people stay home); festival speeds it up.
/// Used by try_server_spawn_guest so offline simulation tracks the
/// same weather effect — without this, a player who closes their tab
/// during a festival window misses the spawn bump.
///
/// Mapping straight from src/game/WeatherSystem.ts WEATHER_KINDS.
/// Unknown kinds default to 1.0× (no weather effect).
fn weather_spawn_mult_x100(kind: &str) -> i64 {
    match kind {
        "sunny" | "cloudy" => 100,
        "rainy" => 180,
        "heavy-rain" => 260,
        "festival" => 65,
        "cold" => 140,
        "snowy" => 190,
        _ => 100,
    }
}

/// Interval the simulation ticks at, in microseconds. 100 ms = 10 Hz —
/// matches the rate planned in docs/server-authoritative-plan.md.
/// Pedestrians fire at 0.5 Hz; the live game sim needs finer
/// resolution so patience countdowns + cook timers feel right.
///
/// Energy audit (post-H.53) — original 100ms (10 Hz) was driving the
/// bulk of Maincloud energy burn since each tick triggers ~20 full
/// table scans across guests/tickets/staff_actor/furniture/etc. for
/// just one restaurant's worth of work.  Dropped to 500ms (2 Hz):
/// patience timers still feel responsive, cook timers tick on 500ms
/// granularity (under the per-recipe ~5s scale, fine), and per-tick
/// cost drops ~5×.  Sub-second client smoothing is the visual
/// interpolator's job — server doesn't need to push positions more
/// often than the network round-trip anyway.
pub const SIM_TICK_INTERVAL_MICROS: i64 = 500_000; // 500ms (2 Hz)

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
    // Scheduler-only: a scheduled reducer is still a public RPC. The
    // scheduler invokes it with sender == the module's own identity, so
    // reject any other sender — otherwise a modded client could call it to
    // fast-forward its own (or grief another player's) simulation.
    if ctx.sender != ctx.identity() {
        return Err("restaurant_tick is scheduler-only".into());
    }
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
    // Energy audit — use btree-index access (active_guest has
    // #[index(btree)] on restaurant_id) instead of iter().filter()
    // which is a full table scan.  Same change applied to every
    // per-restaurant iteration below.
    let guest_ids: Vec<u64> = ctx.db
        .active_guest()
        .restaurant_id().filter(rid)
        .map(|g| g.id)
        .collect();
    let has_guests = !guest_ids.is_empty();
    // Closed-restaurant guest eject (inside tick_guest_state) needs the open
    // flag. The toggle lives on the owner's player_save, eagerly mirrored to
    // the server on every change; default to open if the save isn't loaded.
    let restaurant_open = ctx.db.restaurant().id().find(rid)
        .and_then(|r| ctx.db.player_save().identity().find(r.owner))
        .map(|s| s.restaurant_open)
        .unwrap_or(true);
    for guest_id in guest_ids {
        tick_guest_state(ctx, guest_id, dt_ms, restaurant_open);
    }

    // Phase C.1 — same pattern for tickets. Iterate this restaurant's
    // active_ticket rows + step each one's state-clock + cook timer.
    let ticket_ids: Vec<u64> = ctx.db
        .active_ticket()
        .restaurant_id().filter(rid)
        .map(|t| t.id)
        .collect();
    let has_tickets = !ticket_ids.is_empty();
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
        .restaurant_id().filter(rid)
        .map(|a| a.member_id.clone())
        .collect();
    let has_actors = !actor_ids.is_empty();
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
        .restaurant_id().filter(rid)
        .map(|b| b.furniture_uid.clone())
        .collect();
    let has_batches = !batch_uids.is_empty();
    for uid in batch_uids {
        tick_dishwasher_batch(ctx, &uid, rid, dt_ms);
    }

    // Phase 9.45 — the Phase 9.23 dirty-pile REAPER was removed here.
    // It capped piles at 24 and deleted the oldest over the cap, which
    // under strict cleaning would act as a silent auto-clean: seats
    // freed without a waiter ever bussing them. The owner chose pure
    // strict ("no auto-clean fallback"), and the reaper is unnecessary
    // for safety — piles are now naturally bounded. A seat with piles
    // is unservable (try_assign_seat_for skips it), so it can't be
    // re-dirtied while it waits; per-seat piles cap at one guest's
    // course count, total at seats × courses. Only a waiter seat-clean
    // trip (tick_seat_clean) deletes pile rows.

    // Phase I (H.71) — continuous server-side guest spawning while
    // the owner is OFFLINE.  Closes the user-reported "I log in,
    // nothing changes" gap: previously NEW guests only materialized
    // server-side when a pedestrian happened to walk to the door
    // (try_arrival_handoff in pedestrians.rs).  For a restaurant
    // with low rating or far from a busy avenue, that meant near-
    // zero offline accrual.  Now the server fires one own guest
    // every SERVER_SPAWN_INTERVAL_MICROS as long as the restaurant
    // is open + has free seats + below the cap, matching what the
    // client's GuestSpawner would do at the same cadence.
    //
    // Gated on owner-offline (30 s last_seen_at window) so we don't
    // double-spawn with the live client — the foreground tab's
    // GuestSpawner already runs at 5.5 s intervals, and there's no
    // value in adding a parallel server path that races it.
    try_server_spawn_guest(ctx, rid, now);
    // Phase 9.6 — seat the longest-waiting guest when a chair frees.
    try_promote_waiting_guest(ctx, rid);

    // Energy audit (C) — early-out: if this restaurant has NOTHING
    // going on (no guests, no tickets, no actors, no dishwasher
    // batches, no in-flight recipe upgrades, no in-flight staff
    // training), skip every heavy dispatch helper.  Just bump the
    // day clock so visual time still advances + return.  Day-clock
    // tick is cheap (one find + maybe one update); the dispatch
    // helpers below each iterate at least one table per call.
    //
    // The "any in-flight" probe is also cheap: btree-indexed
    // restaurant_id lookups, take() short-circuits at the first row.
    if !has_guests && !has_tickets && !has_actors && !has_batches {
        let any_upgrade = ctx.db.recipe_upgrade_in_flight()
            .restaurant_id().filter(rid).next().is_some();
        let any_training = ctx.db.hired_staff_member()
            .restaurant_id().filter(rid)
            .any(|m| m.training_completes_at_micros > 0);
        if !any_upgrade && !any_training {
            tick_day_clock(ctx, rid, dt_ms);
            return Ok(());
        }
    }

    // Phase H.6 — auto-claim queued tickets. Iterates queued tickets
    // in this restaurant and assigns each to an idle chef + free
    // stove. Means the kitchen keeps progressing when the host's tab
    // is backgrounded (the local sim throttles to 1Hz or worse in
    // background; without server auto-claim the queued tickets pile
    // up indefinitely).
    auto_claim_queued_tickets(ctx, rid);

    // Phase H.21 — opportunistic dishwasher loading. Best-effort path
    // that survives backgrounded tabs by moving one dirty piece into a
    // free dishwasher's batch per tick. Yields to a foreground client
    // (via the stale-wash-target heuristic inside) so the typical
    // tab-is-open case doesn't fight the local sim's actual wash
    // trips. See try_server_wash_load for the gating rules.
    try_server_wash_load(ctx, rid);

    // Phase 9.40 — Take-orders are dispatched BEFORE deliveries, capped
    // to ~half the idle waiters when BOTH an order backlog and a delivery
    // backlog exist, so the two SHARE the waiter pool. Previously delivery
    // ran first and greedily consumed every idle waiter, so a kitchen with
    // a delivery backlog left NO waiter free to take a new order: ordering
    // guests starved out, the funnel stalled, few new tickets reached the
    // kitchen, and only the one fastest chef stayed busy while the rest
    // idled. ("waiter sitting idle while customers need orders" + "one chef
    // takes all the work" were the same stall.)
    let idle_waiter_count = ctx.db.staff_actor().restaurant_id().filter(rid)
        .filter(|a| a.role == "waiter" && a.state == "idle"
            && a.ticket_id.is_none() && a.take_order_guest_id.is_none()
            && a.wash_target_uid.is_empty())
        .count();
    let ready_count = ctx.db.active_ticket().restaurant_id().filter(rid)
        .filter(|t| t.state == "ready").count();
    let ordering_count = ctx.db.active_guest().restaurant_id().filter(rid)
        .filter(|g| g.state == "ordering" && !g.seat_at_bar).count();
    // Phase 9.44 — BACKLOG-WEIGHTED split. The 9.40 cap was ceil-half:
    // with waiters freeing up one at a time (the normal busy case),
    // ceil(1/2)=1 sent EVERY freed waiter to take-orders, so delivery
    // never got one — cooked plates piled up undelivered forever and
    // every customer left before eating (100% 1★). Now take-orders get a
    // share of the idle pool PROPORTIONAL to the order backlog vs the
    // combined backlog, so a single freed waiter goes to whichever side
    // is actually deeper, and both sides drain together.
    let order_cap = if ready_count == 0 {
        usize::MAX // no food waiting → take orders freely
    } else if ordering_count == 0 {
        0 // no one waiting to order → all idle waiters deliver
    } else {
        let total = ordering_count + ready_count;
        (idle_waiter_count * ordering_count + total / 2) / total // round
    };

    // Phase H.34 — take-order dispatch. Walks idle waiters to
    // seated/ordering guests who don't yet have a waiter en route.
    try_dispatch_take_order(ctx, rid, order_cap);

    // Phase H.8 — auto-assign ready tickets to idle waiters (delivery).
    // Runs AFTER take-orders now, so it gets the waiters they left.
    // Without it, cooked plates would sit at the pickup spot forever in a
    // backgrounded tab; the two-leg trip (pickup → seat) is encoded in
    // delivery_phase, which tick_staff_actor reads on arrival.
    auto_assign_ready_tickets(ctx, rid);

    // Phase 9.45 — STRICT seat cleaning. Runs AFTER take-order +
    // ready-delivery dispatch (those claim the waiters they need
    // first), so only leftover-idle waiters get pulled into bussing
    // dirty tables. This is the sole path that frees a dirtied seat —
    // there is no auto-clean — so a seat stays unservable until a
    // waiter buses it here.
    try_dispatch_seat_clean(ctx, rid);

    // Phase H.35 — wash trip dispatch. Cosmetic for the offline case:
    // walks an idle waiter through a pseudo-pickup (any table) → wash
    // station (sink or dishwasher) → home cycle when dirty stock + an
    // available waiter both exist. Doesn't touch dishware_pool itself
    // (H.21's instantaneous loader still owns inventory motion); the
    // benefit is a reconnecting player sees waiters in motion rather
    // than idle staff next to magically-clean dishes. Same offline
    // guard pattern as H.33/H.34.
    try_dispatch_wash_trip(ctx, rid);

    // Phase 9.42 — Observability. Scan post-dispatch state for anomalies
    // and publish a compact summary the client renders as a health badge.
    scan_restaurant_health(ctx, rid);

    // Phase H Phase 5.2 — errand-helper auto-shop dispatch. Owner-
    // offline gated initially (Phase 5.4 drops the gate). Detects
    // shortage in pantry_stock, picks list, charges
    // cloud_money_cents, dispatches an idle helper through the 9-
    // phase tick_errand_actor walkthrough. The 5.1+ local mirror
    // would normally fight us if the foreground client were running,
    // but the offline gate ensures we only fire when the client is
    // away.
    try_dispatch_errand_trip(ctx, rid);

    // Phase H.30 — advance the visual day clock. The foreground client
    // periodically yokes the cloud's day_elapsed_ms to its local value
    // via sync_day_clock; backgrounded play lets pending_days_advanced
    // accumulate until the next consume_pending_day_advancement on
    // reconnect. Tick is idempotent on a row that was just synced —
    // the elapsed counter just walks forward from wherever the
    // client left it.
    tick_day_clock(ctx, rid, dt_ms);

    // Phase H.43 — scan recipe_upgrade_in_flight rows for this
    // restaurant; any whose completes_at has passed get popped onto
    // pending_recipe_upgrades_completed_csv for the client to apply
    // on reconnect.  Cheap (small N — typically 0 or 1 upgrade in
    // flight per restaurant at any time).
    tick_recipe_upgrade_completions(ctx, rid);

    // Phase H.44 — scan hired_staff_member rows for this restaurant;
    // any whose training_completes_at has passed get bumped a level
    // and appended to pending_training_completions_csv.  Server is
    // the authoritative source for the level once the deadline hits.
    tick_training_completions(ctx, rid);

    // Phase H.45 — offline-only salary accrual.  Gated on the owner
    // being offline (matches H.33/H.34/H.35) so foreground play
    // continues to drive its own tickSalary; backgrounded restaurants
    // bill the offline period to pending_salary_cost_cents which the
    // client drains on reconnect.
    tick_offline_salary(ctx, rid);

    Ok(())
}

/// Phase H.30 — Advance the visual day clock for this restaurant.
/// Pops as many full days as have elapsed into pending_days_advanced
/// so a multi-hour backgrounded session correctly accrues a stack of
/// rollovers when the client reconnects.
///
/// Phase 7.4 — Also debits rent from cloud_money_cents for each day
/// that rolls over while the owner is OFFLINE. Mirrors
/// Game.rolloverDay's `if (dayNumber > RENT_GRACE_DAYS) forceSpend`
/// branch so cloud cash matches what the foreground would have paid.
/// On reconnect the client's applyPendingDayAdvancement skips the
/// rent debit (chargeRent=false) since the server already paid it,
/// avoiding the cash-jolt-down on reload.
fn tick_day_clock(ctx: &ReducerContext, rid: u64, dt_ms: i64) {
    /// Daily rent in cents per luxury tier. Mirrors RENT_BY_TIER in
    /// src/game/Game.ts (×100 to keep integer math here).
    const RENT_BY_TIER_CENTS: [i64; 6] = [0, 4_000, 8_000, 16_000, 32_000, 64_000];
    /// Mirrors GRACE_DAYS in Game.ts — days 1..GRACE are free (no rent).
    /// Wages are client-only, so the server just needs the rent grace here.
    const RENT_GRACE_DAYS: u32 = 14;
    /// Owner-offline window. Mirrors the 30s pingPresence threshold.
    const OFFLINE_THRESHOLD_MICROS: i64 = 30_000_000;

    let Some(r) = ctx.db.restaurant().id().find(rid) else { return; };
    let mut elapsed = r.day_elapsed_ms.saturating_add(dt_ms);
    let mut pending = r.pending_days_advanced;
    let mut rent_to_charge_cents: i64 = 0;
    // We need the player's current day + tier to know whether rent
    // applies and how much. Owner-online check gates the rent debit;
    // foreground client handles its own rolloverDay rent path online.
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let owner_online = ctx.db.player().identity().find(r.owner)
        .map(|pl| (now_micros - pl.last_seen_at.to_micros_since_unix_epoch()) < OFFLINE_THRESHOLD_MICROS)
        .unwrap_or(false);
    let save = ctx.db.player_save().identity().find(r.owner);
    let base_day_number = save.as_ref().map(|s| s.day_number).unwrap_or(1);
    // Rent pauses while the restaurant is CLOSED (player toggle, mirrored to
    // player_save.restaurant_open + eagerly pushed on change).
    let restaurant_open = save.as_ref().map(|s| s.restaurant_open).unwrap_or(true);
    let luxury_tier = save.as_ref().map(|s| s.luxury_tier as usize).unwrap_or(1).min(5).max(1);
    let rent_per_day_cents = RENT_BY_TIER_CENTS.get(luxury_tier).copied().unwrap_or(0);

    let mut day_rolled = false;
    // Path B (server-written day history) — the server is the sole
    // writer of cloud_day_history_json now. Pre-this, the CLIENT
    // pushed a record at each foreground rollover, so days that
    // rolled while the owner was offline had no record at all and
    // the Daily Trends modal showed zeros for them. Each loop
    // iteration below appends one record for the day that just
    // ended, capped to the client's 60-entry ring buffer.
    //
    // Lazily materialized — Some(new blob) only when ≥1 day rolls
    // this tick, so the 2 Hz no-roll path never clones the JSON.
    let mut history_json: Option<String> = None;
    let mut days_rolled: u32 = 0;
    while elapsed >= DAY_LENGTH_MS {
        elapsed -= DAY_LENGTH_MS;
        pending = pending.saturating_add(1);
        day_rolled = true;
        days_rolled = days_rolled.saturating_add(1);
        // The day that JUST ENDED is base_day_number + (pending - 1).
        // base_day_number is the day the client last persisted; each
        // pending bump represents another day completed since then.
        let ended_day = base_day_number.saturating_add(pending).saturating_sub(1);
        // Charge rent IFF offline AND day > GRACE.
        if !owner_online && ended_day > RENT_GRACE_DAYS && restaurant_open {
            rent_to_charge_cents = rent_to_charge_cents.saturating_add(rent_per_day_cents);
        }
        // Path B — append this day's history record just BEFORE the
        // daily counters reset below. Only the FIRST rolled day in a
        // multi-day drain carries the live cloud_daily_* totals; any
        // further pending days roll with zeroed counters — correct,
        // because the totals reset at each rollover, so nothing
        // accrued for those intermediate days.
        let (rev_cents, exp_cents, srv, lst) = if days_rolled == 1 {
            (
                r.cloud_daily_revenue_cents,
                r.cloud_daily_expenses_cents,
                r.cloud_daily_served,
                r.cloud_daily_lost,
            )
        } else {
            (0i64, 0i64, 0u32, 0u32)
        };
        let record = build_day_record_json(ctx, &r, ended_day, rev_cents, exp_cents, srv, lst);
        let next = match history_json.as_deref() {
            Some(s) => append_day_history_record(s, &record),
            None => append_day_history_record(
                r.cloud_day_history_json.as_deref().unwrap_or(""),
                &record,
            ),
        };
        history_json = Some(next);
    }
    if elapsed == r.day_elapsed_ms
        && pending == r.pending_days_advanced
        && rent_to_charge_cents == 0
    {
        return; // no change worth a write
    }
    // Phase 7.6 — Reset the daily-totals mirrors when the server
    // detects a day rollover so today's numbers don't accumulate
    // forever (and so visitors / leaderboard see "today" reset at
    // midnight). Foreground client zeros them locally + pushes via
    // syncCloudDailyTotals, but only when ONLINE — offline rollovers
    // would otherwise keep adding to yesterday's totals indefinitely.
    // Reset daily counters when a day rolls over. Rent that fires for
    // THIS rollover gets attributed to the next day's expenses (we're
    // resetting at the moment of rollover, so the rent debit goes to
    // the freshly-started day rather than being lost) — close enough
    // for visit-mode parity. The cleaner attribution would need per-
    // rollover tracking inside the loop above.
    let (new_daily_rev, new_daily_exp, new_daily_served, new_daily_lost) = if day_rolled {
        (0i64, rent_to_charge_cents, 0u32, 0u32)
    } else {
        (
            r.cloud_daily_revenue_cents,
            r.cloud_daily_expenses_cents,
            r.cloud_daily_served,
            r.cloud_daily_lost,
        )
    };
    // Phase 9.54 — today's tips reset to 0 on rollover, like the others.
    let new_daily_tips: i64 = if day_rolled { 0 } else { r.cloud_daily_tips_cents };
    // Path B — the history blob only changes when a day rolled; the
    // no-roll path moves the existing value through `..r` untouched
    // (no clone in the every-tick write).
    let rent_old_balance = r.cloud_money_cents;
    let rent_new_balance = r.cloud_money_cents.saturating_sub(rent_to_charge_cents).max(0);
    let mut updated = Restaurant {
        day_elapsed_ms: elapsed,
        pending_days_advanced: pending,
        cloud_money_cents: rent_new_balance,
        cloud_daily_revenue_cents: new_daily_rev,
        cloud_daily_expenses_cents: new_daily_exp,
        cloud_daily_served: new_daily_served,
        cloud_daily_lost: new_daily_lost,
        cloud_daily_tips_cents: new_daily_tips,
        // Starter grant resets every GAME day (not real day): clearing the
        // last-claim stamp on rollover makes the $500 low-balance grant
        // claimable again next day (claim_low_balance_grant's cooldown
        // check treats 0 as "never claimed").
        last_low_balance_grant_micros: if day_rolled { 0 } else { r.last_low_balance_grant_micros },
        ..r
    };
    if let Some(json) = history_json {
        updated.cloud_day_history_json = Some(json);
    }
    ctx.db.restaurant().id().update(updated);
    // Ledger — the offline rent debit as its own line (no-op when 0).
    record_money_event(ctx, rid, "rent", rent_new_balance - rent_old_balance, rent_new_balance);
    if day_rolled {
        log::info!(
            "tick_day_clock: rid {} appended {} day-history record(s) (last ended day {})",
            rid, days_rolled,
            base_day_number.saturating_add(pending).saturating_sub(1),
        );
    }
    if rent_to_charge_cents > 0 {
        log::info!(
            "tick_day_clock: rid {} debited {} cents offline rent ({} pending days)",
            rid, rent_to_charge_cents, pending,
        );
    }
}

// === Path B — server-written day history helpers =====================
//
// The client's DayHistory ring buffer (src/game/DayHistory.ts) is a
// JSON array of DayRecord objects pushed once per rollover. The
// server now appends those records itself in tick_day_clock so days
// that roll while the owner is offline still show real numbers in
// the Daily Trends modal. Everything below exists to write records
// that are byte-identical to what the client's JSON.stringify
// produced, without pulling a JSON crate into the wasm build.

/// One Daily-Trends record, serialized to MATCH the client's
/// DayRecord shape exactly — field names, field order and JS number
/// formatting (see DayHistory.DayRecord + the history.push call in
/// Game.rolloverDay):
///   {"dayNumber":12,"served":34,"lost":2,"revenue":210.5,
///    "expenses":80,"net":130.5,"rating":4.25,
///    "weatherEmoji":"☀️","weatherLabel":"Sunny"}
/// Money fields are dollars (the cloud columns store cents); rating
/// is the average of the most recent ~20 entries of
/// cloud_rating_history_csv (3.0 when unrated, matching the client's
/// getAverageRating default); weather comes from the global
/// weather_state row id=1.
fn build_day_record_json(
    ctx: &ReducerContext,
    r: &Restaurant,
    ended_day: u32,
    revenue_cents: i64,
    expenses_cents: i64,
    served: u32,
    lost: u32,
) -> String {
    let kind = ctx.db.weather_state().id().find(1u32).map(|w| w.kind);
    let (emoji, label) = weather_emoji_label(kind.as_deref().unwrap_or(""));
    let rating = day_history_rating(r.cloud_rating_history_csv.as_deref().unwrap_or(""));
    let revenue = revenue_cents as f64 / 100.0;
    let expenses = expenses_cents as f64 / 100.0;
    let net = (revenue_cents.saturating_sub(expenses_cents)) as f64 / 100.0;
    format!(
        "{{\"dayNumber\":{},\"served\":{},\"lost\":{},\"revenue\":{},\"expenses\":{},\"net\":{},\"rating\":{},\"weatherEmoji\":\"{}\",\"weatherLabel\":\"{}\"}}",
        ended_day,
        served,
        lost,
        fmt_js_number(revenue),
        fmt_js_number(expenses),
        fmt_js_number(net),
        fmt_js_number(rating),
        emoji,
        label,
    )
}

/// Weather kind → the (emoji, label) pair the client's WEATHER_TYPES
/// table pairs with it (src/game/WeatherSystem.ts — keep in sync).
/// Unknown / missing kinds fall back to sunny, matching the client's
/// WEATHER_TYPES[0] fallback.
fn weather_emoji_label(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "cloudy" => ("⛅", "Cloudy"),
        "rainy" => ("🌧️", "Rainy"),
        "heavy-rain" => ("⛈️", "Heavy Rain"),
        "festival" => ("🎉", "Festival Day"),
        "cold" => ("🥶", "Cold Snap"),
        "snowy" => ("❄️", "Snowy"),
        _ => ("☀️", "Sunny"),
    }
}

/// Rating stored with a day record — the average of the last 20
/// entries of cloud_rating_history_csv (1-5 ints), or 3.0 when the
/// restaurant has no ratings yet (the client's getAverageRating
/// unrated default).
fn day_history_rating(csv: &str) -> f64 {
    let vals: Vec<i64> = csv
        .split(',')
        .filter_map(|s| s.trim().parse::<i64>().ok())
        .filter(|n| (1..=5).contains(n))
        .collect();
    if vals.is_empty() {
        return 3.0;
    }
    let recent = &vals[vals.len().saturating_sub(20)..];
    let sum: i64 = recent.iter().sum();
    sum as f64 / recent.len() as f64
}

/// JS-style JSON number formatting at 2-decimal precision:
/// JSON.stringify(80) === "80", JSON.stringify(130.5) === "130.5",
/// JSON.stringify(4.25) === "4.25". Trailing zeros (and a bare
/// trailing dot) are trimmed so a server-written value is
/// byte-identical to what the client's JSON.stringify produced for
/// the same number.
fn fmt_js_number(v: f64) -> String {
    if !v.is_finite() {
        return "0".to_string();
    }
    let s = format!("{:.2}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" || s == "-0" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

/// Append one record to the JSON-array blob, dropping the OLDEST
/// records to keep at most 60 entries (DayHistory.MAX_DAYS on the
/// client) and the whole blob under the 16 KB budget the
/// set_cloud_day_history reducer enforces. `current` may be empty,
/// "[]", or a legacy client-written array — existing records pass
/// through byte-identical (sliced, never re-serialized), so nothing
/// the client wrote pre-cutover gets perturbed.
fn append_day_history_record(current: &str, record: &str) -> String {
    const MAX_DAYS: usize = 60; // = DayHistory.MAX_DAYS
    const MAX_BYTES: usize = 16_000; // mirrors setCloudDayHistory's guard
    let trimmed = current.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or("");
    let mut items = split_top_level_json_items(inner);
    items.push(record);
    let mut start = items.len().saturating_sub(MAX_DAYS);
    // Size guard — keep dropping oldest while the serialized form
    // would overflow the column budget. With ~150-byte records and a
    // 60-entry cap this never fires in practice; it only defends
    // against oversized legacy blobs.
    while start + 1 < items.len() {
        let total: usize = items[start..].iter().map(|s| s.len() + 1).sum::<usize>() + 1;
        if total <= MAX_BYTES {
            break;
        }
        start += 1;
    }
    let kept = &items[start..];
    let mut out = String::with_capacity(kept.iter().map(|s| s.len() + 1).sum::<usize>() + 2);
    out.push('[');
    for (i, it) in kept.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(it);
    }
    out.push(']');
    out
}

/// Split a JSON array's INNER text into its top-level elements.
/// Depth + string-literal aware scanner (handles escapes), so a
/// record field containing "}," can't break the split — without
/// needing a full JSON parser in the wasm module. Operates on bytes;
/// multi-byte UTF-8 sequences (the weather emoji) never collide with
/// the ASCII delimiters being matched, and splits only happen at
/// ASCII commas, so slicing stays on char boundaries.
fn split_top_level_json_items(inner: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let bytes = inner.as_bytes();
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut escaped = false;
    let mut start = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            b',' if depth == 0 => {
                let item = inner[start..i].trim();
                if !item.is_empty() {
                    items.push(item);
                }
                start = i + 1;
            }
            _ => {}
        }
    }
    let last = inner[start..].trim();
    if !last.is_empty() {
        items.push(last);
    }
    items
}

/// Anti-cheat B/C — read the global money-cutover switch (single row,
/// id = 1). Defaults false (no row) so the cutover stays OFF until an
/// admin flips it via set_money_cutover_active.
fn money_cutover_active(ctx: &ReducerContext) -> bool {
    ctx.db.money_cutover().id().find(1u32).map(|m| m.active).unwrap_or(false)
}

/// Server ledger — append one itemized money event, then keep the table
/// bounded. Called by EVERY server write to a restaurant's
/// cloud_money_cents so the client can render a per-line ledger (Staff
/// wages / Rent / Meal sale / Ingredient restock / …) instead of the
/// opaque net-delta lump the money cutover otherwise leaves it with.
/// `amount_cents` is SIGNED (negative = a cost); `balance_after_cents` is
/// cloud_money_cents AFTER the write. No-op on a zero amount.
pub(crate) fn record_money_event(
    ctx: &ReducerContext,
    restaurant_id: u64,
    kind: &str,
    amount_cents: i64,
    balance_after_cents: i64,
) {
    if amount_cents == 0 {
        return;
    }
    ctx.db.money_event().insert(MoneyEvent {
        id: 0, // auto_inc
        restaurant_id,
        at_micros: ctx.timestamp.to_micros_since_unix_epoch(),
        kind: kind.to_string(),
        amount_cents,
        balance_after_cents,
    });
    prune_money_events(ctx, restaurant_id);
}

/// Keep a restaurant's ledger to the newest LEDGER_KEEP rows. Scans only
/// the one restaurant's events (btree index), so it's bounded by the cap.
fn prune_money_events(ctx: &ReducerContext, restaurant_id: u64) {
    const LEDGER_KEEP: usize = 200;
    let mut rows: Vec<(u64, i64)> = ctx
        .db
        .money_event()
        .restaurant_id()
        .filter(restaurant_id)
        .map(|e| (e.id, e.at_micros))
        .collect();
    if rows.len() <= LEDGER_KEEP {
        return;
    }
    // Oldest first (timestamp, then id), delete the excess.
    rows.sort_by_key(|(id, at)| (*at, *id));
    let excess = rows.len() - LEDGER_KEEP;
    for (id, _) in rows.into_iter().take(excess) {
        ctx.db.money_event().id().delete(id);
    }
}

/// Anti-cheat B/C — flip the global money-cutover switch. Admin-only
/// (Dunnin). When active, bump_cloud_money rejects positive deltas and
/// set_cloud_money is locked. Instant + reversible (no re-publish) so a
/// live cutover can be rolled back. Flip via the CLI:
///   spacetime call dunnin set_money_cutover_active true
#[reducer]
pub fn set_money_cutover_active(ctx: &ReducerContext, active: bool) -> Result<(), String> {
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Admin only".into());
    }
    if ctx.db.money_cutover().id().find(1u32).is_some() {
        ctx.db.money_cutover().id().update(MoneyCutover { id: 1, active });
    } else {
        ctx.db.money_cutover().insert(MoneyCutover { id: 1, active });
    }
    log::info!("[anti-cheat] money_cutover active = {}", active);
    Ok(())
}

/// Phase 3 (money migration) — server-authoritative rent charge. The client
/// calls this once on each ONLINE day-rollover (past grace) so the rent AMOUNT
/// is decided server-side, not by the client. Offline rent stays in
/// tick_day_clock; the client passes chargeRent=false on reconnect so the two
/// never double-charge. Owner-only; no-negative floor; matches tick_day_clock's
/// RENT_BY_TIER_CENTS table. Paused while CLOSED or during the grace period.
#[reducer]
pub fn charge_rent(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can be charged rent".into());
    }
    const RENT_BY_TIER_CENTS: [i64; 6] = [0, 4_000, 8_000, 16_000, 32_000, 64_000];
    const GRACE_DAYS: u32 = 14;
    let save = ctx.db.player_save().identity().find(r.owner);
    let open = save.as_ref().map(|s| s.restaurant_open).unwrap_or(true);
    let day = save.as_ref().map(|s| s.day_number).unwrap_or(1);
    if !open || day <= GRACE_DAYS {
        return Ok(());
    }
    let tier = save.as_ref().map(|s| s.luxury_tier).unwrap_or(1).min(5).max(1) as usize;
    let rent_cents = RENT_BY_TIER_CENTS[tier];
    if rent_cents <= 0 {
        return Ok(());
    }
    let new_balance = r.cloud_money_cents.saturating_sub(rent_cents).max(0);
    let charged = r.cloud_money_cents.saturating_sub(new_balance); // actual (no-negative)
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: new_balance,
        cloud_daily_expenses_cents: r.cloud_daily_expenses_cents.saturating_add(charged),
        ..r
    });
    record_money_event(ctx, restaurant_id, "rent", -charged, new_balance);
    Ok(())
}

/// Phase H.32 — Client pushes its absolute current money in cents.
/// Observational mirror only — does NOT make the server authoritative
/// for the economy. The intent is to give other clients (visit mode,
/// leaderboard, social) a near-current value instead of the autosave-
/// stale save_snapshot.money.
///
/// Idempotent — no-op when the row already has this value. Owner-only.
#[reducer]
pub fn set_cloud_money(
    ctx: &ReducerContext,
    restaurant_id: u64,
    money_cents: i64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set cloud money".into());
    }
    // Anti-cheat B/C — absolute money writes are locked once the cutover is
    // active (this path is already dead client-side; the guard also no-ops
    // a modded client's set_cloud_money(huge)).
    if money_cutover_active(ctx) {
        return Err("set_cloud_money is locked (server owns money)".into());
    }
    if r.cloud_money_cents == money_cents {
        return Ok(());
    }
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: money_cents,
        ..r
    });
    Ok(())
}

/// Phase 7.7 — Delta-based money sync. Add `delta_cents` to
/// cloud_money_cents (negative deltas spend, positive earn). Lets
/// server-side accumulate adds and client-side local spends coexist
/// without overwriting each other: the client's 5s sync pushes the
/// change-since-last-sync rather than the absolute value, so a tip
/// the server added in the meantime survives.
///
/// Owner-only. Saturating arithmetic — large negative balances are
/// allowed (player sees the debt) instead of wrapping or rejecting.
/// No-op for delta == 0 to keep the sync loop quiet when no
/// transactions happened.
#[reducer]
pub fn bump_cloud_money(
    ctx: &ReducerContext,
    restaurant_id: u64,
    delta_cents: i64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can bump cloud money".into());
    }
    // Anti-cheat B/C — once the money cutover is active the server is the
    // SOLE +money authority (income reducers). Reject POSITIVE deltas so a
    // modded client can't mint money via bump_cloud_money(+x). Negative
    // deltas (client-side spends / rent / salary) still flow through.
    if delta_cents > 0 && money_cutover_active(ctx) {
        return Err("positive money writes are locked (server owns income)".into());
    }
    if delta_cents == 0 {
        return Ok(());
    }
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: r.cloud_money_cents.saturating_add(delta_cents).max(0),
        ..r
    });
    Ok(())
}

/// Phase H.46 — Live mirror of the foreground client's per-day
/// revenue + expense totals (cents).  Observational only — visitors,
/// leaderboard, and cross-device load read these for "today's stats."
/// Fires on the same cadence as set_cloud_money / sync_day_clock
/// (every few seconds while the tab is alive); idempotent.
///
/// Distinct from the H.22/H.41/H.45 pending counters: those track
/// offline accruals to be drained on reconnect.  These are absolute
/// daily totals.  After the reconnect drain, the foreground client's
/// next sync sweeps the integrated totals up here.
///
/// Owner-only.
#[reducer]
pub fn sync_cloud_daily_totals(
    ctx: &ReducerContext,
    restaurant_id: u64,
    revenue_cents: i64,
    expenses_cents: i64,
    // Phase 6.11 — Today's customer-served + customer-lost counts.
    // Same 5s cadence as revenue/expense; visitors + second devices
    // see live values instead of save-snapshot stale ones.
    served: u32,
    lost: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can sync cloud daily totals".into());
    }
    if revenue_cents < 0 || expenses_cents < 0 {
        return Err("daily totals cannot be negative".into());
    }
    if r.cloud_daily_revenue_cents == revenue_cents
        && r.cloud_daily_expenses_cents == expenses_cents
        && r.cloud_daily_served == served
        && r.cloud_daily_lost == lost
    {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        cloud_daily_revenue_cents: revenue_cents,
        cloud_daily_expenses_cents: expenses_cents,
        cloud_daily_served: served,
        cloud_daily_lost: lost,
        ..r
    });
    Ok(())
}

/// Phase H.60 — Foreground client mirrors the full rating history
/// snapshot on every Game.reputation.recordRating call.  The CSV is
/// a comma-separated list of 1-5 ints, capped at 500 entries
/// (~1KB max).  Owner-only.  Idempotent on identical content.
///
/// Replaces save_snapshot.ratingHistory as the canonical
/// cross-device source for the rating list.  Hydrate on connect
/// reads this value back; if Some, it overrides whatever the local
/// save's ratingHistory had.
#[reducer]
pub fn set_cloud_rating_history(
    ctx: &ReducerContext,
    restaurant_id: u64,
    csv: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set rating history".into());
    }
    if csv.len() > 4096 {
        return Err("rating history too long (>4KB)".into());
    }
    let current = r.cloud_rating_history_csv.as_deref().unwrap_or("");
    if current == csv { return Ok(()); }
    let new_val = if csv.is_empty() { None } else { Some(csv) };
    ctx.db.restaurant().id().update(Restaurant {
        cloud_rating_history_csv: new_val,
        ..r
    });
    Ok(())
}

/// Phase H.61 — Mirror the EconomySystem transaction log as a
/// JSON-encoded array.  Foreground client pushes periodically
/// (every ~5 s) — NOT on every individual transaction, since
/// transactions can fire many times per second during busy play.
/// Server caps the column at 16 KB; client caps the array at the
/// last 100 entries before serializing.  Idempotent on identical
/// content.  Owner-only.
#[reducer]
pub fn set_cloud_transaction_log(
    ctx: &ReducerContext,
    restaurant_id: u64,
    json: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set transaction log".into());
    }
    if json.len() > 16384 {
        return Err("transaction log too large (>16KB)".into());
    }
    let current = r.cloud_transaction_log_json.as_deref().unwrap_or("");
    if current == json { return Ok(()); }
    let new_val = if json.is_empty() { None } else { Some(json) };
    ctx.db.restaurant().id().update(Restaurant {
        cloud_transaction_log_json: new_val,
        ..r
    });
    Ok(())
}

/// Phase H.63 — Mirror the DayHistory ring buffer as a JSON-encoded
/// array.  Client pushes on every Game.rolloverDay (once per 12-min
/// game day; low frequency).  Server caps at 16 KB; client caps at
/// 60 entries.  Owner-only.  Idempotent.
#[reducer]
pub fn set_cloud_day_history(
    ctx: &ReducerContext,
    restaurant_id: u64,
    json: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set day history".into());
    }
    if json.len() > 16384 {
        return Err("day history too large (>16KB)".into());
    }
    let current = r.cloud_day_history_json.as_deref().unwrap_or("");
    if current == json { return Ok(()); }
    let new_val = if json.is_empty() { None } else { Some(json) };
    ctx.db.restaurant().id().update(Restaurant {
        cloud_day_history_json: new_val,
        ..r
    });
    Ok(())
}

/// Phase I (H.68) — Set the player-pinned waiter rest spot.  When
/// waiters' state machines return to idle / returningHome they walk
/// to this position (any free waiter rests here, not just one).
/// Idempotent — same args produce same row.  Owner-only.
///
/// Position is in restaurant-local world units (same coordinate
/// frame as furniture x/z) and `floor` is 0 = ground / 1+ = upper
/// storey.  Client sanity-checks the floor against current tier;
/// the server only enforces ownership + the basic schema.
#[reducer]
pub fn set_waiter_rest_spot(
    ctx: &ReducerContext,
    restaurant_id: u64,
    x: f32,
    z: f32,
    floor: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set the waiter rest spot".into());
    }
    if r.waiter_rest_set && r.waiter_rest_x == x && r.waiter_rest_z == z
        && r.waiter_rest_floor == floor {
        return Ok(()); // idempotent no-op
    }
    // Phase 9.35 — reject a spot pinned OUTSIDE the building. An
    // unreachable rest spot strands every waiter walking toward it (they
    // never arrive → never idle → never re-dispatch — a total service
    // stall). The client's placement guard already blocks this, but
    // enforce it server-side too so an out-of-date client can't
    // re-introduce the stall. Bounds = this floor's furniture footprint
    // + a few tiles of slack; skipped when the floor has no furniture.
    let (mut minx, mut maxx, mut minz, mut maxz) =
        (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
    let mut any = false;
    for f in ctx.db.placed_furniture().restaurant_id().filter(restaurant_id) {
        if f.floor != floor { continue; }
        any = true;
        minx = minx.min(f.x); maxx = maxx.max(f.x);
        minz = minz.min(f.z); maxz = maxz.max(f.z);
    }
    if any {
        const M: f32 = 3.0;
        if x < minx - M || x > maxx + M || z < minz - M || z > maxz + M {
            return Err("Waiter rest spot must be inside the restaurant".into());
        }
    }
    ctx.db.restaurant().id().update(Restaurant {
        waiter_rest_set: true,
        waiter_rest_x: x,
        waiter_rest_z: z,
        waiter_rest_floor: floor,
        ..r
    });
    Ok(())
}

/// Phase I (H.68) — Clear the player-pinned waiter rest spot, so
/// the client falls back to the built-in default (a position near
/// the supply counter).  Owner-only.  Idempotent.
#[reducer]
pub fn clear_waiter_rest_spot(
    ctx: &ReducerContext,
    restaurant_id: u64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can clear the waiter rest spot".into());
    }
    if !r.waiter_rest_set {
        return Ok(()); // already unset
    }
    ctx.db.restaurant().id().update(Restaurant {
        waiter_rest_set: false,
        waiter_rest_x: 0.0,
        waiter_rest_z: 0.0,
        waiter_rest_floor: 0,
        ..r
    });
    Ok(())
}

/// Phase H.30 — Foreground client periodically yokes the cloud's
/// day_elapsed_ms to its local value so the cloud clock doesn't drift
/// out from under the player while the tab is alive. Also clears
/// pending_days_advanced because a foreground client has just
/// finished the rollovers locally via Game.rolloverDay().
///
/// Owner-only. Called from the Engine's update loop on a few-second
/// cadence (cheap reducer; tunable client-side).
#[reducer]
pub fn sync_day_clock(
    ctx: &ReducerContext,
    restaurant_id: u64,
    elapsed_ms: i64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can sync day clock".into());
    }
    let clamped = elapsed_ms.clamp(0, DAY_LENGTH_MS);
    if r.day_elapsed_ms == clamped && r.pending_days_advanced == 0 {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        day_elapsed_ms: clamped,
        pending_days_advanced: 0,
        ..r
    });
    Ok(())
}

/// Phase H.30 — Atomically read + zero pending_days_advanced. Called
/// by the client on reconnect (after subscription cache settles) so
/// it can loop Game.rolloverDay() N times to apply backgrounded
/// rent payments, daily resets, history snapshots, etc. day_elapsed_ms
/// is left intact; the client's next sync_day_clock yokes it.
#[reducer]
pub fn consume_pending_day_advancement(
    ctx: &ReducerContext,
    restaurant_id: u64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can consume day advancement".into());
    }
    if r.pending_days_advanced == 0 {
        return Ok(()); // idempotent
    }
    log::info!(
        "consume_pending_day_advancement: clearing {} days on restaurant {}",
        r.pending_days_advanced, restaurant_id,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_days_advanced: 0,
        ..r
    });
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

// === H.42 — Distance-aware staff dispatch =========================
//
// The earlier H.6 / H.8 / H.34 / H.35 dispatchers each picked staff
// off the iterator with no spatial preference — "first idle waiter"
// or random pop().  Foreground play covered for this because the
// local StaffRouter uses A* + nearest-wins to assign trips before
// the server's auto-claim path fires.  Backgrounded restaurants,
// though, would route a downstairs waiter to an upstairs guest
// while an upstairs waiter sat idle.  Visit-mode subscribers saw
// the same.
//
// H.42 ports the "pick nearest" half of the foreground decision
// (NOT the full A* — wall-aware routing matters for visual quality
// but not for which staff gets the job; the body still walks in a
// straight line either way).  All four server dispatchers now sort
// candidates by 2D distance with a stair-traversal penalty for
// floor mismatches:
//
//   - auto_claim_queued_tickets — nearest chef/barman, AND for that
//     pick also iterates stations to find the closest free one.
//   - auto_assign_ready_tickets — nearest waiter to the pickup spot.
//   - try_dispatch_take_order — nearest waiter to the guest's seat.
//   - try_dispatch_wash_trip — nearest waiter to the wash station
//     (the seat used as visual pseudo-pickup is incidental).

/// Per-floor penalty added when a staff actor and a target are on
/// different floors. Approximates "you have to walk to the stairs
/// first" without modeling the actual stair locations. Tuned to
/// dominate same-floor wide-room cases: a same-floor candidate at
/// distance 14 should still beat a cross-floor candidate at
/// distance 4. Bumping this higher just makes the heuristic
/// more conservative about cross-floor assignments.
const STAIR_TRAVERSAL_DIST: f32 = 15.0;

// Phase 9.55 — the 9.41 SEAT_FLOOR_BIAS "soft preference" is gone.
// Cross-floor cooking is now a hard NO (auto_claim_queued_tickets skips
// any station not on the order's floor + any chef not assigned to it),
// so a tunable bias is no longer needed.

/// Distance from a staff actor to a target point, with a per-floor
/// stair penalty applied. Used for picking the "nearest" candidate
/// across all four dispatchers.  Euclidean (sqrt) so the units are
/// in tiles and the floor penalty is meaningful — a squared metric
/// would warp the penalty math.
fn staff_dist_to(actor: &StaffActor, tx: f32, tz: f32, t_floor: u32) -> f32 {
    let dx = actor.x - tx;
    let dz = actor.z - tz;
    let mut d = (dx * dx + dz * dz).sqrt();
    if actor.floor != t_floor {
        let floors = (actor.floor as i32 - t_floor as i32).unsigned_abs() as f32;
        d += floors * STAIR_TRAVERSAL_DIST;
    }
    d
}

/// Remove and return the nearest actor from `pool` to (tx, tz, t_floor).
/// Returns None if the pool is empty. O(n) per call; pool sizes are
/// tiny (≤6 staff per restaurant), so the simple linear scan is
/// cheaper than maintaining a sorted structure.
fn pop_nearest_staff(
    pool: &mut Vec<StaffActor>,
    tx: f32,
    tz: f32,
    t_floor: u32,
) -> Option<StaffActor> {
    // Phase 9.55 — STRICT per-floor staffing. Only a staff member whose
    // ASSIGNED floor (home_floor) is the work's floor is eligible — no
    // autonomous cross-floor any more. The player moves staff between
    // floors explicitly (the StaffPanel floor control), and that's the
    // ONLY way a member ever serves another floor. A floor with no staff
    // of the needed role simply doesn't get that service (its customers
    // wait + leave) — the burden is on the player to staff each floor.
    let mut best: Option<(usize, f32)> = None;
    for (i, a) in pool.iter().enumerate() {
        if a.home_floor != t_floor { continue; }
        let d = staff_dist_to(a, tx, tz, t_floor);
        if best.map_or(true, |(_, bd)| d < bd) {
            best = Some((i, d));
        }
    }
    best.map(|(idx, _)| pool.swap_remove(idx))
}

/// Phase 9.42 — Observability. Scans the restaurant for the anomaly
/// patterns we'd otherwise hunt by hand (starved take-orders, undelivered
/// food, a hogging chef, idle staff while work waits, a walkout spike) and
/// publishes a compact "|"-joined summary to restaurant.health_summary_csv.
/// Change-detected: only rewrites the row + log::warn!s when the issue
/// set/counts actually change, so it neither spams the row subscription
/// nor the logs. The foreground client renders the summary as a badge.
fn scan_restaurant_health(ctx: &ReducerContext, rid: u64) {
    let Some(r) = ctx.db.restaurant().id().find(rid) else { return };

    // Guests by state.
    let (mut ordering, mut waiting_food) = (0u32, 0u32);
    for g in ctx.db.active_guest().restaurant_id().filter(rid) {
        match g.state.as_str() {
            "ordering" => ordering += 1,
            "waitingForFood" => waiting_food += 1,
            _ => {}
        }
    }
    let _ = waiting_food; // reserved for a future "kitchen too slow" flag

    // Tickets by state + per-chef in-flight cook share (for hog detection).
    let (mut queued, mut ready, mut in_flight) = (0u32, 0u32, 0u32);
    let mut cook_by_chef: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for t in ctx.db.active_ticket().restaurant_id().filter(rid) {
        match t.state.as_str() {
            "queued" => queued += 1,
            "ready" => ready += 1,
            "cooking" | "delivering" => {
                if !t.assigned_chef_id.is_empty() {
                    *cook_by_chef.entry(t.assigned_chef_id.clone()).or_insert(0) += 1;
                    in_flight += 1;
                }
            }
            _ => {}
        }
    }

    // Idle staff.
    let (mut chefs_idle, mut waiters_idle) = (0u32, 0u32);
    for a in ctx.db.staff_actor().restaurant_id().filter(rid) {
        if a.state != "idle" { continue; }
        match a.role.as_str() {
            "chef" => chefs_idle += 1,
            "waiter" => waiters_idle += 1,
            _ => {}
        }
    }

    // Phase 9.47 — free chef cook-stations (every cookable appliance
    // EXCEPT the bar). Used to tell apart two very different reasons a
    // chef sits idle while tickets queue: a real dispatch gap (there's
    // a free stove but no chef walked to it) vs. the kitchen simply
    // being out of stations (every stove busy — idle chefs have nowhere
    // to cook). The latter is fixed by buying stoves, NOT by hiring more
    // chefs — which is exactly the trap the owner fell into (9 chefs, 5
    // stoves, 4 chefs permanently idle).
    let occupied_stations: std::collections::HashSet<String> = ctx.db.staff_actor()
        .restaurant_id().filter(rid)
        .filter(|a| !a.assigned_stove_uid.is_empty())
        .map(|a| a.assigned_stove_uid.clone())
        .collect();
    let mut chef_stations_free = 0u32;
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        if matches!(def_provides(&f.def_id), Some(ap) if ap != "bar")
            && !occupied_stations.contains(&f.uid) {
            chef_stations_free += 1;
        }
    }

    let mut flags: Vec<String> = Vec::new();
    // Take-order: an IDLE waiter while guests wait to order is a dispatch
    // regression (shouldn't happen post-9.40); otherwise a deep queue is
    // just capacity (too few waiters for the crowd).
    if waiters_idle > 0 && ordering > 0 {
        flags.push(format!("waiter_starved:{ordering}"));
    } else if ordering > 8 {
        flags.push(format!("order_queue:{ordering}"));
    }
    // Cooking: an idle chef while tickets queue is EITHER a dispatch
    // regression (a free stove went unclaimed) OR the kitchen running
    // out of stoves (every station busy). Phase 9.47 splits them so the
    // badge gives the right advice — add stoves vs. investigate dispatch.
    if chefs_idle > 0 && queued > 0 {
        if chef_stations_free == 0 {
            flags.push(format!("kitchen_full:{queued}"));
        } else {
            flags.push(format!("chef_starved:{queued}"));
        }
    } else if queued > 6 {
        flags.push(format!("cook_backlog:{queued}"));
    }
    // Delivery: a pile of cooked food waiting for a waiter.
    if ready > 6 {
        flags.push(format!("undelivered:{ready}"));
    }
    // One chef holding the lion's share of in-flight cooks.
    if in_flight >= 4 {
        if let Some(max_n) = cook_by_chef.values().copied().max() {
            if max_n * 100 >= in_flight * 65 {
                flags.push(format!("chef_hog:{}", max_n * 100 / in_flight));
            }
        }
    }
    // Walkout spike (needs a meaningful daily sample first).
    let day_total = r.cloud_daily_served + r.cloud_daily_lost;
    if day_total >= 20 && r.cloud_daily_lost * 100 >= day_total * 35 {
        flags.push(format!("lost_spike:{}", r.cloud_daily_lost * 100 / day_total));
    }
    // Phase 9.45 — STRICT cleaning: distinct seats holding leftover
    // plates. Each is UNSERVABLE until a waiter buses it, so a growing
    // count means cleaning can't keep up with turnover (too few waiters
    // for the churn) and effective seating capacity is shrinking. Flag
    // once it's more than a couple so the owner sees the squeeze.
    let mut dirty_seat_uids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for d in ctx.db.dirty_pile().restaurant_id().filter(rid) {
        dirty_seat_uids.insert(d.seat_uid);
    }
    if dirty_seat_uids.len() > 2 {
        flags.push(format!("dirty_seats:{}", dirty_seat_uids.len()));
    }

    let summary = if flags.is_empty() { None } else { Some(flags.join("|")) };
    if r.health_summary_csv != summary {
        match &summary {
            Some(s) => log::warn!("[health] restaurant {rid}: {s}"),
            None => log::info!("[health] restaurant {rid}: healthy"),
        }
        ctx.db.restaurant().id().update(Restaurant { health_summary_csv: summary, ..r });
    }
}

fn auto_claim_queued_tickets(ctx: &ReducerContext, rid: u64) {
    /// Fallback when ticket.base_cook_seconds_ms is 0 (legacy tickets
    /// or tickets where place_order didn't pass a value).
    const FALLBACK_COOK_SECONDS_MS: i64 = 5_000;

    let queued_ids: Vec<u64> = ctx.db
        .active_ticket()
        .restaurant_id().filter(rid)
        .filter(|t| t.state == "queued")
        .map(|t| t.id)
        .collect();
    if queued_ids.is_empty() {
        return;
    }

    // Split idle staff by role. We pop from these as we assign so
    // each actor is only claimed once per tick.
    let mut idle_chefs: Vec<StaffActor> = ctx.db
        .staff_actor()
        .restaurant_id().filter(rid)
        .filter(|a| a.role == "chef"
            && a.state == "idle"
            && a.ticket_id.is_none())
        .collect();
    let mut idle_barmen: Vec<StaffActor> = ctx.db
        .staff_actor()
        .restaurant_id().filter(rid)
        .filter(|a| a.role == "barman"
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
        .restaurant_id().filter(rid)
        .filter(|a| !a.assigned_stove_uid.is_empty())
        .map(|a| a.assigned_stove_uid.clone())
        .collect();

    for ticket_id in queued_ids {
        let Some(ticket) = ctx.db.active_ticket().id().find(ticket_id) else { continue };
        if ticket.state != "queued" { continue; }
        let is_bar = ticket.appliance == "bar";
        // Bail early if no idle staff of the right role exist.
        let pool_empty = if is_bar { idle_barmen.is_empty() } else { idle_chefs.is_empty() };
        if pool_empty { continue; }

        // H.42 — Of all stations matching the ticket's appliance, pick
        // the one closest to the nearest idle staff member of the
        // right role.  Naive O(stations × staff) but pool sizes are
        // small (~10 × ~6).  This mirrors the foreground
        // StaffRouter's nearest-wins behavior.
        let pool: &Vec<StaffActor> = if is_bar { &idle_barmen } else { &idle_chefs };
        let mut best: Option<(PlacedFurniture, usize, f32)> = None; // (station, actor_idx, total_dist)
        for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
            if def_provides(&f.def_id) != Some(ticket.appliance.as_str()) { continue; }
            if occupied.contains(&f.uid) { continue; }
            // Phase 9.55 — STRICT per-floor staffing (replaces the 9.41
            // SEAT_FLOOR_BIAS "soft preference"). The dish is cooked on the
            // ORDER's floor, full stop: skip every station on another floor.
            // The CHEF must also be assigned to that floor (filter below).
            // A chef may still move between free stations ON ITS OWN FLOOR
            // (the player chose "keep station sharing"), but never crosses
            // floors. If the order's floor has no chef or no free station,
            // the order waits — the player staffs each floor they seat on.
            if f.floor != ticket.seat_floor { continue; }
            // Cheapest same-floor chef for this candidate station.
            let mut local_best: Option<(usize, f32)> = None;
            for (i, a) in pool.iter().enumerate() {
                if a.home_floor != ticket.seat_floor { continue; }
                let d = staff_dist_to(a, f.x, f.z, f.floor);
                if local_best.map(|(_, bd)| d < bd).unwrap_or(true) {
                    local_best = Some((i, d));
                }
            }
            if let Some((ai, d)) = local_best {
                if best.as_ref().map(|(_, _, bd)| d < *bd).unwrap_or(true) {
                    best = Some((f, ai, d));
                }
            }
        }
        let Some((station, actor_idx, _)) = best else {
            // No station for this appliance — bail this ticket.
            continue;
        };
        // Pop the chosen actor from the right pool.
        let actor: StaffActor = if is_bar {
            idle_barmen.swap_remove(actor_idx)
        } else {
            idle_chefs.swap_remove(actor_idx)
        };
        // Lock the station so subsequent iterations don't reuse it.
        occupied.insert(station.uid.clone());

        // H.52 — apply chef/barman training multiplier to the cook
        // time so a trained staff member actually cooks faster server-
        // side (matches the client's chef.cookMultiplier path).
        let base_ms = if ticket.base_cook_seconds_ms > 0 {
            ticket.base_cook_seconds_ms
        } else {
            FALLBACK_COOK_SECONDS_MS
        };
        let mult_x100 = chef_cook_multiplier_x100(ctx, &actor.member_id);
        let cook_seconds_ms = apply_chef_speed(base_ms, mult_x100);

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
        // Phase 9.21 — stand IN FRONT of the station, not inside it.
        // target = station center made the chef cook from inside the
        // stove mesh. Offset ~1 m along the station's facing (same
        // rot_y stand-spot convention the WC picker uses).
        // Phase 9.31 — bar counters seat customers on the +facing side,
        // so a BARMAN must stand BEHIND (−facing) to mix; a cook stands
        // IN FRONT (+facing). Without this the barman mixed from the
        // customer side / inside the bar mesh.
        let (stand_x, stand_z) = if is_bar {
            // Phase 9.63 — centroid-aware inside-bar spot (fixes wrapped bars).
            bar_inside_stand(ctx, rid, station.x, station.z, station.rot_y, station.floor)
        } else {
            (station.x + station.rot_y.sin(), station.z + station.rot_y.cos())
        };
        // Clamp the cook-stand to the interior box at the SOURCE — a station
        // against a wall puts the +facing stand position outside, which the
        // per-tick clamp only corrects a frame later ("guy outside"). [bug-sweep]
        let (stand_x, stand_z) = (stand_x.clamp(-4.2_f32, 5.2_f32), stand_z.clamp(-4.2_f32, 5.2_f32));
        ctx.db.staff_actor().member_id().update(StaffActor {
            state: "movingToWork".to_string(),
            state_clock_ms: 0,
            ticket_id: Some(ticket_id),
            target_x: stand_x,
            target_z: stand_z,
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
        // Phase 9.24 — "counter" was MISSING here, so EVERY counter-
        // appliance recipe (desserts, appetizers, pies, pickles —
        // pistachio-cream, apple-pie, house-pickles…) could never be
        // matched to a station server-side: its ticket queued forever
        // and the chef stood idle (no station to claim). Both
        // counter defs from the client catalog now map to "counter".
        "counter" | "counter-drawer" => Some("counter"),
        "coffee-machine" => Some("coffee"),
        "blender" => Some("blender"),
        "toaster" => Some("toaster"),
        "bar-counter" | "bar-end" => Some("bar"),
        // Phase 9.62 — new dedicated cooking stations. Without these
        // entries the server's auto_claim_queued_tickets can't match a
        // grill/oven/fryer/pizza ticket to a station, so those recipes
        // would queue forever and never cook (the chef stands idle).
        "grill-station" => Some("grill"),
        "fryer-station" => Some("fryer"),
        "oven-station" => Some("oven"),
        "pizza-oven" => Some("pizza-oven"),
        _ => None,
    }
}

/// Phase 9.63 (staff migration Pass 2) — centroid-aware "behind the bar"
/// stand spot, mirroring the client's `barmanInsideStandFor`. Bar defs
/// seat customers on the +facing side, so a barman serves from the other
/// side. For a SINGLE bar tile that's simply BACK (−facing). For a U/O-
/// shaped multi-tile bar, "inside the ring" is whichever of front/back is
/// closer to the CENTROID of all bar tiles — that's the fix for the
/// "barman can't reach the inside-of-bar serving spot" bug, which the old
/// naive (x−sin, z−cos) got wrong for wrapped bars. Caller clamps to the
/// interior box. Re-iterates furniture (for the centroid), so callers must
/// invoke this OUTSIDE any open placed_furniture iteration.
fn bar_inside_stand(ctx: &ReducerContext, rid: u64, sx: f32, sz: f32, rot_y: f32, floor: u32) -> (f32, f32) {
    let (sin, cos) = (rot_y.sin(), rot_y.cos());
    let front = (sx + sin, sz + cos);
    let back = (sx - sin, sz - cos);
    let mut cx = 0.0_f32;
    let mut cz = 0.0_f32;
    let mut n = 0u32;
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        if f.floor != floor { continue; }
        if def_provides(&f.def_id) != Some("bar") { continue; }
        cx += f.x;
        cz += f.z;
        n += 1;
    }
    if n <= 1 {
        return back;
    }
    cx /= n as f32;
    cz /= n as f32;
    let d_front = (front.0 - cx).powi(2) + (front.1 - cz).powi(2);
    let d_back = (back.0 - cx).powi(2) + (back.1 - cz).powi(2);
    if d_front < d_back { front } else { back }
}

/// Phase 9.31 — Where a staff member idles / returns when they have no
/// active work, chosen by ROLE so the floor reads sensibly instead of
/// everyone drifting back to their spawn tile (which left chefs in the
/// dining room, idle waiters loitering wherever they last stood — e.g.
/// a sink by the WC — and barmen on the wrong side of the counter):
///   - waiter: the player-pinned rest spot (set_waiter_rest_spot) when
///     set; otherwise their OWN spawn home (9.35 — see staff_home_target
///     for why a shared kitchen tile was a footgun).
///   - chef:   the stand spot IN FRONT of the nearest cook station on
///     their home floor, so an idle chef waits at the stove.
///   - barman: the stand spot BEHIND the nearest bar counter, so they
///     never stand on the customer side / inside the counter mesh.
/// Falls back to the actor's own home_x/z when the floor has no station
/// of the relevant kind. Offsets mirror the dispatch stand-spot maths +
/// the client's chefStandPosFor / barmanInsideStandFor convention.
/// Phase 9.35 — small, STABLE per-member offset (≈ ±0.6 tiles) derived
/// from the member id. Staff that share a single home spot (a pinned
/// rest spot, or the same nearest station) would otherwise target the
/// exact same tile; PersonalSpace then shoves some out of arrival range
/// and they never flip returningHome → idle, so they never get
/// re-dispatched. A deterministic offset fans them out without jittering
/// every tick (which would make them twitch).
fn member_jitter(member_id: &str) -> (f32, f32) {
    let h: u32 = member_id.bytes().fold(0u32, |a, b| a.wrapping_mul(131).wrapping_add(b as u32));
    let dx = ((h % 13) as f32 / 13.0 - 0.5) * 1.2;
    let dz = (((h / 13) % 13) as f32 / 13.0 - 0.5) * 1.2;
    (dx, dz)
}

fn staff_home_target(ctx: &ReducerContext, actor: &StaffActor) -> (f32, f32, u32) {
    let rid = actor.restaurant_id;
    let (jx, jz) = member_jitter(&actor.member_id);
    // Keep every home / idle / stand target INSIDE the building. The legacy
    // spawn-home default (~9.35) and old client-mirrored idle spots sit out
    // on the grass (live rows show waiters parked at x 6.9-8.1); the server
    // then sends staff to idle there and the client clamp fights it every
    // frame and loses (staff stuck against the wall / mid-air outside).
    // [-4.2, 5.2] matches the client's fixed INTERIOR box. Entry paths
    // (guests / errands from the road) never pass through this function, so
    // clamping here can't strand anyone outside.
    let clamp_in = |x: f32, z: f32| (x.clamp(-4.2_f32, 5.2_f32), z.clamp(-4.2_f32, 5.2_f32));
    // Waiter: a pinned rest spot wins (fanned out so the pool doesn't
    // stack on one tile). With NO rest spot a waiter returns to its OWN
    // spawn home — those are already spread out and always reachable.
    //
    // Phase 9.35 — DON'T send waiters to a shared cook-station stand spot
    // (the 9.31 default): it crowded them, and worse, a single
    // unreachable shared target — e.g. a rest spot the player pinned
    // outside the building — stalled the ENTIRE waiter pool in
    // returningHome forever (they could never arrive → never went idle →
    // never got dispatched). The placement UI now also rejects
    // out-of-bounds rest spots, but per-waiter homes are the safety net.
    if actor.role == "waiter" {
        if let Some(r) = ctx.db.restaurant().id().find(rid) {
            if r.waiter_rest_set {
                let (cx, cz) = clamp_in(r.waiter_rest_x + jx, r.waiter_rest_z + jz);
                return (cx, cz, r.waiter_rest_floor);
            }
        }
        let (cx, cz) = clamp_in(actor.home_x, actor.home_z);
        return (cx, cz, actor.home_floor);
    }
    // Chef → in front of the nearest cook station; barman → behind the
    // nearest bar. Jittered so a multi-chef kitchen doesn't stack on one
    // stand spot. Falls back to the spawn home when the floor has none.
    let want_bar = actor.role == "barman";
    // Phase 9.63 — track the nearest matching STATION in the loop, then
    // compute its stand spot AFTER (bar_inside_stand re-iterates furniture
    // for the centroid, so it can't run inside this iteration).
    let mut best_station: Option<(f32, f32, f32, f32)> = None; // (x, z, rot_y, dist²)
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        if f.floor != actor.home_floor { continue; }
        let Some(provides) = def_provides(&f.def_id) else { continue };
        let is_bar = provides == "bar";
        if want_bar != is_bar { continue; }
        let d = (f.x - actor.home_x).powi(2) + (f.z - actor.home_z).powi(2);
        if best_station.map_or(true, |(_, _, _, bd)| d < bd) {
            best_station = Some((f.x, f.z, f.rot_y, d));
        }
    }
    match best_station {
        Some((fx, fz, frot, _)) => {
            // Bar → centroid-aware inside spot; cook station → IN FRONT (+facing).
            let (sx, sz) = if want_bar {
                bar_inside_stand(ctx, rid, fx, fz, frot, actor.home_floor)
            } else {
                (fx + frot.sin(), fz + frot.cos())
            };
            let (cx, cz) = clamp_in(sx + jx, sz + jz);
            (cx, cz, actor.home_floor)
        }
        None => { let (cx, cz) = clamp_in(actor.home_x, actor.home_z); (cx, cz, actor.home_floor) },
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
        .restaurant_id().filter(rid)
        // Phase 9.50 — skip POOLED dishes (guest_id == 0): a cooked dish
        // whose customer walked out has no seat to deliver to. It waits
        // in the pool until a new order of the same recipe claims it
        // (auto_place_next_course) or it spoils (tick_ticket_state).
        .filter(|t| t.state == "ready" && t.guest_id != 0)
        .map(|t| t.id)
        .collect();
    if ready_ids.is_empty() { return; }

    // Idle waiters with no current ticket binding.
    let mut idle_waiters: Vec<StaffActor> = ctx.db
        .staff_actor()
        .restaurant_id().filter(rid)
        .filter(|a| a.role == "waiter"
            && a.state == "idle"
            && a.ticket_id.is_none())
        .collect();
    if idle_waiters.is_empty() { return; }

    for ticket_id in ready_ids {
        let Some(ticket) = ctx.db.active_ticket().id().find(ticket_id) else { continue };
        // Recheck — local sim may have raced us.
        if ticket.state != "ready" { continue; }
        let pickup_x = ticket.pickup_x;
        let pickup_z = ticket.pickup_z;
        let pickup_floor = ticket.pickup_floor;
        // H.42 — pick the waiter nearest to the pickup spot, not the
        // first one off the iterator.  Mirrors the foreground W4/W5/W6
        // distance-weighted picker for backgrounded play.
        let Some(waiter) = pop_nearest_staff(&mut idle_waiters, pickup_x, pickup_z, pickup_floor)
            else { break };
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
    // Phase 9.31 — role-aware idle home (chef → stove stand) instead of
    // the spawn tile, so an idle chef waits at the stove.
    let (home_x, home_z, home_floor) = staff_home_target(ctx, &c);
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
    // Phase 9.31 — role-aware idle home (waiter → pinned rest spot, else
    // the kitchen food-pickup area) instead of the spawn tile.
    let (home_x, home_z, home_floor) = staff_home_target(ctx, &w);
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
    // preserving its tier via the H.93 CSV. Pre-H.93 batches with
    // plates_tiers=None fall back to "highest existing tier" inside
    // flush_one_dish (legacy behaviour).
    let plate_tiers = parse_tier_csv(b.plates_tiers.as_deref());
    let glass_tiers = parse_tier_csv(b.glasses_tiers.as_deref());
    for i in 0..b.plates as usize {
        flush_one_dish(ctx, restaurant_id, "plate", plate_tiers.get(i).copied());
    }
    for i in 0..b.glasses as usize {
        flush_one_dish(ctx, restaurant_id, "glass", glass_tiers.get(i).copied());
    }
    ctx.db.dishwasher_batch().furniture_uid().delete(furniture_uid.to_string());
    log::info!(
        "dishwasher {} cycle finished: flushed {} plate(s) + {} glass(es) to clean pool",
        furniture_uid, b.plates, b.glasses,
    );
}

/// Phase I (H.93) — Parse a comma-separated list of u32 tier
/// numbers (e.g. "5,5,3" → [5, 5, 3]). Empty / None / unparseable
/// entries are silently skipped — the loaded count is the source of
/// truth, and missing tier entries get a None hint in flush_one_dish.
fn parse_tier_csv(csv: Option<&str>) -> Vec<u32> {
    let Some(s) = csv else { return Vec::new() };
    s.split(',')
        .filter_map(|t| t.trim().parse::<u32>().ok())
        .filter(|t| (1..=5).contains(t))
        .collect()
}

/// Phase I (H.93) — Append one tier to an existing tier CSV.
/// `None` / empty input produces `"<tier>"`; otherwise produces
/// `"<existing>,<tier>"`. Used by load paths to extend the batch's
/// tier list one piece at a time.
fn append_tier_csv(existing: Option<&str>, tier: u32) -> String {
    match existing {
        None => tier.to_string(),
        Some(s) if s.is_empty() => tier.to_string(),
        Some(s) => format!("{},{}", s, tier),
    }
}

/// Phase H.22 — accumulate the just-despawned guest's approximate
/// rating + tip on the Restaurant.pending_* counters. Called from
/// tick_guest_state's despawn branch alongside settle_guest_dishes,
/// inside the same `!g.dishes_settled` gate so we don't double-count
/// when a foreground client already credited the visit locally.
///
/// Rating approximation: server has total_satisfaction_x100 +
/// order_recipes (from H.16 + H.14 mirrors). Mirrors the FIRST step
/// of GuestSpawner.finalizeVisit's rating math — `base = 2 + avgSat/2`
/// clamped to 1..5 — but SKIPS dish quality bonus, dirty-restaurant
/// penalty, furniture vibe, bathroom score, smoke penalty, and the
/// random jitter. Foreground play still computes the full rating
/// (no approximation) because settleGuestDishes gates the server's
/// settle. This rough rating is only used for backgrounded survival.
///
/// Tip computation: tipMultByRating[rating] × archetype.tipMultiplier
/// × weatherMult. Phase 6.2 wires both — archetype tip_mult_x100 from
/// the customer_archetype catalog (seeded at boot via H.38), weather
/// from weather_state mapped through weather_tip_mult_x100. Foreground
/// online play still computes its own tip via finalizeVisit (this
/// rollup is gated on owner_offline below), so the two paths stay in
/// lockstep without double-crediting.
fn accumulate_pending_visit_rollup(ctx: &ReducerContext, g: &ActiveGuest) {
    // Course count = entries in order_recipes CSV. Used as the avgSat
    // denominator. Skip if there are no courses recorded — a guest who
    // never ordered shouldn't contribute a rating.
    let course_count = g.order_recipes
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .count();
    if course_count == 0 { return; }

    // H.25 — dish-quality satisfaction bonus, mirroring
    // GuestSpawner.finalizeVisit's `dishSatBonus` loop. For each
    // course we look up satisfactionPerPiece by (kind, tier) from
    // the lookup table below and sum onto the existing
    // total_satisfaction_x100 before averaging. Kind comes from
    // order_appliances: "bar" → glass, anything else → plate. Tier
    // comes from the parallel reserved_dish_tiers CSV (mirrored
    // by H.20).
    let tiers: Vec<u32> = g.reserved_dish_tiers
        .split(',')
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .collect();
    let appliance_csv = g.order_appliances.as_deref().unwrap_or("");
    let appliances: Vec<&str> = appliance_csv.split(',').collect();
    let mut dish_sat_bonus_x100: i64 = 0;
    for (i, &tier) in tiers.iter().enumerate() {
        let appliance = appliances.get(i).copied().unwrap_or("stove");
        let kind = if appliance == "bar" { "glass" } else { "plate" };
        dish_sat_bonus_x100 += dish_satisfaction_x100(kind, tier);
    }

    // (total_satisfaction_x100 + dish_sat_bonus_x100) / 100 / count
    // = avgSat. Then base = clamp(2 + avgSat/2, 1, 5), rounded.
    // Integer math: × 100 / 200 = / 2.
    let adjusted_sat_x100 = (g.total_satisfaction_x100 as i64)
        .saturating_add(dish_sat_bonus_x100);
    let avg_sat_x100 = adjusted_sat_x100 / (course_count as i64);
    // base_x100 = 200 + avg_sat_x100 / 2
    let mut base_x100 = 200 + (avg_sat_x100 / 2);

    // H.26 — dirty-pile penalty. Mirrors Game.isDishPileOverwhelming:
    // if total dirty pieces across the restaurant exceed 8, drop the
    // rating by 1 star (floor at 1).
    const DIRTY_PILE_THRESHOLD: u32 = 8;
    let total_dirty: u32 = ctx.db.dishware_pool()
        .restaurant_id().filter(g.restaurant_id)
        .map(|p| p.dirty)
        .sum();
    if total_dirty > DIRTY_PILE_THRESHOLD {
        base_x100 = (base_x100 - 100).max(100);
    }

    // H.26 — smoke penalty. -0.1 stars per unhooded stove, capped at
    // -0.5. Stoves and hoods identified by def_id matching the
    // client's countById calls in finalizeVisit.
    // H.27 — also count bathroom fixtures in the same pass so we
    // don't iterate placed_furniture twice.
    let mut stove_count: i32 = 0;
    let mut hood_count: i32 = 0;
    let mut toilet_count: i32 = 0;
    let mut sink_count: i32 = 0;
    for f in ctx.db.placed_furniture().restaurant_id().filter(g.restaurant_id) {
        match f.def_id.as_str() {
            // Phase 9.62 — open-flame / wood-fired stations smoke too, so
            // they need a range hood like a stove. Fryer + oven are
            // enclosed → exempt.
            "stove" | "stove-electric" | "grill-station" | "pizza-oven" => stove_count += 1,
            "kitchen-hood" | "kitchen-hood-l" => hood_count += 1,
            _ => {}
        }
        if is_toilet_def(&f.def_id) { toilet_count += 1; }
        if is_sink_def(&f.def_id) { sink_count += 1; }
    }
    let unhooded = (stove_count - hood_count).max(0);
    if unhooded > 0 {
        let smoke_x100 = (unhooded as i64 * 10).min(50);
        base_x100 = (base_x100 - smoke_x100).max(100);
    }

    // H.28 — read the cached aggregate stats the client pushed via
    // update_restaurant_aggregates. Empty when no furniture has been
    // placed (or the client never mirrored) — in that case vibe and
    // bathroom quality both read 0 and the rating math degrades
    // gracefully.
    let (cached_style_x100, cached_comfort_x100, cached_rating_bonus_x100, cached_bathroom_quality_x100) =
        ctx.db.restaurant().id().find(g.restaurant_id)
            .map(|r| (
                r.cached_style_x100 as i64,
                r.cached_comfort_x100 as i64,
                r.cached_rating_bonus_x100 as i64,
                r.cached_bathroom_quality_x100 as i64,
            ))
            .unwrap_or((0, 0, 0, 0));

    // H.28 + H.29 — bathroom modifier (full math). Matches
    // GuestSpawner.finalizeVisit's bathroom delta calculation,
    // including quality scaling from cached_bathroom_quality_x100
    // AND the "wanted but couldn't" distinction via wc_completed:
    //   - wc_completed=true: cycle finished, apply success bonus
    //   - wc_completed=false but used_toilet/washed_hands=true:
    //     gave up because every fixture was busy. Moderate penalty.
    let q_norm_x100 = (cached_bathroom_quality_x100 / 18).min(100); // capped at +1.0
    let bathroom_x100: i64 = if g.will_use_toilet {
        if toilet_count == 0 {
            -80 // player didn't provide a toilet
        } else if g.wc_completed {
            // Successful toilet trip — full quality-scaled bonus.
            // delta = -0.2 + qNorm * 0.8 + (washed ? 0.15 : no-sink ? -0.25 : 0)
            let mut delta = -20 + (q_norm_x100 * 80) / 100;
            if g.washed_hands { delta += 15; }
            else if sink_count == 0 { delta -= 25; }
            delta
        } else if g.used_toilet {
            // Latched without completing → gave up (H.29).
            -35
        } else {
            0
        }
    } else if g.will_wash_only {
        if sink_count == 0 {
            -50
        } else if g.wc_completed {
            // Successful wash-only.  0.15 + qNorm * 0.2
            15 + (q_norm_x100 * 20) / 100
        } else if g.washed_hands {
            // Tried but every sink was busy (give-up).
            -20
        } else {
            0
        }
    } else if toilet_count > 0 {
        // Didn't intend to visit; a tidy bathroom is a small ambient
        // bonus capped at +0.2 + extra +0.05 if a sink is also placed.
        let mut delta = (q_norm_x100 * 20) / 100;
        if sink_count > 0 { delta += 5; }
        delta
    } else {
        0
    };
    base_x100 = (base_x100 + bathroom_x100).clamp(100, 500);

    // H.28 — furniture vibe modifier. vibe = (style + comfort/2)
    // × 0.012, capped at +1.0; then ratingBonus added directly.
    // Integer math: inputs are x100, scaling factor 0.012 = 12/1000.
    let vibe_input_x100 = cached_style_x100 + cached_comfort_x100 / 2;
    let vibe_x100 = (vibe_input_x100 * 12) / 1000;
    let vibe_capped_x100 = vibe_x100.max(0).min(100); // [0, +1.0]
    base_x100 = (base_x100 + vibe_capped_x100 + cached_rating_bonus_x100)
        .clamp(100, 500);

    // H.26 — deterministic jitter, ±0.4 (= ±40 in x100). The client
    // uses Math.random() but the server tick disallows that (would
    // break resume determinism). Mix the guest id into a small
    // PRNG-ish hash; gives every guest their own consistent jitter
    // without external state.
    //
    // Splitmix64-style mix: simple, fast, and well-distributed enough
    // that adjacent guest ids produce uncorrelated jitters.
    let mut h: u64 = g.id ^ 0x9E37_79B9_7F4A_7C15;
    h ^= h >> 30;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 31;
    // Map to [-40, +40] inclusive.
    let jitter_x100 = (h % 81) as i64 - 40;
    base_x100 += jitter_x100;

    let rating_raw = (base_x100 + 50) / 100; // round-half-up to nearest star
    let rating = rating_raw.clamp(1, 5) as u32;
    // Phase 9.6 / 9.53 — a guest who stormed out UNSERVED (never got a
    // plate, total_paid == 0) is pinned to 1★: the vibe math scores the
    // ambience, but they never tasted the food, so a maxed-out room
    // shouldn't collect 5★ from angry walkouts.
    //
    // Phase 9.53 — but DON'T pin a guest who actually ate + paid. The
    // old code also forced 1★ on `patience_ms <= 0`, which fired for
    // any multi-course guest whose patience happened to hit 0 on a
    // later course (a slow plate, table churn) — erasing an otherwise
    // good meal. That single condition is why a restaurant serving 81%
    // of its guests still read 1.0 avg / 500-of-500 one-star: nearly
    // every paying customer tripped the patience pin. A served customer
    // now gets the REAL satisfaction-based rating; only the truly
    // unserved are forced to 1★.
    let rating = if g.total_paid_cents == 0 { 1 } else { rating };

    // tipMultByRating: 1 → 0%, 2 → 0%, 3 → 5%, 4 → 15%, 5 → 30%.
    // Stored × 1000 (basis points scaled by 10) for integer math.
    let tip_rate_per_mille: i64 = match rating {
        3 => 50,
        4 => 150,
        5 => 300,
        _ => 0,
    };
    // Phase 6.2 — archetype × weather tip multipliers.  Mirrors the
    // client's `g.totalPaid * baseTipRate * g.archetype.tipMultiplier
    // * weatherMult` formula at GuestSpawner.finalizeVisit. Both
    // multipliers exist on the cloud already — archetype tip_mult_x100
    // is seeded by H.38's set_customer_archetype reducer at boot;
    // weather kind sits on weather_state and changes every ~8 minutes
    // via the weather_roll scheduled tick. Defaults to 1.0× if the
    // archetype row hasn't been seeded or the weather row hasn't
    // landed yet — keeps the tip math monotonic during the brief
    // window after a fresh restart.
    let archetype_tip_mult_x100: i64 = ctx.db.customer_archetype()
        .archetype_id().find(g.archetype.clone())
        .map(|a| a.tip_mult_x100 as i64)
        .unwrap_or(100);
    let weather_tip_mult_x100: i64 = ctx.db.weather_state().id().find(1u32)
        .map(|w| weather_tip_mult_x100(&w.kind))
        .unwrap_or(100);
    // Integer math:
    //   tip = totalPaid × tipRatePerMille × archetypeMult × weatherMult
    //         ÷ 1000 (rate scaling) ÷ 100 (archetype x100) ÷ 100 (weather x100)
    // Compose in two divides to avoid an i64 overflow when totalPaid is
    // large and both mults are at their max (≈3.0 × 1.25 = 3.75×).
    let tip_pre_mults = g.total_paid_cents.saturating_mul(tip_rate_per_mille) / 1_000;
    let tip_after_archetype = tip_pre_mults.saturating_mul(archetype_tip_mult_x100) / 100;
    let tip_cents = tip_after_archetype.saturating_mul(weather_tip_mult_x100) / 100;

    // Read-modify-write the Restaurant row. If the row disappeared
    // (sell-mid-flight), skip silently.
    let Some(r) = ctx.db.restaurant().id().find(g.restaurant_id) else { return; };

    // Phase H Phase 2b — accumulate meal revenue (g.total_paid_cents)
    // for offline owners. Foreground clients already credit meal
    // price per course via local creditCourse → economy.earnMoney,
    // so accumulating here when the owner is ONLINE would
    // double-credit on reconnect.
    //
    // Phase H Phase 2c — same exact double-credit shape applies to
    // tips. Local finalizeVisit fires economy.earnMoney(tip) on
    // visit completion when the owner is online; adding the same
    // tip to pending_tips_cents here would re-credit it via
    // applyPendingVisitRollup on the next reconnect (pending
    // counters don't drain inside a single session — consume only
    // fires from onSubscriptionReady). Gate both tip + revenue
    // accumulation on owner_online.
    const OFFLINE_THRESHOLD_MICROS: i64 = 30_000_000;
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let owner_online = ctx.db.player().identity().find(r.owner)
        .map(|pl| (now_micros - pl.last_seen_at.to_micros_since_unix_epoch()) < OFFLINE_THRESHOLD_MICROS)
        .unwrap_or(false);
    // Phase 7.8 — Cloud writes ALWAYS fire. The foreground client no
    // longer credits tip/revenue/rating locally (creditCourse,
    // finalizeVisit, applyAngryLeave all skip those calls when
    // serverOwnsGuestStates is on); the server's accumulate is the
    // ONLY writer for cloud_money_cents from visit completion. The
    // delta-based cloud_money sync (Phase 7.7) carries the change to
    // the foreground client via subscription.
    let added_tip = tip_cents;
    let added_revenue = g.total_paid_cents;
    // angry-leave signal: guest left with no course credited. See
    // Phase 6.4 + 6.4-fix discussion for the total_paid_cents == 0
    // discriminator. Stays gated on `pending_active` below so the
    // PENDING_LOST counter only bumps for despawns the foreground
    // client didn't account for.
    let is_angry_leave: bool = g.total_paid_cents == 0;
    // Phase 7.8 — Pending counter writes are gated on `!dishes_settled`
    // (which the foreground client sets via markGuestDishesSettled
    // before despawn). For online play, dishes_settled=true on every
    // despawn → pending_* stays at 0 → reconnect drain is a no-op
    // for these guests. For offline play (or any path where the
    // foreground didn't run), dishes_settled=false → pending_*
    // accrues as before for reconnect drain.
    let pending_active = !g.dishes_settled;
    let pending_tip = if pending_active { added_tip } else { 0 };
    let pending_revenue = if pending_active { added_revenue } else { 0 };
    let pending_lost_inc: u32 = if pending_active && is_angry_leave { 1 } else { 0 };
    let pending_served_inc: u32 = if pending_active { 1 } else { 0 };
    let pending_rating_sum_inc = if pending_active { rating as i64 * 100 } else { 0 };
    let pending_rating_count_inc: u32 = if pending_active { 1 } else { 0 };
    // cloud_daily_lost still mirrors the same "no course credited"
    // signal so visitors see angry-leave counts climb in real time
    // regardless of whether dishes_settled is true.
    let added_daily_lost: u32 = if is_angry_leave { 1 } else { 0 };
    // Kept for the log line + legacy parity with the surrounding
    // variable name. `owner_online` was the pre-7.8 gate.
    let _ = owner_online;

    // Phase 7.1 — Rating cloud-canonical. When the owner is OFFLINE,
    // we append the just-computed rating directly to
    // cloud_rating_history_csv so the foreground client can hydrate
    // its ReputationSystem straight from the CSV on reconnect —
    // without the legacy "drain pending_rating × N → recordRating(avg)
    // N times" loop that slammed the local rating after every long
    // offline period. Foreground (owner_online=true) skips this path
    // because Game.reputation.recordRating already pushes the freshly
    // computed rating via setCloudRatingHistory, and the cloud CSV is
    // already authoritative there.
    //
    // Capped at MAX_RATING_HISTORY_ENTRIES (matches the client's
    // maxRatingHistory in ReputationSystem.ts) so the column stays
    // under the 1KB target. The cap acts as a sliding window: we drop
    // the oldest entry when the list exceeds the cap, mirroring the
    // client's `.slice(-maxRatingHistory)` behaviour.
    const MAX_RATING_HISTORY_ENTRIES: usize = 500;
    // Phase 7.8 — Always append. The foreground client no longer
    // calls recordRating locally for visits (Phase 7.8 step 3); the
    // cloud_rating_history_csv subscription handler picks up our
    // append and hydrates the local ratingHistory within ~50ms.
    let next_rating_csv: Option<String> = {
        let prev = r.cloud_rating_history_csv.as_deref().unwrap_or("");
        let mut entries: Vec<&str> = if prev.is_empty() {
            Vec::new()
        } else {
            prev.split(',').collect()
        };
        let rating_str = rating.to_string();
        entries.push(&rating_str);
        if entries.len() > MAX_RATING_HISTORY_ENTRIES {
            let excess = entries.len() - MAX_RATING_HISTORY_ENTRIES;
            entries.drain(0..excess);
        }
        Some(entries.join(","))
    };

    // Phase 7.8 — Cloud writes ALWAYS fire (no owner_online gate).
    // Pending writes are gated on `pending_active` (= !dishes_settled).
    let added_daily_revenue = added_tip.saturating_add(added_revenue);
    let added_daily_served: u32 = 1;

    let rollup_rid = r.id;
    let rollup_old_balance = r.cloud_money_cents;
    ctx.db.restaurant().id().update(Restaurant {
        // ── Pending counters (foreground client drains on reconnect) ──
        pending_served: r.pending_served.saturating_add(pending_served_inc),
        pending_tips_cents: r.pending_tips_cents.saturating_add(pending_tip),
        pending_revenue_cents: r.pending_revenue_cents.saturating_add(pending_revenue),
        pending_rating_sum_x100: r.pending_rating_sum_x100.saturating_add(pending_rating_sum_inc),
        pending_rating_count: r.pending_rating_count.saturating_add(pending_rating_count_inc),
        pending_lost: r.pending_lost.saturating_add(pending_lost_inc),
        // ── Cloud-canonical writes (always-on; foreground client adopts
        //    via Phase 7.7's delta sync + cloud_rating_history sub) ──
        cloud_money_cents: r.cloud_money_cents.saturating_add(added_tip + added_revenue),
        cloud_rating_history_csv: next_rating_csv,
        cloud_daily_revenue_cents: r.cloud_daily_revenue_cents.saturating_add(added_daily_revenue),
        cloud_daily_served: r.cloud_daily_served.saturating_add(added_daily_served),
        cloud_daily_lost: r.cloud_daily_lost.saturating_add(added_daily_lost),
        // Phase 9.54 — today's tips (tip portion only) for the HUD card.
        cloud_daily_tips_cents: r.cloud_daily_tips_cents.saturating_add(added_tip),
        ..r
    });
    // Ledger — split the credit into a meal-sale line + a tip line.
    if added_revenue > 0 {
        record_money_event(ctx, rollup_rid, "sale", added_revenue, rollup_old_balance + added_revenue);
    }
    if added_tip > 0 {
        record_money_event(ctx, rollup_rid, "tip", added_tip, rollup_old_balance + added_revenue + added_tip);
    }
    log::info!(
        "accumulate_pending_visit_rollup: guest {} → restaurant {} (rating={}, tip={} cents, revenue={} cents, angry={}, pending_active={})",
        g.id, g.restaurant_id, rating, added_tip, added_revenue, is_angry_leave, pending_active,
    );
}

/// Phase H.31 — Delta-based dishware mirror. Each client mutation on
/// Game.dishware (reserveOne, markDirty, washOne, addClean) pushes a
/// (kind, tier, clean_delta, dirty_delta) tuple. The server adds
/// the deltas to the matching dishware_pool row (saturating on
/// underflow), inserts the row if it doesn't exist, and deletes it
/// when both counts hit zero — matching update_dishware_pool's
/// delete-on-empty semantics.
///
/// Crucially this lets H.21's opportunistic server wash loader
/// contribute to dishware_pool without being clobbered by the
/// client's next absolute mirror — both sides additively contribute
/// instead of overwriting.
///
/// The older absolute-write update_dishware_pool reducer is kept for
/// Phase H.36 — delta-based mirror for pantry stock. Client's
/// CookingSystem fires this on every consumeIngredients (delta = -1
/// per ingredient slot) and addPantryStock (delta = +qty per slot).
/// The server's pantry_stock table accumulates a live cross-device
/// view of ingredient counts; visit mode + leaderboard + co-owner
/// reads see the player's real stock instead of waiting for the
/// periodic save_snapshot.
///
/// Saturating math on underflow; deletes the row when quantity
/// reaches 0 (delete-on-empty mirrors dishware_pool semantics).
/// Owner-only. Idempotent for delta = 0.
///
/// Server-side consumption on backgrounded ticket claim (closing the
/// "cheating" loophole) is a follow-up — H.37 adds a recipe →
/// ingredient lookup so H.6 can decrement on its own.
#[reducer]
pub fn bump_pantry_stock(
    ctx: &ReducerContext,
    restaurant_id: u64,
    ingredient_id: String,
    delta: i32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can bump pantry stock".into());
    }
    if delta == 0 { return Ok(()); }
    if ingredient_id.is_empty() {
        return Err("ingredient_id required".into());
    }
    let key = format!("{}:{}", restaurant_id, ingredient_id);
    let existing = ctx.db.pantry_stock().key().find(key.clone());
    let cur = existing.as_ref().map(|p| p.quantity).unwrap_or(0u32);
    let new_qty = if delta >= 0 {
        cur.saturating_add(delta as u32)
    } else {
        cur.saturating_sub((-delta) as u32)
    };
    // Phase 7.3 — Keep the row even at quantity=0. Previously this
    // path deleted the row outright, which made OUT ingredients
    // invisible to try_dispatch_errand_trip (the dispatcher iterates
    // pantry_stock and never saw deleted rows → never restocked
    // depleted ingredients → kitchen stayed empty → guests left angry
    // offline → rating crash). The local CookingSystem.pantry keeps
    // qty=0 entries, so matching that here also closes the
    // server-vs-client semantics drift on stock state.
    //
    // The table-bloat concern (Spacetime row count) is a non-issue
    // here: pantry_stock is bounded by the ingredient catalog size
    // (~50 entries) per restaurant, regardless of how many
    // restock+empty cycles run.
    let row = PantryStock {
        key,
        restaurant_id,
        ingredient_id,
        quantity: new_qty,
    };
    if existing.is_some() {
        ctx.db.pantry_stock().key().update(row);
    } else {
        ctx.db.pantry_stock().insert(row);
    }
    Ok(())
}

/// SELL-BACK — Owner sells excess pantry ingredients back to the
/// supplier at 50% of the catalog unit cost.  `units` is clamped to
/// the current pantry_stock quantity; the refund is credited to
/// cloud_money_cents server-side (money is SERVER-authoritative —
/// the client's Phase 7.7 restaurant.onUpdate delta-sync adopts the
/// credit, so the client must NOT earn locally).  The stock row is
/// KEPT at quantity=0 rather than deleted — Phase 7.3 semantics, so
/// OUT ingredients stay visible to try_dispatch_errand_trip.
///
/// Ingredients with no ingredient_cost row sell for 0 cents (stock
/// still decrements) — the same graceful-degradation pattern
/// try_restock_pantry / try_dispatch_errand_trip use for pricing.
#[reducer]
pub fn sell_pantry_stock(
    ctx: &ReducerContext,
    restaurant_id: u64,
    ingredient_id: String,
    units: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can sell pantry stock".into());
    }
    if ingredient_id.is_empty() {
        return Err("ingredient_id required".into());
    }
    if units == 0 { return Ok(()); }
    let key = format!("{}:{}", restaurant_id, ingredient_id);
    let Some(stock) = ctx.db.pantry_stock().key().find(key) else {
        return Ok(()); // no row — nothing to sell, silent no-op
    };
    let sold = units.min(stock.quantity);
    if sold == 0 { return Ok(()); } // shelf already empty
    let remaining = stock.quantity - sold;
    ctx.db.pantry_stock().key().update(PantryStock {
        quantity: remaining,
        ..stock
    });
    // Unit price from the seeded ingredient_cost catalog (cents).
    let unit_cost = ctx.db.ingredient_cost().ingredient_id().find(ingredient_id.clone())
        .map(|c| c.cost_cents)
        .unwrap_or(0);
    let refund_cents = unit_cost.max(0).saturating_mul(sold as i64) / 2;
    if refund_cents > 0 {
        ctx.db.restaurant().id().update(Restaurant {
            cloud_money_cents: r.cloud_money_cents.saturating_add(refund_cents),
            ..r
        });
    }
    log::info!(
        "sell_pantry_stock: restaurant {} sold {} × {} for {} cents (50% of {} c/unit), {} left",
        restaurant_id, sold, ingredient_id, refund_cents, unit_cost, remaining,
    );
    Ok(())
}

/// Phase H.37 — Client seeds the recipe_ingredients lookup at boot,
/// one row per RecipeDefinition in src/data/recipes.ts. Idempotent
/// upsert — repeated calls with the same content are a no-op.
///
/// `ingredients` is pipe-separated to allow duplicates (a recipe that
/// needs 2 tomatoes shows up as "tomato|tomato"). Empty string is
/// allowed for catalog-edge-case recipes with no ingredients.
///
/// Public table so any client can read it; only writeable by any
/// authenticated player (sender check is presence, not ownership —
/// any logged-in browser can seed since the catalog is static and
/// the data is non-malicious). A future hardening pass could
/// restrict this to admins, but that's premature for a stable
/// catalog.
#[reducer]
pub fn set_recipe_ingredients(
    ctx: &ReducerContext,
    recipe_id: String,
    ingredients: String,
) -> Result<(), String> {
    // Any authenticated identity can seed; zero identity rejected.
    let zero = spacetimedb::Identity::__dummy();
    if ctx.sender == zero {
        return Err("Must be authenticated".into());
    }
    if recipe_id.is_empty() || recipe_id.len() > 64 {
        return Err("recipe_id must be 1-64 chars".into());
    }
    if ingredients.len() > 256 {
        return Err("ingredients string too long".into());
    }
    let existing = ctx.db.recipe_ingredients().recipe_id().find(recipe_id.clone());
    if let Some(r) = &existing {
        if r.ingredients == ingredients {
            return Ok(()); // idempotent
        }
    }
    // Phase A1 — admin gate (global catalog; see set_recipe_meta). A
    // legit re-seed of identical data returns Ok above; an actual change
    // to the shared catalog is the admin's call.
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Recipe catalog changes are admin-only".into());
    }
    let row = RecipeIngredients { recipe_id, ingredients };
    if existing.is_some() {
        ctx.db.recipe_ingredients().recipe_id().update(row);
    } else {
        ctx.db.recipe_ingredients().insert(row);
    }
    Ok(())
}

/// Phase H.40 — Seed full per-recipe metadata (sibling to H.37's
/// recipe_ingredients). Idempotent upsert; any authenticated identity
/// may seed (catalog data, same rationale as set_recipe_ingredients).
#[reducer]
pub fn set_recipe_meta(
    ctx: &ReducerContext,
    recipe_id: String,
    base_cook_seconds_ms: i64,
    appliance: String,
    sell_price_cents: i64,
    satisfaction_x100_base: i32,
    category: String,
    tier: u32,
) -> Result<(), String> {
    let zero = spacetimedb::Identity::__dummy();
    if ctx.sender == zero { return Err("Must be authenticated".into()); }
    if recipe_id.is_empty() || recipe_id.len() > 64 {
        return Err("recipe_id must be 1-64 chars".into());
    }
    let existing = ctx.db.recipe_meta().recipe_id().find(recipe_id.clone());
    if let Some(r) = &existing {
        if r.base_cook_seconds_ms == base_cook_seconds_ms
            && r.appliance == appliance
            && r.sell_price_cents == sell_price_cents
            && r.satisfaction_x100_base == satisfaction_x100_base
            && r.category == category
            && r.tier == tier {
            return Ok(()); // idempotent
        }
    }
    // Phase A1 — admin gate. recipe_meta is GLOBAL and feeds
    // total_paid_cents (sales income) for EVERY restaurant, yet this
    // reducer accepted a price from any authenticated client — a
    // cross-player money-print / grief hole. A legit client re-seeding
    // the SAME values returned Ok above (idempotent); only an actual
    // CHANGE to the shared catalog reaches here, and that's the admin's
    // (Dunnin's) call, not any player's.
    let caller_is_admin = ctx.db.auth_record().identity().filter(ctx.sender)
        .any(|a| a.is_admin);
    if !caller_is_admin {
        return Err("Recipe catalog changes are admin-only".into());
    }
    let row = RecipeMeta {
        recipe_id,
        base_cook_seconds_ms,
        appliance,
        sell_price_cents,
        satisfaction_x100_base,
        category,
        tier,
    };
    if existing.is_some() {
        ctx.db.recipe_meta().recipe_id().update(row);
    } else {
        ctx.db.recipe_meta().insert(row);
    }
    Ok(())
}

/// Phase H.53 — Client mirrors a recipe's per-restaurant upgrade
/// level (1..maxRecipeUpgradeLevel).  Owner-only.  Idempotent on
/// identical level.
#[reducer]
pub fn set_recipe_level(
    ctx: &ReducerContext,
    restaurant_id: u64,
    recipe_id: String,
    level: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set a recipe level".into());
    }
    if recipe_id.is_empty() || recipe_id.len() > 64 {
        return Err("recipe_id must be 1-64 chars".into());
    }
    let clamped = level.max(1);
    let key = format!("{}:{}", restaurant_id, recipe_id);
    let existing = ctx.db.recipe_level().key().find(key.clone());
    if let Some(e) = &existing {
        if e.level == clamped { return Ok(()); }
    }
    let row = RecipeLevel {
        key,
        restaurant_id,
        recipe_id,
        level: clamped,
    };
    if existing.is_some() {
        ctx.db.recipe_level().key().update(row);
    } else {
        ctx.db.recipe_level().insert(row);
    }
    Ok(())
}

/// Path B — Prepared-servings mirror. Upserts the count of cook-ahead
/// dishes sitting on the pass for one recipe; count 0 DELETES the row
/// (matching the client's `delete preparedServings[id]` at zero).
/// CookingSystem fires this on every preparedServings mutation so a
/// reload mid-service no longer loses the prepped dishes. Owner-only.
/// Idempotent on identical counts. Same composite-key idiom as
/// pantry_stock / recipe_level.
#[reducer]
pub fn set_prepared_serving(
    ctx: &ReducerContext,
    restaurant_id: u64,
    recipe_id: String,
    count: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set prepared servings".into());
    }
    if recipe_id.is_empty() || recipe_id.len() > 64 {
        return Err("recipe_id must be 1-64 chars".into());
    }
    let key = format!("{}:{}", restaurant_id, recipe_id);
    let existing = ctx.db.prepared_serving().key().find(key.clone());
    if count == 0 {
        if existing.is_some() {
            ctx.db.prepared_serving().key().delete(key);
        }
        return Ok(());
    }
    if let Some(e) = &existing {
        if e.count == count {
            return Ok(());
        }
    }
    let row = PreparedServing {
        key,
        restaurant_id,
        recipe_id,
        count,
    };
    if existing.is_some() {
        ctx.db.prepared_serving().key().update(row);
    } else {
        ctx.db.prepared_serving().insert(row);
    }
    Ok(())
}

/// Phase H.40 — Client mirrors the active menu when the player
/// toggles recipes on/off. Owner-only since this is per-restaurant
/// state (unlike recipe_meta / archetype catalogs which are global).
#[reducer]
pub fn set_active_menu(
    ctx: &ReducerContext,
    restaurant_id: u64,
    recipe_ids: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set the active menu".into());
    }
    let existing = ctx.db.active_menu().restaurant_id().find(restaurant_id);
    if let Some(m) = &existing {
        if m.recipe_ids == recipe_ids { return Ok(()); }
    }
    let row = ActiveMenu { restaurant_id, recipe_ids };
    if existing.is_some() {
        ctx.db.active_menu().restaurant_id().update(row);
    } else {
        ctx.db.active_menu().insert(row);
    }
    Ok(())
}

/// Phase H.40 — Build a default 1-3 course order for a server-spawned
/// guest. Picks recipes from the restaurant's active_menu, weighted
/// by category (1 main is always picked, plus optional appetizer +
/// dessert based on the per-spawn hash).
///
/// Returns the parallel CSVs (recipes, appliances, cook_seconds_ms,
/// prices_cents, satisfactions_x100) ready to stamp on the new
/// active_guest row.  Empty tuple of empty strings on bail
/// (no menu set, no meta seeded, etc.) — caller leaves order_recipes
/// empty and the guest sits in ordering until patience timeout, the
/// pre-H.40 behavior.
fn build_server_order(
    ctx: &ReducerContext,
    restaurant_id: u64,
    hash: u64,
) -> (String, String, String, String, String) {
    let empty = (String::new(), String::new(), String::new(), String::new(), String::new());
    let menu = match ctx.db.active_menu().restaurant_id().find(restaurant_id) {
        Some(m) => m,
        None => return empty,
    };
    let menu_ids: Vec<&str> = menu.recipe_ids
        .split(',')
        .filter(|s| !s.is_empty())
        .collect();
    if menu_ids.is_empty() { return empty; }

    // Pull RecipeMeta for each menu id; bucket by category.  Skip
    // entries with no meta seeded (graceful fallback).
    let mut by_cat: std::collections::HashMap<String, Vec<RecipeMeta>> = std::collections::HashMap::new();
    for id in &menu_ids {
        if let Some(m) = ctx.db.recipe_meta().recipe_id().find(id.to_string()) {
            by_cat.entry(m.category.clone()).or_default().push(m);
        }
    }
    // Need at least one "main" or "drink" to anchor the order.
    let anchor_cat = if by_cat.contains_key("main") { "main" }
        else if by_cat.contains_key("drink") { "drink" }
        else if !by_cat.is_empty() {
            // Fallback: pick whatever category we do have.
            // Determinism via sorted iteration so resume produces
            // the same anchor.
            let mut keys: Vec<&String> = by_cat.keys().collect();
            keys.sort();
            // Borrow the static via a clone-into-Option dance —
            // can't return a &str into a string we don't own.
            // Just convert to owned and use String everywhere below.
            let key = keys[0].clone();
            return build_order_from_anchor(ctx, restaurant_id, &by_cat, &key, hash);
        }
        else { return empty; };
    build_order_from_anchor(ctx, restaurant_id, &by_cat, anchor_cat, hash)
}

/// Phase H.53 — TIER_BASE_PROFIT in cents.  MUST match the client's
/// TIER_BASE_PROFIT in Game.ts. Phase 9.56 — per-tier step softened to
/// $0.50 (was $1.00): [0, 3, 3.5, 4, 4.5, 5] × 100. Indexed by recipe
/// tier (1..5); tier 0 is a degenerate "unknown" with no profit bonus.
const TIER_BASE_PROFIT_CENTS: [i64; 6] = [0, 300, 350, 400, 450, 500];

/// Phase H.53 — Satisfaction bonus per upgrade level, × 100.
/// Matches the client's UPGRADE_SATISFACTION_PER_LEVEL = 1.5.
const UPGRADE_SATISFACTION_PER_LEVEL_X100: i32 = 150;

/// Phase H.53 — Look up a recipe's upgrade level for a given
/// restaurant.  Returns 1 (base) when no row exists — same default
/// as the client's getRecipeUpgradeLevel.
fn recipe_level_for(ctx: &ReducerContext, restaurant_id: u64, recipe_id: &str) -> u32 {
    let key = format!("{}:{}", restaurant_id, recipe_id);
    ctx.db.recipe_level().key().find(key).map(|r| r.level.max(1)).unwrap_or(1)
}

/// Helper for build_server_order: assemble the 1-3 course order
/// given a chosen anchor category. ~30% chance of an appetizer,
/// ~30% chance of a dessert, randomly added.
///
/// H.53 — applies per-restaurant per-recipe upgrade-level bonuses
/// to both price (linear in tier × level) and satisfaction (linear
/// in level only).  Mirrors Game.getEffectiveSellPrice +
/// getEffectiveSatisfaction on the client.
fn build_order_from_anchor(
    ctx: &ReducerContext,
    restaurant_id: u64,
    by_cat: &std::collections::HashMap<String, Vec<RecipeMeta>>,
    anchor_cat: &str,
    hash: u64,
) -> (String, String, String, String, String) {
    let mut courses: Vec<&RecipeMeta> = Vec::new();
    // Appetizer roll first (so it lands before the main if added).
    if by_cat.contains_key("appetizer") && ((hash >> 8) % 10) < 3 {
        let bucket = &by_cat["appetizer"];
        if !bucket.is_empty() {
            courses.push(&bucket[((hash >> 16) as usize) % bucket.len()]);
        }
    }
    // Anchor (main / drink / etc).
    if let Some(bucket) = by_cat.get(anchor_cat) {
        if !bucket.is_empty() {
            courses.push(&bucket[((hash >> 24) as usize) % bucket.len()]);
        }
    }
    // Dessert roll last.
    if by_cat.contains_key("dessert") && ((hash >> 32) % 10) < 3 {
        let bucket = &by_cat["dessert"];
        if !bucket.is_empty() {
            courses.push(&bucket[((hash >> 40) as usize) % bucket.len()]);
        }
    }
    if courses.is_empty() {
        return (String::new(), String::new(), String::new(), String::new(), String::new());
    }
    let recipes: Vec<String> = courses.iter().map(|c| c.recipe_id.clone()).collect();
    let appliances: Vec<String> = courses.iter().map(|c| c.appliance.clone()).collect();
    let cooks: Vec<String> = courses.iter().map(|c| c.base_cook_seconds_ms.to_string()).collect();
    // H.53 — apply upgrade-level price and satisfaction bonuses
    // per course.  Mirrors the client's effective formulas:
    //   price = base + (level - 1) × TIER_BASE_PROFIT[tier] / 2   (9.56)
    //   sat   = base + (level - 1) × 1.5  (× 100 here)
    // Phase 9.56 — recipe upgrades now add +50% of L1 profit per level
    // (was +100%), so the per-level bonus is HALF the tier base profit.
    let prices: Vec<String> = courses.iter().map(|c| {
        let level = recipe_level_for(ctx, restaurant_id, &c.recipe_id);
        let tier_idx = (c.tier as usize).min(TIER_BASE_PROFIT_CENTS.len() - 1);
        let bonus_per_level = TIER_BASE_PROFIT_CENTS[tier_idx] / 2;
        let effective = c.sell_price_cents.saturating_add(
            ((level as i64) - 1).saturating_mul(bonus_per_level),
        );
        effective.max(0).to_string()
    }).collect();
    let sats: Vec<String> = courses.iter().map(|c| {
        let level = recipe_level_for(ctx, restaurant_id, &c.recipe_id);
        let bonus = ((level as i32) - 1).saturating_mul(UPGRADE_SATISFACTION_PER_LEVEL_X100);
        let effective = c.satisfaction_x100_base.saturating_add(bonus);
        effective.max(0).to_string()
    }).collect();
    (
        recipes.join(","),
        appliances.join(","),
        cooks.join(","),
        prices.join(","),
        sats.join(","),
    )
}

/// Phase H.38 — Client seeds the customer_archetype catalog at boot.
/// Idempotent upsert; repeated identical calls are a no-op.  Catalog
/// data, not per-player; any authenticated identity may seed (matches
/// set_recipe_ingredients's rationale).
#[reducer]
pub fn set_customer_archetype(
    ctx: &ReducerContext,
    archetype_id: String,
    weight: u32,
    patience_mult_x100: i32,
    tip_mult_x100: i32,
    order_size_bias: i32,
    wc_use_chance_x100: i32,
) -> Result<(), String> {
    let zero = spacetimedb::Identity::__dummy();
    if ctx.sender == zero {
        return Err("Must be authenticated".into());
    }
    if archetype_id.is_empty() || archetype_id.len() > 32 {
        return Err("archetype_id must be 1-32 chars".into());
    }
    let existing = ctx.db.customer_archetype().archetype_id().find(archetype_id.clone());
    if let Some(r) = &existing {
        if r.weight == weight
            && r.patience_mult_x100 == patience_mult_x100
            && r.tip_mult_x100 == tip_mult_x100
            && r.order_size_bias == order_size_bias
            && r.wc_use_chance_x100 == wc_use_chance_x100 {
            return Ok(()); // idempotent
        }
    }
    // Phase A1 — admin gate (global catalog; see set_recipe_meta).
    // tip_mult_x100 feeds tip income, so an ungated change was a
    // cross-player money lever. An idempotent re-seed passes above.
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Customer archetype catalog is admin-only".into());
    }
    let row = CustomerArchetypeDef {
        archetype_id,
        weight,
        patience_mult_x100,
        tip_mult_x100,
        order_size_bias,
        wc_use_chance_x100,
    };
    if existing.is_some() {
        ctx.db.customer_archetype().archetype_id().update(row);
    } else {
        ctx.db.customer_archetype().insert(row);
    }
    Ok(())
}

/// Phase H.38 — Pick a weighted-random archetype's fields from the
/// catalog. Returns a 4-tuple of (archetype_id, patience_mult_x100,
/// wc_use_chance_x100, order_size_bias). Falls back to "regular"
/// defaults if the catalog hasn't been seeded yet.
///
/// `hash` is a per-spawn random value the caller already computed
/// (see try_spawn_arrival_guest's splitmix64 step) — keeping the RNG
/// deterministic per guest id so Workflow resume produces the same
/// archetype on re-run.
///
/// Returns a value tuple rather than the row itself because the
/// SpacetimeDB table struct doesn't derive Clone; we just extract
/// the fields we need while we still own the iterator's items.
fn pick_archetype(ctx: &ReducerContext, hash: u64) -> (String, i32, i32, i32) {
    // First pass: compute total weight + collect just (id, weight)
    // pairs so we can find which slot the hash lands in.
    let mut total_weight: u64 = 0;
    let pairs: Vec<(String, u32)> = ctx.db.customer_archetype().iter()
        .map(|a| {
            total_weight += a.weight as u64;
            (a.archetype_id, a.weight)
        })
        .collect();
    if pairs.is_empty() || total_weight == 0 {
        return ("regular".to_string(), 100, 40, 0);
    }
    let mut pick = hash % total_weight;
    let mut chosen_id: String = pairs[pairs.len() - 1].0.clone();
    for (id, w) in &pairs {
        if (*w as u64) > pick { chosen_id = id.clone(); break; }
        pick -= *w as u64;
    }
    // Second pass: look up the chosen archetype's full row.
    let row = ctx.db.customer_archetype().archetype_id().find(chosen_id.clone());
    match row {
        Some(r) => (r.archetype_id, r.patience_mult_x100, r.wc_use_chance_x100, r.order_size_bias),
        None => (chosen_id, 100, 40, 0),
    }
}

/// Phase H.37 — Look up a recipe's ingredient list. Returns an empty
/// vec for unseeded recipes (graceful degradation — server-side
/// consumption silently no-ops until the client seeds, instead of
/// blocking ticket creation for unknown recipes).
fn lookup_recipe_ingredients(ctx: &ReducerContext, recipe_id: &str) -> Vec<String> {
    let Some(r) = ctx.db.recipe_ingredients().recipe_id().find(recipe_id.to_string()) else {
        return Vec::new();
    };
    r.ingredients
        .split('|')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Phase H.37 — Check that the restaurant has at least 1 unit of each
/// ingredient. Returns true iff every required ingredient has stock.
fn pantry_has_all(
    ctx: &ReducerContext,
    restaurant_id: u64,
    ingredients: &[String],
) -> bool {
    for ing in ingredients {
        let key = format!("{}:{}", restaurant_id, ing);
        let cur = ctx.db.pantry_stock().key().find(key)
            .map(|p| p.quantity)
            .unwrap_or(0);
        if cur == 0 { return false; }
    }
    true
}

/// Phase H.37 — Decrement 1 unit of each listed ingredient from
/// pantry_stock. Caller is expected to have already verified
/// availability via pantry_has_all (no rollback on partial failure).
fn pantry_consume(
    ctx: &ReducerContext,
    restaurant_id: u64,
    ingredients: &[String],
) {
    for ing in ingredients {
        let key = format!("{}:{}", restaurant_id, ing);
        if let Some(p) = ctx.db.pantry_stock().key().find(key) {
            let new_qty = p.quantity.saturating_sub(1);
            // Phase 7.3 — Keep the row at quantity=0 (don't delete) so
            // try_dispatch_errand_trip can see OUT ingredients and
            // restock them. Was previously deleting at zero, which
            // hid empties from the dispatcher.
            ctx.db.pantry_stock().key().update(PantryStock {
                quantity: new_qty,
                ..p
            });
        }
    }
}

// === H.41 — Server-side just-in-time auto-shop =====================
//
// Closes the last gameplay-correctness gap exposed by H.36 + H.37:
// once the server starts consuming ingredients on backgrounded
// ticket placement, a long-idle owner's kitchen would eventually
// run dry and stall.  Foreground play already has an "auto-shop"
// fallback in EconomySystem.shopForMissing that buys missing
// ingredients on-demand and debits the player; we mirror that here.
//
// Wire:
//   1. Client seeds ingredient_cost catalog at boot (mirrors
//      INGREDIENT_COSTS in src/data/ingredients.ts).
//   2. auto_place_next_course sees pantry_has_all() == false.
//   3. try_restock_pantry is called — for each missing ingredient
//      it adds RESTOCK_UNITS units to pantry_stock and accrues
//      RESTOCK_UNITS × ingredient_cost.cost_cents to
//      Restaurant.pending_restock_cost_cents.
//   4. pantry_has_all is re-checked; on success the ticket is
//      placed normally (and pantry_consume decrements 1 unit per
//      ingredient as before).
//   5. On the owner's next reconnect, the client reads
//      pending_restock_cost_cents, debits via
//      forceSpendMoney("restock"), and fires
//      consume_pending_restock_cost to zero it.

/// How many units of each missing ingredient to auto-restock.
/// Matches the foreground shopForMissing default (5 units).
const RESTOCK_UNITS: u32 = 5;

/// Phase H.41 — Client seeds the ingredient cost catalog at boot
/// from src/data/ingredients.ts.  Idempotent upsert; repeated
/// identical calls are a no-op.  Catalog data — any authenticated
/// identity may seed (matches set_recipe_ingredients's rationale).
#[reducer]
pub fn set_ingredient_cost(
    ctx: &ReducerContext,
    ingredient_id: String,
    cost_cents: i64,
) -> Result<(), String> {
    let zero = spacetimedb::Identity::__dummy();
    if ctx.sender == zero { return Err("Must be authenticated".into()); }
    if ingredient_id.is_empty() || ingredient_id.len() > 64 {
        return Err("ingredient_id must be 1-64 chars".into());
    }
    if cost_cents < 0 {
        return Err("cost_cents cannot be negative".into());
    }
    let existing = ctx.db.ingredient_cost().ingredient_id().find(ingredient_id.clone());
    if let Some(r) = &existing {
        if r.cost_cents == cost_cents { return Ok(()); } // idempotent
    }
    // Phase A1 — admin gate (global catalog; see set_recipe_meta).
    // Ingredient costs feed both restock spend and the recipe sell
    // price, so an ungated change was a money lever. Idempotent re-seed
    // passes above.
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Ingredient cost catalog is admin-only".into());
    }
    let row = IngredientCost { ingredient_id, cost_cents };
    if existing.is_some() {
        ctx.db.ingredient_cost().ingredient_id().update(row);
    } else {
        ctx.db.ingredient_cost().insert(row);
    }
    Ok(())
}

/// Phase A2 (anti-cheat) — seed the furniture cost catalog. The client
/// seeds at boot from furnitureCatalog.ts (scaledCost per def); the
/// validated place_furniture reducer (Phase B) reads these to price-check
/// a purchase. Idempotent re-seed is open to any client; an actual CHANGE
/// is admin-only (Dunnin), since a player must not set the prices that
/// gate their own purchases.
#[reducer]
pub fn set_furniture_cost(
    ctx: &ReducerContext,
    def_id: String,
    cost_cents: i64,
    refund_cents: i64,
) -> Result<(), String> {
    let zero = spacetimedb::Identity::__dummy();
    if ctx.sender == zero { return Err("Must be authenticated".into()); }
    if def_id.is_empty() || def_id.len() > 64 {
        return Err("def_id must be 1-64 chars".into());
    }
    if cost_cents < 0 || refund_cents < 0 {
        return Err("costs cannot be negative".into());
    }
    let existing = ctx.db.furniture_cost().def_id().find(def_id.clone());
    if let Some(r) = &existing {
        if r.cost_cents == cost_cents && r.refund_cents == refund_cents { return Ok(()); } // idempotent
    }
    // Admin gate (see set_recipe_meta). Idempotent re-seed passes above.
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Furniture cost catalog changes are admin-only".into());
    }
    let row = FurnitureCost { def_id, cost_cents, refund_cents };
    if existing.is_some() {
        ctx.db.furniture_cost().def_id().update(row);
    } else {
        ctx.db.furniture_cost().insert(row);
    }
    Ok(())
}

/// Phase 9.62 (anti-cheat) — seed the furniture metadata catalog. The
/// client seeds at boot from furnitureCatalog.ts; the server uses it to
/// compute per-seat taste appeal + the attraction aggregate itself
/// (replacing the old client-computed mirrors). Same gate shape as
/// set_furniture_cost: an idempotent re-seed is open to any client, but
/// an actual CHANGE is admin-only (a player must not be able to inflate
/// their own decor/attraction to game seating + spawn rate).
#[reducer]
pub fn set_furniture_meta(
    ctx: &ReducerContext,
    def_id: String,
    category: String,
    style_x100: i32,
    comfort_x100: i32,
    attraction_x100: i32,
    rating_bonus_x100: i32,
    surface: String,
) -> Result<(), String> {
    let zero = spacetimedb::Identity::__dummy();
    if ctx.sender == zero { return Err("Must be authenticated".into()); }
    if def_id.is_empty() || def_id.len() > 64 {
        return Err("def_id must be 1-64 chars".into());
    }
    let existing = ctx.db.furniture_meta().def_id().find(def_id.clone());
    if let Some(r) = &existing {
        if r.category == category && r.style_x100 == style_x100
            && r.comfort_x100 == comfort_x100 && r.attraction_x100 == attraction_x100
            && r.rating_bonus_x100 == rating_bonus_x100 && r.surface == surface {
            return Ok(()); // idempotent
        }
    }
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Furniture meta catalog changes are admin-only".into());
    }
    let row = FurnitureMeta {
        def_id, category, style_x100, comfort_x100, attraction_x100, rating_bonus_x100, surface,
    };
    if existing.is_some() {
        ctx.db.furniture_meta().def_id().update(row);
    } else {
        ctx.db.furniture_meta().insert(row);
    }
    Ok(())
}

/// Phase 9.62 — server-side per-seat appeal, computed from
/// placed_furniture + furniture_meta. Mirror of the client's
/// GuestSpawner.computeNearbyDecorScore / isSeatWindowAdjacent /
/// surface helpers, moved server-side so seating is fully
/// authoritative. `furn` is the restaurant's furniture pre-collected
/// once by the caller (avoids an O(seats×furniture) re-scan).
struct ApFurn { x: f32, z: f32, floor: u32, is_window: bool, is_decor: bool, is_toilet: bool, quality: f32 }

fn compute_seat_appeal(
    ctx: &ReducerContext,
    furn: &[ApFurn],
    seat_x: f32,
    seat_z: f32,
    floor: u32,
    table_uid: &str,
    at_bar: bool,
) -> (f32, bool, String) {
    let mut decor = 0.0_f32;
    let mut window_adj = false;
    let mut toilet_penalty = 0.0_f32;
    for f in furn {
        if f.floor != floor { continue; }
        let dx = f.x - seat_x;
        let dz = f.z - seat_z;
        let dist_sq = dx * dx + dz * dz;
        if f.is_window && dist_sq < 6.25 { window_adj = true; } // 2.5m
        if f.is_decor && dist_sq <= 36.0 {                      // 6 tiles
            decor += f.quality / (1.0 + dist_sq);
        }
        // Phase 9.68 — nobody wants to dine right next to a toilet.
        // Penalise seats within ~3 tiles of one so guests avoid bathroom-
        // adjacent seats when nicer ones are free (a full house still
        // seats them — scoring only reorders, never excludes).
        if f.is_toilet && dist_sq <= 9.0 {
            toilet_penalty += 40.0 / (1.0 + dist_sq);
        }
    }
    let decor_score = (decor * 4.0 - toilet_penalty).clamp(-50.0, 60.0);
    // Surface: bar seats are drink; else the table's furniture_meta.surface
    // (coffee tables are "drink"); default "food".
    let surface = if at_bar {
        "drink".to_string()
    } else {
        ctx.db.placed_furniture().uid().find(table_uid.to_string())
            .and_then(|t| ctx.db.furniture_meta().def_id().find(t.def_id))
            .map(|m| if m.surface == "drink" { "drink".to_string() } else { "food".to_string() })
            .unwrap_or_else(|| "food".to_string())
    };
    (decor_score, window_adj, surface)
}

/// Phase 9.62 — collect the restaurant's furniture into appeal records
/// once (decor quality + window flag from furniture_meta / def_id), so
/// per-seat scoring is a cheap in-memory scan.
fn collect_appeal_furniture(ctx: &ReducerContext, rid: u64) -> Vec<ApFurn> {
    let mut out = Vec::new();
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        let is_window = f.def_id.starts_with("window") || f.def_id.starts_with("int-window");
        let is_toilet = is_toilet_def(&f.def_id);
        let (is_decor, quality) = match ctx.db.furniture_meta().def_id().find(f.def_id.clone()) {
            Some(m) if m.category == "decoration" || m.category == "plant" || m.category == "lamp" => {
                let q = m.style_x100 as f32 / 100.0 + 10.0 * (m.rating_bonus_x100 as f32 / 100.0);
                (true, q)
            }
            _ => (false, 0.0),
        };
        if !is_window && !is_decor && !is_toilet { continue; }
        out.push(ApFurn { x: f.x, z: f.z, floor: f.floor, is_window, is_decor, is_toilet, quality });
    }
    out
}

/// Anti-cheat B/C (income flow 1/5) — server-authoritative starter grant.
/// Replaces the client's earnMoney+bump (Engine.enterGame / ExpandWidget)
/// with a server credit on a server-enforced 3h cooldown, so a cheater
/// can't reset the localStorage timer to mint grants. Amount is read from
/// the owner's Building plot size (small/medium/large = $1,000/$1,500/$2,000).
/// Idempotent within the cooldown window (silent no-op, not an error) so
/// the client may call it on every enterGame.
#[reducer]
pub fn claim_starter_grant(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can claim the grant".into());
    }
    const GRANT_COOLDOWN_MICROS: i64 = 3 * 60 * 60 * 1_000_000; // 3 h
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    if r.last_grant_micros != 0 && now - r.last_grant_micros < GRANT_COOLDOWN_MICROS {
        return Ok(()); // not due yet — silent no-op
    }
    let bonus_cents: i64 = ctx.db.building().owner_identity().filter(ctx.sender)
        .next()
        .map(|b| match b.kind.as_str() {
            "small" => 100_000,  // $1,000
            "large" => 200_000,  // $2,000
            _ => 150_000,        // $1,500 (medium)
        })
        .unwrap_or(150_000);
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: r.cloud_money_cents.saturating_add(bonus_cents),
        last_grant_micros: now,
        ..r
    });
    if let Some(rr) = ctx.db.restaurant().id().find(restaurant_id) {
        record_money_event(ctx, restaurant_id, "grant", bonus_cents, rr.cloud_money_cents);
    }
    log::info!(
        "claim_starter_grant: restaurant {} granted {} cents (kind-based)",
        restaurant_id, bonus_cents,
    );
    Ok(())
}

/// Anti-cheat B/C (income flow 2/5) — low-balance safety-net grant.
/// Replaces ExpandWidget's earnMoney+localStorage with a server credit
/// gated on the SERVER's balance read + a 24h cooldown, so a cheater
/// can't reset the day-key or fake a low balance to mint $500/claim.
#[reducer]
pub fn claim_low_balance_grant(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can claim the grant".into());
    }
    const THRESHOLD_CENTS: i64 = 50_000; // $500 — matches STARTER_GRANT_THRESHOLD
    const AMOUNT_CENTS: i64 = 50_000;    // $500 — matches STARTER_GRANT_AMOUNT
    const COOLDOWN_MICROS: i64 = 24 * 60 * 60 * 1_000_000; // ~once per day
    if r.cloud_money_cents >= THRESHOLD_CENTS {
        return Ok(()); // not broke — silent no-op
    }
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    if r.last_low_balance_grant_micros != 0
        && now - r.last_low_balance_grant_micros < COOLDOWN_MICROS {
        return Ok(()); // already claimed today
    }
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: r.cloud_money_cents.saturating_add(AMOUNT_CENTS),
        last_low_balance_grant_micros: now,
        ..r
    });
    if let Some(rr) = ctx.db.restaurant().id().find(restaurant_id) {
        record_money_event(ctx, restaurant_id, "grant", AMOUNT_CENTS, rr.cloud_money_cents);
    }
    Ok(())
}

/// Anti-cheat B/C (income flow 3/5) — admin money adjust. The AdminModal
/// dev +/- buttons (Dunnin only) route here. Admin-gated so a regular
/// player can't credit themselves; delta may be negative. DEV OVERRIDE —
/// NOT floored at $0: the no-negative-money floor is for gameplay debits,
/// not the dev tool ("dev tools dictate all").
#[reducer]
pub fn admin_adjust_money(ctx: &ReducerContext, restaurant_id: u64, delta_cents: i64) -> Result<(), String> {
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Admin only".into());
    }
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: r.cloud_money_cents.saturating_add(delta_cents),
        ..r
    });
    if let Some(rr) = ctx.db.restaurant().id().find(restaurant_id) {
        record_money_event(ctx, restaurant_id, "admin", delta_cents, rr.cloud_money_cents);
    }
    Ok(())
}

/// Dev override — admin SETS the exact balance, server-authoritative. "Dev
/// tools dictate all": lets the dev (Dunnin) set/recover any balance directly,
/// bypassing the no-negative floor AND the income lockdown. Admin-gated.
/// The AdminModal "set money" control routes here (the old client-only
/// setMoney was instantly reversed by the cloud_money_cents adoption).
#[reducer]
pub fn admin_set_money(ctx: &ReducerContext, restaurant_id: u64, amount_cents: i64) -> Result<(), String> {
    if !ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin) {
        return Err("Admin only".into());
    }
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: amount_cents,
        ..r
    });
    Ok(())
}

/// Anti-cheat B/C (income flow 4/5) — recycle reward. The client's
/// TrashSpawner auto-recycles an expired piece (~every 9s) for $2; when
/// the money flag is on it calls this instead of earnMoney. Rate-limited
/// to 8s server-side so a spammer can't beat the legit expiry rate.
#[reducer]
pub fn claim_recycle(ctx: &ReducerContext, restaurant_id: u64) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can claim recycle".into());
    }
    const RECYCLE_REWARD_CENTS: i64 = 200; // $2 — matches client RECYCLE_REWARD
    const MIN_INTERVAL_MICROS: i64 = 8_000_000; // 8 s (< 9 s spawn interval)
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    if r.last_recycle_micros != 0 && now - r.last_recycle_micros < MIN_INTERVAL_MICROS {
        return Ok(()); // too soon — silent no-op
    }
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: r.cloud_money_cents.saturating_add(RECYCLE_REWARD_CENTS),
        last_recycle_micros: now,
        ..r
    });
    if let Some(rr) = ctx.db.restaurant().id().find(restaurant_id) {
        record_money_event(ctx, restaurant_id, "recycle", RECYCLE_REWARD_CENTS, rr.cloud_money_cents);
    }
    Ok(())
}

/// Anti-cheat B/C (income flow 5/5) — achievement reward. The unlock
/// condition is client-side and can't be verified server-side, so the
/// reward is client-provided but BOUNDED: clamped per-claim and capped
/// over the restaurant's lifetime (cumulative_achievement_cents), so a
/// cheater can mint at most CUMULATIVE_CAP this way (~the sum of all real
/// achievement rewards).
#[reducer]
pub fn claim_achievement(ctx: &ReducerContext, restaurant_id: u64, reward_cents: i64) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can claim an achievement".into());
    }
    const PER_CLAIM_CAP_CENTS: i64 = 500_000;     // $5,000 per achievement
    const CUMULATIVE_CAP_CENTS: i64 = 10_000_000; // $100k lifetime ceiling
    let amount = reward_cents.clamp(0, PER_CLAIM_CAP_CENTS);
    if amount == 0 || r.cumulative_achievement_cents >= CUMULATIVE_CAP_CENTS {
        return Ok(());
    }
    let credited = amount.min(CUMULATIVE_CAP_CENTS - r.cumulative_achievement_cents);
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: r.cloud_money_cents.saturating_add(credited),
        cumulative_achievement_cents: r.cumulative_achievement_cents.saturating_add(credited),
        ..r
    });
    if let Some(rr) = ctx.db.restaurant().id().find(restaurant_id) {
        record_money_event(ctx, restaurant_id, "achievement", credited, rr.cloud_money_cents);
    }
    Ok(())
}

/// Phase H.41 — Owner-only.  Called by the client on reconnect AFTER
/// it has read Restaurant.pending_restock_cost_cents and debited the
/// player's local money via forceSpendMoney("restock").  Resets the
/// counter to 0 so the same charge isn't applied twice.
///
/// Idempotent — zero counter is a silent no-op.
#[reducer]
pub fn consume_pending_restock_cost(
    ctx: &ReducerContext,
    restaurant_id: u64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can consume pending restock cost".into());
    }
    if r.pending_restock_cost_cents == 0 { return Ok(()); }
    log::info!(
        "consume_pending_restock_cost: restaurant {} drained {} cents",
        restaurant_id, r.pending_restock_cost_cents,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_restock_cost_cents: 0,
        ..r
    });
    Ok(())
}

/// Phase H.41 — For each ingredient with zero stock, add RESTOCK_UNITS
/// units to pantry_stock and bill the cost to
/// Restaurant.pending_restock_cost_cents.  Ingredients that already
/// have stock are skipped (the caller will have come here via
/// pantry_has_all == false, so at least one is empty, but parallel
/// arrays mean some entries may already be satisfied).
///
/// Ingredients with no ingredient_cost row are restocked free (the
/// stock still goes in; we just don't bill).  Mirrors the
/// graceful-degradation pattern in lookup_recipe_ingredients.
fn try_restock_pantry(
    ctx: &ReducerContext,
    restaurant_id: u64,
    needed: &[String],
) {
    let mut accrued_cents: i64 = 0;
    let mut restocked_count: u32 = 0;
    for ing in needed {
        let key = format!("{}:{}", restaurant_id, ing);
        let cur = ctx.db.pantry_stock().key().find(key.clone())
            .map(|p| p.quantity)
            .unwrap_or(0);
        if cur > 0 { continue; }
        // Insert / upsert RESTOCK_UNITS.
        let row = PantryStock {
            key: key.clone(),
            restaurant_id,
            ingredient_id: ing.clone(),
            quantity: RESTOCK_UNITS,
        };
        if ctx.db.pantry_stock().key().find(key.clone()).is_some() {
            ctx.db.pantry_stock().key().update(row);
        } else {
            ctx.db.pantry_stock().insert(row);
        }
        restocked_count += 1;
        // Bill the cost (if catalog row exists for this ingredient).
        let unit_cost = ctx.db.ingredient_cost().ingredient_id().find(ing.clone())
            .map(|c| c.cost_cents)
            .unwrap_or(0);
        if unit_cost > 0 {
            accrued_cents = accrued_cents
                .saturating_add(unit_cost.saturating_mul(RESTOCK_UNITS as i64));
        }
    }
    if restocked_count == 0 { return; }
    // Roll up the cost onto the restaurant row.
    //
    // Phase 7.5 — Also deduct from cloud_money_cents directly so the
    // live cloud balance reflects the cost paid. Client's reconnect
    // drain (Engine.ts H.41) still consumes pending_restock_cost_cents
    // to clear it, but the forceSpendMoney debit is gated to avoid
    // double-charging now that the cloud value is already accurate.
    if accrued_cents > 0 {
        if let Some(r) = ctx.db.restaurant().id().find(restaurant_id) {
            let new_total = r.pending_restock_cost_cents.saturating_add(accrued_cents);
            let new_cloud_money_cents = r.cloud_money_cents.saturating_sub(accrued_cents).max(0);
            // Phase 7.6 — track restock expense in today's daily total.
            let new_cloud_daily_expenses = r.cloud_daily_expenses_cents.saturating_add(accrued_cents);
            let restock_delta = new_cloud_money_cents - r.cloud_money_cents;
            ctx.db.restaurant().id().update(Restaurant {
                pending_restock_cost_cents: new_total,
                cloud_money_cents: new_cloud_money_cents,
                cloud_daily_expenses_cents: new_cloud_daily_expenses,
                ..r
            });
            // Ledger — the auto-restock cost as its own line.
            record_money_event(ctx, restaurant_id, "restock", restock_delta, new_cloud_money_cents);
        }
    }
    log::info!(
        "try_restock_pantry: restaurant {} restocked {} ingredient(s) for {} cents (pending total updated)",
        restaurant_id, restocked_count, accrued_cents,
    );
}

// === H.43 — Server-side recipe upgrade completion =================
//
// The client's CookingSystem still owns recipe levels in foreground
// (canonical source = save's recipeUpgradeLevels map).  What changes
// here is *who fires the completion event* — the client used to rely
// on its own tickRecipeUpgrades, which only runs when the tab is open.
// Now the server tracks the deadline in recipe_upgrade_in_flight and
// fires the completion (appending recipe_id to the restaurant's
// pending CSV) regardless of whether the player is online.  Client
// drains on reconnect; same pattern as H.22 pending_served.

/// Phase H.43 — Client fires this on startRecipeUpgrade.  Upserts an
/// in-flight row keyed on (restaurant_id, recipe_id); when the server
/// tick observes completes_at_micros <= ctx.timestamp, it deletes the
/// row and appends recipe_id to pending_recipe_upgrades_completed_csv.
///
/// Owner-only.  Idempotent on identical (restaurant, recipe,
/// completes_at) tuples — a re-fire with the same deadline is a no-op.
#[reducer]
pub fn start_recipe_upgrade(
    ctx: &ReducerContext,
    restaurant_id: u64,
    recipe_id: String,
    completes_at_micros: i64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can start a recipe upgrade".into());
    }
    if recipe_id.is_empty() || recipe_id.len() > 64 {
        return Err("recipe_id must be 1-64 chars".into());
    }
    if completes_at_micros <= 0 {
        return Err("completes_at_micros must be positive".into());
    }
    let key = format!("{}:{}", restaurant_id, recipe_id);
    let existing = ctx.db.recipe_upgrade_in_flight().key().find(key.clone());
    if let Some(e) = &existing {
        if e.completes_at_micros == completes_at_micros { return Ok(()); }
    }
    let row = RecipeUpgradeInFlight {
        key,
        restaurant_id,
        recipe_id,
        completes_at_micros,
    };
    if existing.is_some() {
        ctx.db.recipe_upgrade_in_flight().key().update(row);
    } else {
        ctx.db.recipe_upgrade_in_flight().insert(row);
    }
    Ok(())
}

/// Phase H.43 — Client fires this on cancelRecipeUpgrade. Deletes the
/// in-flight row without firing a completion.  Owner-only.  Idempotent
/// — missing row is a silent no-op.
#[reducer]
pub fn cancel_recipe_upgrade(
    ctx: &ReducerContext,
    restaurant_id: u64,
    recipe_id: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can cancel a recipe upgrade".into());
    }
    let key = format!("{}:{}", restaurant_id, recipe_id);
    if ctx.db.recipe_upgrade_in_flight().key().find(key.clone()).is_some() {
        ctx.db.recipe_upgrade_in_flight().key().delete(key);
    }
    Ok(())
}

/// Phase H.43 — Owner-only.  Client drained
/// pending_recipe_upgrades_completed_csv into local state; this
/// reducer clears it so the same completion isn't applied twice on
/// the next reconnect.  Idempotent (empty string is silent no-op).
#[reducer]
pub fn consume_pending_recipe_upgrades(
    ctx: &ReducerContext,
    restaurant_id: u64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can consume pending recipe upgrades".into());
    }
    let current = r.pending_recipe_upgrades_completed_csv.as_deref().unwrap_or("");
    if current.is_empty() { return Ok(()); }
    log::info!(
        "consume_pending_recipe_upgrades: restaurant {} drained '{}'",
        restaurant_id, current,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_recipe_upgrades_completed_csv: None,
        ..r
    });
    Ok(())
}

/// Phase H.43 — Per-restaurant tick scan.  Any in-flight upgrade
/// whose completes_at_micros has passed gets deleted and its recipe_id
/// appended to the restaurant's pending CSV.  Cheap (small N — usually
/// 0 or 1 upgrade in flight at any time).
fn tick_recipe_upgrade_completions(ctx: &ReducerContext, rid: u64) {
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    // Collect completed rows first; iterator can't outlive deletes.
    let completed: Vec<(String, String)> = ctx.db.recipe_upgrade_in_flight()
        .restaurant_id().filter(rid)
        .filter(|f| now_micros >= f.completes_at_micros)
        .map(|f| (f.key.clone(), f.recipe_id.clone()))
        .collect();
    if completed.is_empty() { return; }
    for (key, _) in &completed {
        ctx.db.recipe_upgrade_in_flight().key().delete(key.clone());
    }
    let Some(r) = ctx.db.restaurant().id().find(rid) else { return; };
    // Append each recipe_id to the pending CSV (avoiding duplicates).
    let current_owned = r.pending_recipe_upgrades_completed_csv
        .clone()
        .unwrap_or_default();
    let mut existing: Vec<&str> = current_owned
        .split(',')
        .filter(|s| !s.is_empty())
        .collect();
    let extra: Vec<String> = completed.into_iter()
        .map(|(_, rid)| rid)
        .filter(|rid| !existing.contains(&rid.as_str()))
        .collect();
    for r in &extra { existing.push(r.as_str()); }
    let new_csv = existing.join(",");
    if new_csv == current_owned { return; }
    log::info!(
        "tick_recipe_upgrade_completions: restaurant {} completed {:?}",
        rid, extra,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_recipe_upgrades_completed_csv: Some(new_csv),
        ..r
    });
}

// === H.44 — Server-side staff training completion =================
//
// Mirror of H.43 but for hired_staff_member.training_completes_at_micros.
// When the deadline passes, the server bumps the member's upgrade_level
// by 1 and appends the member_id to pending_training_completions_csv.
// Client reads cloud level on reconnect (already mirrored by H.39) +
// drains the CSV for "Marcus is now L3!" toasts.

/// Phase H.44 — Client fires this on startMemberTraining /
/// cancelMemberTraining.  Owner-only.  Sets completes_at_micros to 0
/// to cancel; > 0 to start.  Idempotent on identical values.
#[reducer]
pub fn set_member_training_deadline(
    ctx: &ReducerContext,
    member_id: String,
    completes_at_micros: i64,
) -> Result<(), String> {
    let m = ctx.db.hired_staff_member().member_id().find(member_id.clone())
        .ok_or_else(|| format!("Staff member {member_id} not found"))?;
    let r = ctx.db.restaurant().id().find(m.restaurant_id)
        .ok_or_else(|| "Staff member's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set member training".into());
    }
    if completes_at_micros < 0 {
        return Err("completes_at_micros cannot be negative".into());
    }
    if m.training_completes_at_micros == completes_at_micros { return Ok(()); }
    ctx.db.hired_staff_member().member_id().update(HiredStaffMember {
        training_completes_at_micros: completes_at_micros,
        ..m
    });
    Ok(())
}

/// Phase H.44 — Owner-only.  Drains pending_training_completions_csv.
/// Idempotent (empty = silent no-op).
#[reducer]
pub fn consume_pending_training_completions(
    ctx: &ReducerContext,
    restaurant_id: u64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can consume pending training completions".into());
    }
    let current = r.pending_training_completions_csv.as_deref().unwrap_or("");
    if current.is_empty() { return Ok(()); }
    log::info!(
        "consume_pending_training_completions: restaurant {} drained '{}'",
        restaurant_id, current,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_training_completions_csv: None,
        ..r
    });
    Ok(())
}

/// Phase H.44 — Per-restaurant tick scan.  Any hired_staff_member
/// whose training_completes_at_micros has passed gets its upgrade_level
/// bumped + deadline cleared + member_id appended to the pending CSV.
/// Cap upgrade_level at STAFF_UPGRADE_MAX_SERVER (5, mirrors client).
const STAFF_UPGRADE_MAX_SERVER: u32 = 5;
fn tick_training_completions(ctx: &ReducerContext, rid: u64) {
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let completed: Vec<HiredStaffMember> = ctx.db.hired_staff_member()
        .restaurant_id().filter(rid)
        .filter(|m| m.training_completes_at_micros > 0
            && now_micros >= m.training_completes_at_micros)
        .collect();
    if completed.is_empty() { return; }
    let mut completed_ids: Vec<String> = Vec::new();
    for m in completed {
        let member_id = m.member_id.clone();
        let new_level = (m.upgrade_level + 1).min(STAFF_UPGRADE_MAX_SERVER);
        ctx.db.hired_staff_member().member_id().update(HiredStaffMember {
            upgrade_level: new_level,
            training_completes_at_micros: 0,
            ..m
        });
        completed_ids.push(member_id);
    }
    let Some(r) = ctx.db.restaurant().id().find(rid) else { return; };
    let current_owned = r.pending_training_completions_csv
        .clone()
        .unwrap_or_default();
    let mut existing: Vec<&str> = current_owned
        .split(',')
        .filter(|s| !s.is_empty())
        .collect();
    let extra: Vec<String> = completed_ids.into_iter()
        .filter(|id| !existing.contains(&id.as_str()))
        .collect();
    for e in &extra { existing.push(e.as_str()); }
    let new_csv = existing.join(",");
    if new_csv == current_owned { return; }
    log::info!(
        "tick_training_completions: restaurant {} leveled up {:?}",
        rid, extra,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_training_completions_csv: Some(new_csv),
        ..r
    });
}

// === H.45 — Server-side offline salary accrual ====================
//
// Foreground play continues to drive its own tickSalary (the client
// is the authoritative source for active-play deductions).  When the
// owner goes offline > 30s, the server takes over: every restaurant
// tick we compute elapsed micros × per-min payroll, accrue whole cents
// into pending_salary_cost_cents and the fractional remainder into
// pending_salary_remainder_x.  On reconnect the client calls
// reset_salary_tick_clock (telling the server "I'm awake; don't accrue
// for this period — I'll handle it locally") then drains
// pending_salary_cost_cents via forceSpendMoney("salary") + fires
// consume_pending_salary.
//
// Payroll formula matches StaffSystem.getTotalPayrollPerMinute:
//   per_min_cents = base × headcount + Σ (upgrade_level × 100)
// where base is the client-mirrored cloud_base_payroll_per_min_cents.

/// Same offline window as H.33/H.34/H.35: 30 seconds.
const SALARY_OFFLINE_THRESHOLD_MICROS: i64 = 30_000_000;
/// Cents per upgrade level per minute. Mirrors StaffSystem:
/// "base + upgradeLevel ($1/min per level)".
const SALARY_PER_LEVEL_CENTS_PER_MIN: i64 = 100;
/// 1 minute = 60 million microseconds. The salary accumulator
/// is in units of (cents × micros / minute); divide by this to get
/// whole cents.
const MICROS_PER_MINUTE: i64 = 60_000_000;

/// Phase H.45 — Owner-only.  Client mirrors the local
/// admin.payrollPerStaffPerMinute (in dollars) as cents/min/staff so
/// the server can compute the same charge during offline accrual.
/// Idempotent.
#[reducer]
pub fn set_cloud_payroll_rate(
    ctx: &ReducerContext,
    restaurant_id: u64,
    cents_per_min_per_staff: i64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set payroll rate".into());
    }
    if cents_per_min_per_staff < 0 {
        return Err("payroll rate cannot be negative".into());
    }
    if r.cloud_base_payroll_per_min_cents == cents_per_min_per_staff {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        cloud_base_payroll_per_min_cents: cents_per_min_per_staff,
        ..r
    });
    Ok(())
}

/// Phase H.45 — Owner-only.  Client fires on connect to mark "I'm
/// online; don't accrue for any new period until I go offline again."
/// Sets last_salary_tick_micros to 0; the next offline tick will
/// re-seed it with ctx.timestamp.
#[reducer]
pub fn reset_salary_tick_clock(
    ctx: &ReducerContext,
    restaurant_id: u64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can reset salary tick clock".into());
    }
    if r.last_salary_tick_micros == 0 { return Ok(()); }
    ctx.db.restaurant().id().update(Restaurant {
        last_salary_tick_micros: 0,
        ..r
    });
    Ok(())
}

/// Phase H.45 — Owner-only.  Drains pending_salary_cost_cents (and
/// the sub-cent remainder) after the client has debited the player's
/// local money via forceSpendMoney("salary").  Order matters: client
/// debits first, then fires this so a mid-flight failure doesn't
/// double-bill on retry.
#[reducer]
pub fn consume_pending_salary(
    ctx: &ReducerContext,
    restaurant_id: u64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can consume pending salary".into());
    }
    if r.pending_salary_cost_cents == 0 && r.pending_salary_remainder_x == 0 {
        return Ok(());
    }
    log::info!(
        "consume_pending_salary: restaurant {} drained {} cents (remainder {})",
        restaurant_id, r.pending_salary_cost_cents, r.pending_salary_remainder_x,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_salary_cost_cents: 0,
        pending_salary_remainder_x: 0,
        ..r
    });
    Ok(())
}

/// Per-restaurant staff-wage tick. Phase 2 (money migration) — wages are
/// SERVER-AUTHORITATIVE and charged CONTINUOUSLY whether the owner is online
/// or offline; the client no longer bills payroll locally. Paused while the
/// restaurant is CLOSED and during the opening grace period (day <= GRACE).
/// Debits cloud_money_cents directly + logs a "wages" money_event; the client
/// adopts the delta via the restaurant subscription. No-negative: pays only
/// what's on hand, benching the roster if it can't cover payroll. Seeds
/// last_salary_tick on the first tick (no seam bill).
fn tick_offline_salary(ctx: &ReducerContext, rid: u64) {
    let Some(r) = ctx.db.restaurant().id().find(rid) else { return; };
    // Read the save once for open-state + day-number (grace check).
    let save = ctx.db.player_save().identity().find(r.owner);
    // Wages pause while the restaurant is CLOSED — reset the clock so
    // reopening doesn't bill one lump for the whole closed stretch.
    let open = save.as_ref().map(|s| s.restaurant_open).unwrap_or(true);
    if !open {
        if r.last_salary_tick_micros != 0 {
            ctx.db.restaurant().id().update(Restaurant { last_salary_tick_micros: 0, ..r });
        }
        return;
    }
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    // Seed the accumulator on the first offline tick.
    if r.last_salary_tick_micros == 0 {
        ctx.db.restaurant().id().update(Restaurant {
            last_salary_tick_micros: now_micros,
            ..r
        });
        return;
    }
    // Compute total per-minute payroll: base × headcount + Σ level × 100.
    let mut headcount: i64 = 0;
    let mut levels_sum: i64 = 0;
    for m in ctx.db.hired_staff_member().restaurant_id().filter(rid) {
        if m.is_deactivated { continue; } // benched members don't draw payroll
        headcount += 1;
        levels_sum = levels_sum.saturating_add(m.upgrade_level as i64);
    }
    if headcount == 0 {
        // No staff hired — bump last_tick so we don't accrue, but
        // don't bill.  When they hire again the accumulator resumes
        // from the moment they're hired (not from when they went
        // offline).
        ctx.db.restaurant().id().update(Restaurant {
            last_salary_tick_micros: now_micros,
            ..r
        });
        return;
    }
    // Rate falls back to the $6/staff/min default when the client hasn't
    // mirrored a custom rate (cloud_base_payroll_per_min_cents == 0).
    let base_rate = if r.cloud_base_payroll_per_min_cents > 0 { r.cloud_base_payroll_per_min_cents } else { 600 };
    let total_per_min_cents = base_rate
        .saturating_mul(headcount)
        .saturating_add(levels_sum.saturating_mul(SALARY_PER_LEVEL_CENTS_PER_MIN));
    let elapsed = now_micros.saturating_sub(r.last_salary_tick_micros);
    if elapsed <= 0 { return; }
    // accrual_x = pending_remainder_x + total_per_min × elapsed
    // (units of cents × micros / minute)
    let micros_cents = total_per_min_cents.saturating_mul(elapsed);
    let total = r.pending_salary_remainder_x.saturating_add(micros_cents);
    let whole_cents = total / MICROS_PER_MINUTE;
    let new_remainder = total % MICROS_PER_MINUTE;
    // Opening grace: days 1..GRACE are wage-free. Advance the clock (so grace
    // ending doesn't bill one lump) but skip the charge entirely.
    const GRACE_DAYS: u32 = 14; // mirrors GRACE_DAYS in Game.ts + tick_day_clock
    let day_number = save.as_ref().map(|s| s.day_number).unwrap_or(1);
    if day_number <= GRACE_DAYS {
        ctx.db.restaurant().id().update(Restaurant {
            last_salary_tick_micros: now_micros,
            pending_salary_remainder_x: new_remainder,
            ..r
        });
        return;
    }
    // No-negative-money — never let payroll push the balance below $0.
    // Pay only what's on hand; if that can't cover payroll, BENCH every
    // active member (is_deactivated = true) so they stop drawing wages and
    // the owner returns to a deactivated roster instead of a debt. Pending /
    // daily-expense track only the amount actually paid.
    let on_hand = r.cloud_money_cents.max(0);
    let pay = whole_cents.min(on_hand);
    let benched = pay < whole_cents;
    let new_cloud_money_cents = (on_hand - pay).max(0);
    let new_cloud_daily_expenses = r.cloud_daily_expenses_cents.saturating_add(pay);
    ctx.db.restaurant().id().update(Restaurant {
        pending_salary_remainder_x: new_remainder,
        last_salary_tick_micros: now_micros,
        cloud_money_cents: new_cloud_money_cents,
        cloud_daily_expenses_cents: new_cloud_daily_expenses,
        ..r
    });
    // Ledger — the (offline) wage debit as its own line.
    record_money_event(ctx, rid, "wages", -pay, new_cloud_money_cents);
    if benched {
        for m in ctx.db.hired_staff_member().restaurant_id().filter(rid) {
            if !m.is_deactivated {
                ctx.db.hired_staff_member().member_id().update(HiredStaffMember {
                    is_deactivated: true,
                    ..m
                });
            }
        }
        log::info!("tick_offline_salary: restaurant {rid} hit $0 — benched all active staff");
    }
}

/// bulk-sync paths (mirrorAllPools after hydrate / admin reset).
/// Owner-only. Reducer wrapper around `apply_pool_delta` — every
/// client-originated mutation lands here, validates ownership, and
/// then routes through the single internal mutator that the server
/// also uses for its own wash / settle paths (H.91).
#[reducer]
pub fn bump_dishware_pool(
    ctx: &ReducerContext,
    restaurant_id: u64,
    kind: String,
    tier: u32,
    clean_delta: i32,
    dirty_delta: i32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can bump dishware pool".into());
    }
    apply_pool_delta(ctx, restaurant_id, &kind, tier, clean_delta, dirty_delta, "bump_dishware_pool");
    Ok(())
}

/// SELL-BACK — Owner sells clean dishware pieces back at 50% of the
/// client-supplied unit price.  The server has no dishware price
/// table (the catalog lives in src/data/dishwareCatalog.ts), so the
/// owner-gated client passes unit_price_cents — acceptable because
/// bump_dishware_pool already trusts owner-signed deltas wholesale.
/// `count` clamps to the pool row's CLEAN count only; dirty pieces
/// can never be sold.  The decrement routes through apply_pool_delta
/// (source "sell") so saturating math, empty-row pruning, and the
/// audit log behave like every other pool mutation — and the owner's
/// dishware_pool subscription delivers the new clean count to the
/// client (which must NOT mutate its local pool: a local mutation
/// would auto-mirror a second decrement up via bump_dishware_pool).
/// Refund is credited to cloud_money_cents (server-authoritative;
/// Phase 7.7 delta-sync adopts it client-side).
#[reducer]
pub fn sell_dishware(
    ctx: &ReducerContext,
    restaurant_id: u64,
    kind: String,
    tier: u32,
    count: u32,
    unit_price_cents: i64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can sell dishware".into());
    }
    if kind != "plate" && kind != "glass" {
        return Err("kind must be \"plate\" or \"glass\"".into());
    }
    if count == 0 { return Ok(()); }
    let key = pool_key(restaurant_id, &kind, tier);
    let clean = ctx.db.dishware_pool().key().find(key)
        .map(|p| p.clean)
        .unwrap_or(0);
    // Clamp to CLEAN only (never dirty); also bound to i32 range for
    // the delta cast — pool counts are tiny, this is pure hygiene.
    let sold = count.min(clean).min(i32::MAX as u32);
    if sold == 0 { return Ok(()); } // nothing clean at this tier
    apply_pool_delta(ctx, restaurant_id, &kind, tier, -(sold as i32), 0, "sell");
    // Anti-cheat: price the refund from the SERVER catalog, NEVER the
    // client-supplied unit_price_cents — that value credits cloud_money_cents
    // directly, so a modded client could pass i64::MAX to mint money. Mirrors
    // the client dishwareCatalog (PLATE_SETS/GLASS_SETS: round(cost/setSize*100)).
    let server_unit_cents: i64 = match (kind.as_str(), tier) {
        ("plate", 1) => 300,  ("plate", 2) => 900,  ("plate", 3) => 2250,
        ("plate", 4) => 5500, ("plate", 5) => 12500,
        ("glass", 1) => 200,  ("glass", 2) => 600,  ("glass", 3) => 1750,
        ("glass", 4) => 4500, ("glass", 5) => 10500,
        _ => 0,
    };
    if unit_price_cents != server_unit_cents {
        log::warn!(
            "sell_dishware: ignoring client unit_price {} (server {} for {} t{}), restaurant {}",
            unit_price_cents, server_unit_cents, kind, tier, restaurant_id,
        );
    }
    let refund_cents = server_unit_cents.saturating_mul(sold as i64) / 2;
    if refund_cents > 0 {
        ctx.db.restaurant().id().update(Restaurant {
            cloud_money_cents: r.cloud_money_cents.saturating_add(refund_cents),
            ..r
        });
    }
    log::info!(
        "sell_dishware: restaurant {} sold {} clean {} t{} for {} cents (50% of {} c/piece)",
        restaurant_id, sold, kind, tier, refund_cents, server_unit_cents,
    );
    Ok(())
}

/// Phase I (H.91) — SOLE internal pool mutator. Every server-side
/// path that increments or decrements dishware_pool counts (the
/// bump_dishware_pool reducer above, try_server_wash_load,
/// flush_one_dish, settle_guest_dishes's bump_dishware helper)
/// routes through this function. Centralising the read-modify-
/// write logic means: one place that handles the saturating
/// arithmetic, one place that prunes empty rows, one place that
/// emits the audit log. The H.88 bug (load and flush both
/// decremented dirty) was structurally possible because the
/// arithmetic lived in two different functions; with one path
/// that class of bug needs an intentional double-call to recur.
fn apply_pool_delta(
    ctx: &ReducerContext,
    restaurant_id: u64,
    kind: &str,
    tier: u32,
    clean_delta: i32,
    dirty_delta: i32,
    source: &str,
) {
    if clean_delta == 0 && dirty_delta == 0 { return; }
    // Phase 9.45 — STRICT cleaning. Pile lifecycle is now DECOUPLED
    // from the dishware pool. Pre-9.45 a dirty-pool decrease (wash trip
    // OR dishwasher-batch flush) auto-deleted N table piles of the same
    // kind — i.e. washing a plate magically bussed some table. That was
    // the auto-clean fallback the owner explicitly rejected ("dirty
    // plates must stay there ... unservable until a waiter cleans it").
    // Table piles (dirty_pile rows) now clear ONLY when a waiter runs a
    // dedicated seat-clean trip (try_dispatch_seat_clean + tick_seat_
    // clean). The pool here just tracks abstract clean/dirty dish
    // inventory for the wash economy; the two are independent counts
    // that both originate from settle_guest_dishes. No pile deletion
    // here anymore.
    let key = pool_key(restaurant_id, kind, tier);
    let existing = ctx.db.dishware_pool().key().find(key.clone());
    let (cur_clean, cur_dirty) = match &existing {
        Some(p) => (p.clean, p.dirty),
        None => (0u32, 0u32),
    };
    let new_clean = if clean_delta >= 0 {
        cur_clean.saturating_add(clean_delta as u32)
    } else {
        cur_clean.saturating_sub((-clean_delta) as u32)
    };
    let new_dirty = if dirty_delta >= 0 {
        cur_dirty.saturating_add(dirty_delta as u32)
    } else {
        cur_dirty.saturating_sub((-dirty_delta) as u32)
    };
    if new_clean == 0 && new_dirty == 0 {
        if existing.is_some() {
            ctx.db.dishware_pool().key().delete(key);
        }
        log::info!(
            "[apply_pool_delta {}] {} t{} clean {:+}, dirty {:+} (row now empty, deleted)",
            source, kind, tier, clean_delta, dirty_delta,
        );
        return;
    }
    let row = DishwarePool {
        key,
        restaurant_id,
        kind: kind.to_string(),
        tier,
        clean: new_clean,
        dirty: new_dirty,
    };
    if existing.is_some() {
        ctx.db.dishware_pool().key().update(row);
    } else {
        ctx.db.dishware_pool().insert(row);
    }
    log::info!(
        "[apply_pool_delta {}] {} t{} clean {:+} → {}, dirty {:+} → {}",
        source, kind, tier, clean_delta, new_clean, dirty_delta, new_dirty,
    );
}

/// Phase 9.62 — server-computed furniture aggregates (style / comfort /
/// rating_bonus / attraction), each ×100, summed across placed_furniture
/// via furniture_meta. Mirror of the client's getAggregateStats (a plain
/// per-item sum), moved server-side so attraction → spawn rate + the vibe
/// rating modifier are authoritative instead of a trusted client mirror.
/// Returns None when furniture_meta has no rows (catalog not seeded yet)
/// so the caller falls back to the client-sent values during the seed
/// window. Returns (style, comfort, rating_bonus, attraction).
fn server_furniture_aggregates(ctx: &ReducerContext, rid: u64) -> Option<(i32, i32, i32, i32)> {
    if ctx.db.furniture_meta().iter().next().is_none() { return None; }
    let (mut style, mut comfort, mut attraction, mut rating) = (0i32, 0i32, 0i32, 0i32);
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        if let Some(m) = ctx.db.furniture_meta().def_id().find(f.def_id) {
            style = style.saturating_add(m.style_x100);
            comfort = comfort.saturating_add(m.comfort_x100);
            attraction = attraction.saturating_add(m.attraction_x100);
            rating = rating.saturating_add(m.rating_bonus_x100);
        }
    }
    Some((style, comfort, rating, attraction))
}

/// Phase H.28 / 9.62 — refresh the cached furniture aggregates on the
/// Restaurant row (vibe + attraction drive backgrounded-guest rating +
/// spawn rate). The furniture-derived four are now RECOMPUTED server-side
/// from placed_furniture + furniture_meta (authoritative); the client's
/// pushed values are only a fallback for the pre-seed window. Bathroom
/// quality is still client-sent (its fixture-quality math hasn't been
/// ported yet — tracked as a follow-up).
///
/// Owner-only. Idempotent: no change → no-op.
#[reducer]
pub fn update_restaurant_aggregates(
    ctx: &ReducerContext,
    restaurant_id: u64,
    style_x100: i32,
    comfort_x100: i32,
    rating_bonus_x100: i32,
    bathroom_quality_x100: i32,
    attraction_bonus_x100: i32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can update aggregates".into());
    }
    // Server-authoritative recompute; fall back to client values only
    // until furniture_meta is seeded.
    let (style_x100, comfort_x100, rating_bonus_x100, attraction_bonus_x100) =
        server_furniture_aggregates(ctx, restaurant_id)
            .unwrap_or((style_x100, comfort_x100, rating_bonus_x100, attraction_bonus_x100));
    if r.cached_style_x100 == style_x100
        && r.cached_comfort_x100 == comfort_x100
        && r.cached_rating_bonus_x100 == rating_bonus_x100
        && r.cached_bathroom_quality_x100 == bathroom_quality_x100
        && r.cached_attraction_bonus_x100 == attraction_bonus_x100 {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        cached_style_x100: style_x100,
        cached_comfort_x100: comfort_x100,
        cached_rating_bonus_x100: rating_bonus_x100,
        cached_bathroom_quality_x100: bathroom_quality_x100,
        cached_attraction_bonus_x100: attraction_bonus_x100,
        ..r
    });
    Ok(())
}

/// Phase 6.7 — Mirror the foreground client's active boost expiry to
/// the cloud so try_server_spawn_guest can apply the same 0.5×
/// interval halving while the owner's tab is backgrounded. Called
/// from Game.buyBoost as a one-shot: client passes
/// `now_micros + boost_duration_seconds × 1_000_000`.
///
/// Owner-only. Idempotent — pushing the same timestamp twice is a
/// no-op. Passing 0 clears the boost early (e.g. an admin reset);
/// the server stays in unboosted state until the next buyBoost.
#[reducer]
pub fn set_boost_expires_at(
    ctx: &ReducerContext,
    restaurant_id: u64,
    expires_at_micros: i64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set boost expiry".into());
    }
    if r.boost_expires_at_micros == expires_at_micros {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        boost_expires_at_micros: expires_at_micros,
        ..r
    });
    Ok(())
}

/// Phase H.22 — atomically read + zero the Restaurant.pending_*
/// counters. Returns the four values via the same row update path
/// (client reads from subscription before calling, so no explicit
/// return value needed — clearing is the side effect). Called by
/// the foreground client on first frame after the Restaurant
/// subscription has populated, so a backgrounded-then-foregrounded
/// session can apply the rollup to local Game state exactly once.
///
/// Idempotent — calling on an already-zero row is a no-op.
#[reducer]
pub fn consume_pending_visit_rollup(
    ctx: &ReducerContext,
    restaurant_id: u64,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can consume pending rollup".into());
    }
    if r.pending_served == 0
        && r.pending_tips_cents == 0
        && r.pending_revenue_cents == 0
        && r.pending_rating_count == 0
        && r.pending_lost == 0 {
        return Ok(()); // already cleared
    }
    log::info!(
        "consume_pending_visit_rollup: clearing {} served / {} lost / {} tip cents / {} revenue cents / {} ratings on restaurant {}",
        r.pending_served, r.pending_lost, r.pending_tips_cents, r.pending_revenue_cents, r.pending_rating_count, restaurant_id,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_served: 0,
        pending_tips_cents: 0,
        pending_revenue_cents: 0,
        pending_rating_sum_x100: 0,
        pending_rating_count: 0,
        pending_lost: 0,
        ..r
    });
    Ok(())
}

/// Visit-mode theme parity — owner-only setter for the per-floor theme
/// override CSV. Fired by the foreground client whenever the player
/// picks a theme in DecorModal so visit mode + co-owner views render
/// the same wall + slab colors. Empty string clears (= all floors use
/// the catalog default).
#[reducer]
pub fn set_restaurant_theme_overrides(
    ctx: &ReducerContext,
    restaurant_id: u64,
    csv: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set theme overrides".into());
    }
    let next: Option<String> = if csv.trim().is_empty() { None } else { Some(csv) };
    // Idempotent — skip the write if the value didn't change. Keeps the
    // DecorModal's "apply on every modal open" pattern cheap.
    if r.theme_overrides_csv == next { return Ok(()); }
    ctx.db.restaurant().id().update(Restaurant {
        theme_overrides_csv: next,
        ..r
    });
    Ok(())
}

/// Visit-mode rating-sign style parity — owner-only setter for the
/// three sign-style fields. Fired by the foreground client whenever
/// the player saves a new name + style in the RestaurantSignModal so
/// visit mode renders the plaque exactly the way the host sees it.
/// Empty strings clear back to None (catalog default kicks in).
#[reducer]
pub fn set_restaurant_sign_style(
    ctx: &ReducerContext,
    restaurant_id: u64,
    font: String,
    text_color: String,
    plaque_style: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set sign style".into());
    }
    let opt = |s: String| -> Option<String> {
        if s.trim().is_empty() { None } else { Some(s) }
    };
    let next_font = opt(font);
    let next_text_color = opt(text_color);
    let next_plaque_style = opt(plaque_style);
    if r.sign_font == next_font
        && r.sign_text_color == next_text_color
        && r.sign_plaque_style == next_plaque_style {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        sign_font: next_font,
        sign_text_color: next_text_color,
        sign_plaque_style: next_plaque_style,
        ..r
    });
    Ok(())
}

/// Phase 6.8 — Owner-only setter for the restaurant's display name.
/// The legacy autosave path (publishCloud → save_restaurant_snapshot)
/// also writes `Restaurant.name`, but only on day rollover /
/// beforeunload. Players rename frequently while playing; without
/// this reducer, the door plaque on every visitor's view of the
/// restaurant stayed at the old name until the next autosave fired.
///
/// The foreground client calls this from onRestaurantSignChanged
/// alongside set_restaurant_sign_style so the plaque text + plaque
/// style update together in the same UI action. Owner-only.
/// Idempotent — setting the same name twice is a no-op. Names are
/// trimmed + capped to 28 chars (same as Game.setRestaurantSign).
#[reducer]
pub fn set_restaurant_name(
    ctx: &ReducerContext,
    restaurant_id: u64,
    name: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can rename the restaurant".into());
    }
    // Match Game.setRestaurantSign: trim, default empty to "Cozy
    // Bistro", cap at 28 chars. Keeps the server-side value bounded
    // even when the client bypasses the modal.
    let trimmed: String = name.trim().chars().take(28).collect();
    let next_name = if trimmed.is_empty() { "Cozy Bistro".to_string() } else { trimmed };
    if r.name == next_name {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        name: next_name,
        ..r
    });
    Ok(())
}

/// Phase H.21 — server-side dishwasher loader. Best-effort survival
/// path: per tick, push at most one dirty piece into a free
/// dishwasher's batch so the existing H.4 cycle countdown can wash
/// it back to clean. Only meaningful in backgrounded tabs — when a
/// foreground client is alive its absolute-write dishware_pool
/// mirror clobbers anything we do here on the next stream tick.
///
/// Gating rules:
///   1. Foreground guard — if any staff_actor in this restaurant
///      currently has wash_target_uid set AND state_clock_ms is
///      small (< 60 s), the local sim is actively running its own
///      wash trip and we yield. A stuck/stale wash trip (large
///      state_clock_ms because nothing's clearing the field) is
///      treated as "client gone, take over" so a backgrounded tab
///      that left a trip mid-flight still recovers.
///   2. Must have a dishwasher in placed_furniture for this
///      restaurant. No washing path otherwise.
///   3. Must have dirty stock somewhere in dishware_pool.
///   4. Picked dishwasher must have spare capacity for the kind
///      we're loading (10 plates / 5 glasses, matching the
///      client's DISHWASHER_CAPACITY constants).
///
/// Throughput: roughly 1 piece per 100 ms tick when active.
/// Combined with the existing H.4 cycle (~1.5 s per item for a
/// regular dishwasher), a typical 3-course visit's plates clear
/// back to clean in well under a minute.
/// Phase H.34 — Server-side take-order dispatch for offline owners.
/// Mirrors what StaffRouter does in foreground: find a seated/ordering
/// guest without a waiter en route, pick an idle waiter, route them
/// to the guest's seat with take_order_guest_id set. After the
/// existing TAKE_ORDER_DWELL_MS dwell, waiter_finished_taking_order
/// returns true and tick_guest_state flips the guest to
/// waitingForFood — exactly the same path foreground play uses.
///
/// Offline guard: gated on the restaurant owner's Player.last_seen_at
/// being stale (>30 s since last pingPresence). When foreground is
/// alive the client's StaffRouter dispatches and the server skips so
/// we don't clobber its take_order_guest_id mirror.
///
/// Bar customers (seat_at_bar = true) are skipped here — the barman
/// takes their order at the bar counter without a walk; they auto-
/// advance via ORDERING_FALLBACK_MS (H.14) which is still fine.
fn try_dispatch_take_order(ctx: &ReducerContext, rid: u64, max_dispatch: usize) {
    // Phase H Phase 4 — the original H.34 gated this on owner-offline
    // because the local StaffRouter raced it when foregrounded. With
    // the Phase 1+3 bridges in place, the client no longer dispatches
    // take-order trips on its own when serverOwnsTicketDispatch() is
    // on; this path is now always-on. Coverage check below
    // (take_order_guest_id) keeps the dispatcher idempotent across
    // ticks so the same guest never gets two waiters.
    //
    // Phase 9.40 — `max_dispatch` caps how many waiters this consumes so
    // a delivery backlog and an order backlog SHARE the waiter pool
    // instead of delivery (which runs after this) always winning. The
    // tick passes ~half the idle waiters when both backlogs exist, else
    // usize::MAX (uncapped).
    if max_dispatch == 0 { return; }
    let _ = ctx.db.restaurant().id().find(rid); // existence check; ignore rest

    // Set of guest_ids that already have a waiter en route. Used to
    // avoid double-assigning. We treat ANY waiter with take_order_guest_id
    // set as "covering" that guest — whether they're walking to it or
    // already at the seat dwelling.
    let mut covered: std::collections::HashSet<u64> = ctx.db.staff_actor()
        .restaurant_id().filter(rid)
        .filter_map(|a| a.take_order_guest_id)
        .collect();

    // Idle waiters available for dispatch this tick. Pop as we assign.
    let mut idle_waiters: Vec<StaffActor> = ctx.db.staff_actor()
        .restaurant_id().filter(rid)
        .filter(|a| a.role == "waiter"
            && a.state == "idle"
            && a.ticket_id.is_none()
            && a.take_order_guest_id.is_none()
            && a.wash_target_uid.is_empty())
        .collect();
    if idle_waiters.is_empty() { return; }

    // Walk ordering guests in this restaurant. Skip bar customers
    // (barman path, no walk needed) and any guest already covered
    // by an existing waiter assignment.
    let mut dispatched = 0usize;
    for g in ctx.db.active_guest().restaurant_id().filter(rid) {
        if dispatched >= max_dispatch { break; } // Phase 9.40 — leave waiters for delivery
        if g.state != "ordering" { continue; }
        if g.seat_at_bar { continue; }
        if covered.contains(&g.id) { continue; }
        // H.42 — nearest waiter to this guest's seat (with stair
        // penalty), not the first one off the iterator.  Matches
        // the foreground StaffRouter's behavior.
        let Some(actor) = pop_nearest_staff(&mut idle_waiters, g.seat_x, g.seat_z, g.seat_floor)
            else { return; }; // out of waiters
        let actor_id = actor.member_id.clone();
        log::info!(
            "try_dispatch_take_order: waiter {} → guest {} seat ({:.2}, {:.2}, f{})",
            actor_id, g.id, g.seat_x, g.seat_z, g.seat_floor,
        );
        ctx.db.staff_actor().member_id().update(StaffActor {
            state: "movingToWork".to_string(),
            state_clock_ms: 0,
            target_x: g.seat_x,
            target_z: g.seat_z,
            target_floor: g.seat_floor,
            take_order_guest_id: Some(g.id),
            ..actor
        });
        covered.insert(g.id);
        dispatched += 1; // Phase 9.40
    }
}

/// Phase 9.45 — STRICT seat-cleaning dispatch. Sends idle waiters to
/// bus tables that still have leftover plates on them (dirty_pile
/// rows). Until a seat is bussed it stays unservable (try_assign_seat_
/// for skips it), so this is the ONLY thing that frees a dirtied seat
/// for re-use — there is no auto-clean fallback.
///
/// Unlike try_dispatch_wash_trip this is NOT gated on service demand:
/// bussing IS service (a clean table = a seatable customer). Priority
/// is instead enforced by tick ORDER — take-order + ready-delivery
/// dispatch run earlier in the tick and claim the waiters they need,
/// so seat-cleaning only ever picks up waiters still idle afterwards.
///
/// Dispatches as many trips as there are idle waiters × dirty seats
/// this tick (one waiter per seat), greedily pairing the globally
/// cheapest waiter→seat each round so a backlog drains in parallel.
/// Seat coords come straight off the pile row (settle_guest_dishes
/// stamps them with the seat's x/z/floor), so no furniture lookup.
fn try_dispatch_seat_clean(ctx: &ReducerContext, rid: u64) {
    let _ = ctx.db.restaurant().id().find(rid); // existence check

    // Seats already being bussed by a waiter mid-trip — don't double
    // assign. (clean_seat_uid is set for the whole walk + dwell, then
    // cleared when the waiter heads home.)
    let cleaning_in_flight: std::collections::HashSet<String> = ctx.db.staff_actor()
        .restaurant_id().filter(rid)
        .filter_map(|a| a.clean_seat_uid.clone())
        .collect();

    // Distinct dirty seats → representative (x, z, floor). One seat can
    // hold several piles (one per eaten course); we bus the whole seat
    // in one trip, so collapse to distinct seat_uid.
    let mut dirty_seats: std::collections::HashMap<String, (f32, f32, u32)> =
        std::collections::HashMap::new();
    for d in ctx.db.dirty_pile().restaurant_id().filter(rid) {
        if cleaning_in_flight.contains(&d.seat_uid) { continue; }
        dirty_seats.entry(d.seat_uid).or_insert((d.x, d.z, d.floor));
    }
    if dirty_seats.is_empty() { return; }

    // Idle waiters not on any other trip (ticket carry, take-order,
    // wash, errand, or an existing clean).
    let mut idle_waiters: Vec<StaffActor> = ctx.db.staff_actor()
        .restaurant_id().filter(rid)
        .filter(|a| a.role == "waiter"
            && a.state == "idle"
            && a.ticket_id.is_none()
            && a.take_order_guest_id.is_none()
            && a.wash_target_uid.is_empty()
            && a.errand_phase.is_none()
            && a.clean_seat_uid.is_none())
        .collect();
    if idle_waiters.is_empty() { return; }

    let mut seats: Vec<(String, f32, f32, u32)> = dirty_seats
        .into_iter()
        .map(|(uid, (x, z, f))| (uid, x, z, f))
        .collect();

    // Greedy global-nearest pairing, one assignment per round.
    while !idle_waiters.is_empty() && !seats.is_empty() {
        let mut best: Option<(usize, usize, f32)> = None; // (waiter_idx, seat_idx, dist)
        for (wi, w) in idle_waiters.iter().enumerate() {
            for (si, s) in seats.iter().enumerate() {
                if w.home_floor != s.3 { continue; } // 9.55 — strict per-floor
                let d = staff_dist_to(w, s.1, s.2, s.3);
                if best.as_ref().map(|(_, _, bd)| d < *bd).unwrap_or(true) {
                    best = Some((wi, si, d));
                }
            }
        }
        let Some((wi, si, _)) = best else { break };
        let (seat_uid, sx, sz, sf) = seats.swap_remove(si);
        let actor = idle_waiters.swap_remove(wi);
        log::info!(
            "try_dispatch_seat_clean: waiter {} → bus seat {} ({:.2},{:.2}) floor {}",
            actor.member_id, seat_uid, sx, sz, sf,
        );
        ctx.db.staff_actor().member_id().update(StaffActor {
            state: "movingToWork".to_string(),
            state_clock_ms: 0,
            target_x: sx,
            target_z: sz,
            target_floor: sf,
            clean_seat_uid: Some(seat_uid),
            ..actor
        });
    }
}

/// Phase H.35 — Cosmetic wash trip dispatch for offline owners. Picks
/// an idle waiter, a pseudo-pickup at any seat, and a wash station
/// (dishwasher or sink). Sets wash_target_uid + wash_phase="pickup"
/// + target=seat coords; tick_wash_trip then runs the multi-leg
/// state machine.
///
/// Does NOT modify dishware_pool — H.21's try_server_wash_load is
/// the authoritative inventory mover. This dispatcher's only effect
/// is animating waiters so a reconnecting player sees activity
/// matching the dirty pile they remember.
///
/// Gating: offline owner heuristic (Player.last_seen_at) + the
/// restaurant must have at least one waiter, one dirty piece, one
/// wash station, and one seat to use as a pseudo-pickup.
fn try_dispatch_wash_trip(ctx: &ReducerContext, rid: u64) {
    // Phase H Phase 4w — was offline-only. Now always-on; the client's
    // tryStartWashTrip is gated behind serverOwnsTicketDispatch() so
    // they don't both pick a waiter for the same dirty piece. The
    // bridge synthesizes the local WashTrip object (picks dirtyId +
    // kind from the local dirty pile, reads station defId from the
    // registry) when the server claims a waiter. tick_wash_trip
    // animates the trip; the local sim's working-state completion
    // still fires washOne / loadDishwasher (inventory motion stays
    // client-side — try_server_wash_load is the offline analog and
    // is itself gated, so no double-decrement).
    let _ = ctx.db.restaurant().id().find(rid); // existence check

    // Need at least one dirty piece somewhere in the pool.
    let any_dirty = ctx.db.dishware_pool()
        .restaurant_id().filter(rid)
        .any(|p| p.dirty > 0);
    if !any_dirty { return; }

    // Phase 9.8 — SERVICE OUTRANKS WASHING. Under a big dirty
    // backlog this dispatcher used to claim every idle waiter, trip
    // after trip, starving take-order + delivery ("waiters aren't
    // taking orders"). Washing now yields whenever a guest is
    // waiting to order or a cooked ticket is waiting for a runner,
    // and at most ONE wash trip runs per restaurant at a time.
    let service_demand = ctx.db.active_guest().restaurant_id().filter(rid)
        .any(|g| g.state == "ordering")
        || ctx.db.active_ticket().restaurant_id().filter(rid)
            .any(|t| t.state == "ready");
    if service_demand { return; }
    let wash_in_flight = ctx.db.staff_actor().restaurant_id().filter(rid)
        .any(|a| a.role == "waiter" && !a.wash_target_uid.is_empty());
    if wash_in_flight { return; }

    // Collect wash stations — dishwasher or kitchen sink. We may
    // pair across multiple (e.g. one upstairs, one downstairs) so
    // the cheapest waiter→station match wins, not the first found.
    let stations: Vec<PlacedFurniture> = ctx.db.placed_furniture()
        .restaurant_id().filter(rid)
        .filter(|f| f.def_id == "dishwasher"
            || f.def_id == "dishwasher-pro"
            || f.def_id == "sink"
            || f.def_id == "kitchen-sink")
        .collect();
    if stations.is_empty() { return; }

    // Idle waiters not already on another trip.
    let mut idle_waiters: Vec<StaffActor> = ctx.db.staff_actor()
        .restaurant_id().filter(rid)
        .filter(|a| a.role == "waiter"
            && a.state == "idle"
            && a.ticket_id.is_none()
            && a.take_order_guest_id.is_none()
            && a.wash_target_uid.is_empty())
        .collect();
    if idle_waiters.is_empty() { return; }

    // H.42 — pair waiter ↔ station by cheapest distance (with stair
    // penalty).  Mirrors the W6 foreground fix that paired by total
    // travel cost.  The pickup seat is visually incidental, so we
    // optimize the dominant cost (waiter → station) and pick any
    // same-floor seat as the visual pseudo-pickup after the fact.
    let mut best: Option<(usize, usize, f32)> = None; // (waiter_idx, station_idx, dist)
    for (wi, w) in idle_waiters.iter().enumerate() {
        for (si, s) in stations.iter().enumerate() {
            if w.home_floor != s.floor { continue; } // 9.55 — strict per-floor
            let d = staff_dist_to(w, s.x, s.z, s.floor);
            if best.as_ref().map(|(_, _, bd)| d < *bd).unwrap_or(true) {
                best = Some((wi, si, d));
            }
        }
    }
    let Some((wi, si, _)) = best else { return; };
    let station = stations.into_iter().nth(si).expect("si in range");
    let actor = idle_waiters.swap_remove(wi);

    // Need any seat for the pseudo-pickup. Prefer one on the same
    // floor as the wash station so the visual route doesn't yo-yo
    // between floors.  Fall back to any seat if the station's
    // floor has none (rare; small upstairs without seating yet).
    let seat = ctx.db.placed_furniture().restaurant_id().filter(rid)
        .find(|f| f.floor == station.floor && is_seat_providing_def(&f.def_id))
        .or_else(|| ctx.db.placed_furniture().restaurant_id().filter(rid)
            .find(|f| is_seat_providing_def(&f.def_id)));
    let Some(seat) = seat else { return; };

    let member_id = actor.member_id.clone();
    let station_uid = station.uid.clone();
    log::info!(
        "try_dispatch_wash_trip: waiter {} pickup at seat {} ({:.2},{:.2}) → station {} ({:.2},{:.2})",
        member_id, seat.uid, seat.x, seat.z, station_uid, station.x, station.z,
    );
    ctx.db.staff_actor().member_id().update(StaffActor {
        state: "movingToWork".to_string(),
        state_clock_ms: 0,
        target_x: seat.x,
        target_z: seat.z,
        target_floor: seat.floor,
        wash_target_uid: station_uid,
        wash_phase: "pickup".to_string(),
        wash_dirty_id: -1,
        ..actor
    });
}

/// Phase H.35 — Per-tick state machine for a wash-trip waiter.
/// Multi-leg flow: movingToWork → working(pickup) → movingToWork →
/// working(drop) → returningHome. Bypassed by tick_staff_actor when
/// wash_target_uid+wash_phase aren't set; gates back into the
/// standard compute_waiter_transition once wash_phase clears
/// (returningHome → idle handled there).
fn tick_wash_trip(ctx: &ReducerContext, a: StaffActor, dt_ms: i64) {
    /// Dwell at the pickup spot — short, just enough to read as
    /// "grabbing the dirty plate."
    const WASH_PICKUP_DWELL_MS: i64 = 500;
    /// Dwell at the wash station — longer to read as "loading."
    const WASH_DROP_DWELL_MS: i64 = 1_000;

    // H.52 — waiter walk-speed gets +10% per training level.
    let (new_x, new_z) = path_step_same_floor(
        ctx, a.restaurant_id, a.x, a.z, a.target_x, a.target_z,
        a.floor, a.target_floor,
        actor_walk_speed(ctx, &a.role, &a.member_id),
        dt_ms,
    );
    let arrived = (a.target_x - new_x).abs() < 0.01 && (a.target_z - new_z).abs() < 0.01;
    let new_clock = a.state_clock_ms.saturating_add(dt_ms);

    // movingToWork + arrived → flip to working with clock reset.
    if a.state == "movingToWork" && arrived {
        ctx.db.staff_actor().member_id().update(StaffActor {
            x: new_x,
            z: new_z,
            state: "working".to_string(),
            state_clock_ms: 0,
            ..a
        });
        return;
    }

    // working + dwell elapsed → advance leg.
    if a.state == "working" {
        let dwell_done = match a.wash_phase.as_str() {
            "pickup" => new_clock >= WASH_PICKUP_DWELL_MS,
            "drop" => new_clock >= WASH_DROP_DWELL_MS,
            _ => false,
        };
        if dwell_done {
            if a.wash_phase == "pickup" {
                // Pickup done — walk to station.
                let station = ctx.db.placed_furniture().uid().find(a.wash_target_uid.clone());
                let Some(station) = station else {
                    // Station vanished mid-trip (sold). Abort home.
                    let (hx, hz, hf) = staff_home_target(ctx, &a);
                    ctx.db.staff_actor().member_id().update(StaffActor {
                        x: new_x,
                        z: new_z,
                        state: "returningHome".to_string(),
                        state_clock_ms: 0,
                        target_x: hx,
                        target_z: hz,
                        target_floor: hf,
                        wash_target_uid: String::new(),
                        wash_phase: String::new(),
                        wash_dirty_id: -1,
                        ..a
                    });
                    return;
                };
                ctx.db.staff_actor().member_id().update(StaffActor {
                    x: new_x,
                    z: new_z,
                    state: "movingToWork".to_string(),
                    state_clock_ms: 0,
                    target_x: station.x,
                    target_z: station.z,
                    target_floor: station.floor,
                    wash_phase: "drop".to_string(),
                    ..a
                });
                return;
            }
            // wash_phase == "drop": done with the trip.
            //
            // Phase 9.6 — the completed trip IS the inventory motion.
            // Pre-9.6 this cleared the wash fields and left the
            // dirty→clean move to the client (or the gated H.21
            // loader); when the client had no matching local dirty
            // pile (post-reload), the pool's dirty count never
            // dropped and the dispatcher re-picked the same trip
            // forever — the "waiter with a cleaning bubble doing
            // nothing for 5 hours" loop. Sink trips wash 2 pieces,
            // dishwasher trips 8; tier-preserving (per-row moves).
            // The client's bridge-trip completion skips its local
            // washOne/loadDishwasher when serverSim dishware is on,
            // so the pool subscription is the single source of truth.
            let station_def = ctx.db.placed_furniture().uid()
                .find(a.wash_target_uid.clone())
                .map(|s| s.def_id).unwrap_or_default();
            let mut quota: u32 = if station_def.starts_with("dishwasher") { 8 } else { 2 };
            let dirty_rows: Vec<(String, u32)> = ctx.db.dishware_pool()
                .restaurant_id().filter(a.restaurant_id)
                .filter(|p| p.dirty > 0)
                .map(|p| (p.kind.clone(), p.tier))
                .collect();
            for (kind, tier) in dirty_rows {
                if quota == 0 { break; }
                let key = pool_key(a.restaurant_id, &kind, tier);
                let Some(p) = ctx.db.dishware_pool().key().find(key) else { continue };
                let take = p.dirty.min(quota);
                if take == 0 { continue; }
                quota -= take;
                // Phase 9.23 — pile cleanup is centralised in
                // apply_pool_delta (fires for the dishwasher-batch
                // flush too, not just wash trips), so no explicit
                // pile delete here.
                apply_pool_delta(ctx, a.restaurant_id, &kind, tier,
                    take as i32, -(take as i32), "wash-trip");
            }
            // Clear wash fields + return home (role-aware — Phase 9.31).
            let (hx, hz, hf) = staff_home_target(ctx, &a);
            ctx.db.staff_actor().member_id().update(StaffActor {
                x: new_x,
                z: new_z,
                state: "returningHome".to_string(),
                state_clock_ms: 0,
                target_x: hx,
                target_z: hz,
                target_floor: hf,
                wash_target_uid: String::new(),
                wash_phase: String::new(),
                wash_dirty_id: -1,
                ..a
            });
            return;
        }
    }

    // Mid-walk or mid-dwell — step + advance clock.
    ctx.db.staff_actor().member_id().update(StaffActor {
        x: new_x,
        z: new_z,
        state_clock_ms: new_clock,
        ..a
    });
}

/// Phase 9.45 — Per-tick state machine for a STRICT seat-clean trip.
/// Single-leg (simpler than the wash trip): walk to the dirty seat,
/// dwell briefly while "clearing plates," then delete every dirty_pile
/// row at that seat (the dishes were already counted into the wash
/// pool back in settle_guest_dishes — this only removes the visible
/// table leftovers + the unservable marker) and return home. Branched
/// to by tick_staff_actor whenever clean_seat_uid is set.
fn tick_seat_clean(ctx: &ReducerContext, a: StaffActor, dt_ms: i64) {
    /// Dwell at the table while the waiter clears the plates. Three
    /// 2 Hz ticks — long enough to read as bussing, short enough that
    /// a backlog drains briskly.
    const SEAT_CLEAN_DWELL_MS: i64 = 1_500;

    let seat_uid = a.clean_seat_uid.clone().unwrap_or_default();

    // Abort guard — if the seat is no longer dirty (e.g. the row was
    // cleared out-of-band, or the restaurant was reset), don't walk to
    // a clean table; release the waiter home. In normal play the seat
    // stays dirty until WE delete it below (nothing else clears piles).
    let still_dirty = ctx.db.dirty_pile().restaurant_id().filter(a.restaurant_id)
        .any(|d| d.seat_uid == seat_uid);
    if seat_uid.is_empty() || !still_dirty {
        let (hx, hz, hf) = staff_home_target(ctx, &a);
        ctx.db.staff_actor().member_id().update(StaffActor {
            state: "returningHome".to_string(),
            state_clock_ms: 0,
            target_x: hx,
            target_z: hz,
            target_floor: hf,
            clean_seat_uid: None,
            ..a
        });
        return;
    }

    let (new_x, new_z) = path_step_same_floor(
        ctx, a.restaurant_id, a.x, a.z, a.target_x, a.target_z,
        a.floor, a.target_floor,
        actor_walk_speed(ctx, &a.role, &a.member_id),
        dt_ms,
    );
    let arrived = (a.target_x - new_x).abs() < 0.01 && (a.target_z - new_z).abs() < 0.01;
    let new_clock = a.state_clock_ms.saturating_add(dt_ms);

    // movingToWork + arrived → start bussing (working, clock reset).
    if a.state == "movingToWork" && arrived {
        ctx.db.staff_actor().member_id().update(StaffActor {
            x: new_x,
            z: new_z,
            state: "working".to_string(),
            state_clock_ms: 0,
            ..a
        });
        return;
    }

    // working + dwell elapsed → clear the table, head home.
    if a.state == "working" && new_clock >= SEAT_CLEAN_DWELL_MS {
        let pile_ids: Vec<u64> = ctx.db.dirty_pile().restaurant_id().filter(a.restaurant_id)
            .filter(|d| d.seat_uid == seat_uid)
            .map(|d| d.id)
            .collect();
        let n = pile_ids.len();
        for id in pile_ids {
            ctx.db.dirty_pile().id().delete(id);
        }
        log::info!(
            "tick_seat_clean: waiter {} bussed seat {} ({} pile rows cleared)",
            a.member_id, seat_uid, n,
        );
        let (hx, hz, hf) = staff_home_target(ctx, &a);
        ctx.db.staff_actor().member_id().update(StaffActor {
            x: new_x,
            z: new_z,
            state: "returningHome".to_string(),
            state_clock_ms: 0,
            target_x: hx,
            target_z: hz,
            target_floor: hf,
            clean_seat_uid: None,
            ..a
        });
        return;
    }

    // Mid-walk or mid-dwell — step + advance clock.
    ctx.db.staff_actor().member_id().update(StaffActor {
        x: new_x,
        z: new_z,
        state_clock_ms: new_clock,
        ..a
    });
}

// ====================================================================
//             Phase H Phase 5.2 + 5.3 — errand-helper trip
// ====================================================================
//
// Server port of the client's ErrandRouter. Detects pantry shortages
// offline, picks a list capped at carry capacity, charges
// cloud_money_cents, dispatches an idle errand helper through the
// 9-phase visual trip (matches the local ErrandState enum names so
// the bridge's mapping is trivial).
//
// Coverage in this commit:
//   - try_dispatch_errand_trip: detector + dispatch (5.2). Gated on
//     owner-offline initially; Phase 5.4 drops the gate and makes the
//     server the sole detector.
//   - tick_errand_actor: 9-phase state machine (5.3). Position math +
//     dwell timers + delivery side-effect (parse CSV, add to
//     pantry_stock, clear pending_restock_cost if the bill is
//     covered).
//   - tick_staff_actor branches out to tick_errand_actor when
//     errand_phase is set, same shape as the wash-trip branch.
//
// Phase 5.4 will gate the local Game.dispatchAutoShop + drop the
// owner-offline gate so the server is the sole dispatcher in both
// modes.

/// Canonical Floor 0 door coords. The Restaurant table doesn't track
/// per-restaurant door positions, but the v1 layout uses a single
/// southern-wall door — every plot reads the same. Matches the
/// active_guest.door_x/z default.
const ERRAND_DOOR_INTERIOR_X: f32 = 0.0;
const ERRAND_DOOR_INTERIOR_Z: f32 = 5.45;
const ERRAND_DOOR_EXTERIOR_X: f32 = 0.0;
const ERRAND_DOOR_EXTERIOR_Z: f32 = 6.45;
/// Pavement edge where the helper disappears offscreen. Mirrors the
/// local ErrandRouter's ROAD_EDGE_FORWARD constant (~13 units past
/// the door exterior).
const ERRAND_ROAD_EDGE_X: f32 = 0.0;
const ERRAND_ROAD_EDGE_Z: f32 = 18.0;
/// How long the helper stays "at the shop" before walking back.
/// Matches the local OFFSCREEN_SHOP_SECONDS = 3.0.
const ERRAND_OFFSCREEN_SHOP_MS: i64 = 3_000;
/// Brief pause at the supply counter signifying "signed for the
/// delivery". Matches the local COUNTER_DWELL_SECONDS = 0.8.
const ERRAND_COUNTER_DWELL_MS: i64 = 800;
/// Threshold below which an ingredient triggers an auto-shop trip.
/// Mirrors `Game.stockTarget` minus a hysteresis margin so we don't
/// re-dispatch every tick while the helper is mid-trip.
const ERRAND_RESTOCK_THRESHOLD: u32 = 3;
/// Units to fetch per ingredient on a single trip. Mirrors the local
/// "deficit-fill" logic but simplified — we just buy a fixed N per
/// shortage line. Server picks at most CARRY_CAP ingredients per
/// trip.
const ERRAND_UNITS_PER_INGREDIENT: u32 = 5;
/// Max distinct ingredients a single trip carries. Trip cost scales
/// linearly with this cap.
const ERRAND_CARRY_CAP: usize = 5;
/// How often the dispatcher will consider a new trip. Without this
/// cooldown the dispatcher would fire every tick while pantry stays
/// below threshold, queueing trips faster than the helper can
/// complete them.
const ERRAND_DISPATCH_COOLDOWN_MICROS: i64 = 60_000_000;

/// Phase H Phase 5.2 — Detect a pantry shortage and dispatch an idle
/// errand helper. Gated on owner-offline so we don't race the local
/// `Game.dispatchAutoShop`; Phase 5.4 drops the gate.
///
/// Algorithm:
///   1. Bail if no errand helper exists OR all are mid-trip.
///   2. Scan pantry_stock for ingredients below ERRAND_RESTOCK_THRESHOLD,
///      skipping any already on the way (= present in another
///      helper's errand_trip_list_csv).
///   3. Pick up to ERRAND_CARRY_CAP entries.
///   4. Compute total cost via ingredient_cost lookup.
///   5. Saturating-subtract from cloud_money_cents (allow negative
///      balance — matches local forceSpendMoney semantics for
///      offline-accumulated debt).
///   6. Stamp the chosen helper: state=movingToWork, target=door
///      interior, errand_phase="walkingToDoor", trip list CSV frozen.
fn try_dispatch_errand_trip(ctx: &ReducerContext, rid: u64) {
    // Phase H Phase 5.4 — was offline-only. Now always-on: the
    // client's Game.dispatchAutoShopTrip is gated behind
    // serverOwnsTicketDispatch() (same condition used for the chef /
    // waiter / take-order dispatchers), so the server is the sole
    // detector in both modes.
    let Some(r) = ctx.db.restaurant().id().find(rid) else { return };

    // Find an idle errand helper (state=idle AND no errand_phase set).
    // Also build a set of ingredient_ids ALREADY on the way so we
    // don't double-buy them on a second concurrent trip.
    let mut idle_helper: Option<StaffActor> = None;
    let mut on_the_way: std::collections::HashSet<String> = std::collections::HashSet::new();
    for a in ctx.db.staff_actor().restaurant_id().filter(rid) {
        if a.role != "errand" { continue; }
        if a.errand_phase.is_some() {
            // Parse trip list and mark each ingredient as on-the-way.
            if let Some(csv) = a.errand_trip_list_csv.as_deref() {
                for entry in csv.split(',').filter(|s| !s.is_empty()) {
                    if let Some((id, _)) = entry.split_once(':') {
                        on_the_way.insert(id.to_string());
                    }
                }
            }
            continue;
        }
        if a.state != "idle" { continue; }
        if idle_helper.is_none() { idle_helper = Some(a); }
    }
    let Some(helper) = idle_helper else { return; };

    // Build shortage list. Skip ingredients already on the way.
    //
    // Phase 7.3 — Walk the ingredient_cost CATALOG instead of
    // pantry_stock alone. Pre-fix, bump_pantry_stock deleted rows at
    // quantity=0, which made completely-OUT ingredients invisible to
    // the dispatcher (the previous loop only saw existing pantry rows
    // → OUT ingredients had no row → never restocked → kitchen
    // permanently empty for those ingredients). bump_pantry_stock is
    // now fixed to keep qty=0 rows, but existing restaurants still
    // have deleted rows from before the fix. Walking ingredient_cost
    // (which is the seeded master catalog the client publishes at
    // boot) closes that gap retroactively — any ingredient with no
    // pantry row OR qty < threshold gets added to needs.
    // Phase 9.19 — shop toward the PLAYER'S stock target (mirrored
    // into pantry_target by the client; the +/- control in the
    // pantry UI). The old hardcoded "below 3 units" floor left
    // helpers idle while the HUD showed dozens of ingredients
    // "below target" — the server simply didn't know what the
    // player's target was. Fallback to the legacy floor for
    // restaurants that haven't pushed a target yet.
    let target = ctx.db.pantry_target().restaurant_id().find(rid)
        .map(|t| t.target.max(1))
        .unwrap_or(ERRAND_RESTOCK_THRESHOLD);
    let mut needs: Vec<(String, u32)> = Vec::new();
    for cost in ctx.db.ingredient_cost().iter() {
        let ing = cost.ingredient_id.clone();
        if on_the_way.contains(&ing) { continue; }
        let key = format!("{}:{}", rid, ing);
        let qty = ctx.db.pantry_stock().key().find(key)
            .map(|p| p.quantity)
            .unwrap_or(0);
        if qty >= target { continue; }
        // Buy up to the deficit, capped per trip so one scarce
        // ingredient doesn't hog the whole carry capacity.
        let units = (target - qty).min(ERRAND_UNITS_PER_INGREDIENT.max(10));
        needs.push((ing, units));
        if needs.len() >= ERRAND_CARRY_CAP { break; }
    }
    if needs.is_empty() { return; }

    // Compute cost via ingredient_cost lookup. Missing rows are
    // restocked free (graceful degradation matches try_restock_pantry).
    let mut total_cost_cents: i64 = 0;
    for (ing, units) in &needs {
        let unit_cost = ctx.db.ingredient_cost().ingredient_id().find(ing.clone())
            .map(|c| c.cost_cents).unwrap_or(0);
        total_cost_cents = total_cost_cents
            .saturating_add(unit_cost.saturating_mul(*units as i64));
    }

    // Charge cloud_money_cents. Saturating sub allows negative balance
    // for forced offline restocks — player sees the debt on reconnect
    // and works it off. Matches Game.forceSpendMoney semantics used
    // for rent / salary.
    if total_cost_cents > 0 {
        ctx.db.restaurant().id().update(Restaurant {
            cloud_money_cents: r.cloud_money_cents.saturating_sub(total_cost_cents).max(0),
            ..r
        });
    }

    // Freeze the trip list into CSV: "id:units,id:units,...".
    let trip_list_csv = needs.iter()
        .map(|(id, units)| format!("{}:{}", id, units))
        .collect::<Vec<_>>()
        .join(",");

    // Dispatch the helper: state to movingToWork, target to door
    // interior, errand_phase to walkingToDoor.
    let helper_id = helper.member_id.clone();
    ctx.db.staff_actor().member_id().update(StaffActor {
        state: "movingToWork".to_string(),
        state_clock_ms: 0,
        target_x: ERRAND_DOOR_INTERIOR_X,
        target_z: ERRAND_DOOR_INTERIOR_Z,
        target_floor: 0,
        errand_phase: Some("walkingToDoor".to_string()),
        errand_trip_list_csv: Some(trip_list_csv.clone()),
        errand_offscreen_until_micros: 0,
        ..helper
    });
    log::info!(
        "try_dispatch_errand_trip: rid {} helper {} dispatched for {} cents → {}",
        rid, helper_id, total_cost_cents, trip_list_csv,
    );

    // Avoid re-dispatching too aggressively. Stamp the timestamp on
    // last_guest_spawn_micros... actually we don't have an
    // errand-specific cooldown column. The on-the-way set above
    // suffices: once a helper is mid-trip, the dispatcher sees no
    // idle helpers and bails.
    let _ = ERRAND_DISPATCH_COOLDOWN_MICROS;
}

/// Phase H Phase 5.3 — Advance an errand-helper actor through the
/// 9-phase shopping trip. Called from tick_staff_actor when
/// errand_phase is set; replaces the standard chef/waiter
/// compute_waiter_transition path for these actors.
fn tick_errand_actor(ctx: &ReducerContext, a: StaffActor, dt_ms: i64) {
    let phase = a.errand_phase.as_deref().unwrap_or("");

    // Movement helper: step toward target at the errand walk speed.
    // Mirrors the local ErrandRouter's WALK_SPEED = 2.88.
    let (new_x, new_z) = step_toward_target(a.x, a.z, a.target_x, a.target_z, 2.88, dt_ms);
    let arrived = (a.target_x - new_x).abs() < 0.05 && (a.target_z - new_z).abs() < 0.05;
    let new_clock = a.state_clock_ms.saturating_add(dt_ms);

    // Each phase decides: do we advance, dwell, or stay?
    let next: Option<(&str, f32, f32, i64)> = match phase {
        // walkingToDoor → exitingDoor when we hit the interior door.
        "walkingToDoor" if arrived =>
            Some(("exitingDoor", ERRAND_DOOR_EXTERIOR_X, ERRAND_DOOR_EXTERIOR_Z, 0)),
        // exitingDoor → walkingToRoadEdge.
        "exitingDoor" if arrived =>
            Some(("walkingToRoadEdge", ERRAND_ROAD_EDGE_X, ERRAND_ROAD_EDGE_Z, 0)),
        // walkingToRoadEdge → offscreen. Stamp the wall-clock end of
        // the offscreen dwell so we don't drift if the tick rate
        // changes.
        "walkingToRoadEdge" if arrived => {
            let until = ctx.timestamp.to_micros_since_unix_epoch()
                .saturating_add(ERRAND_OFFSCREEN_SHOP_MS * 1_000);
            // Persist offscreen-until + flip phase. Return None — we
            // handle this case separately below to also stamp the
            // offscreen timestamp.
            ctx.db.staff_actor().member_id().update(StaffActor {
                x: new_x,
                z: new_z,
                state: "working".to_string(),
                state_clock_ms: 0,
                errand_phase: Some("offscreen".to_string()),
                errand_offscreen_until_micros: until,
                ..a
            });
            return;
        },
        // offscreen → walkingFromRoadEdge when the wall-clock dwell
        // elapses. Position doesn't update during offscreen — helper
        // is invisible.
        "offscreen" => {
            let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
            if now_micros >= a.errand_offscreen_until_micros {
                Some(("walkingFromRoadEdge", ERRAND_DOOR_EXTERIOR_X, ERRAND_DOOR_EXTERIOR_Z, 0))
            } else {
                // Hold position; just advance state clock for
                // bookkeeping. Skip position write.
                ctx.db.staff_actor().member_id().update(StaffActor {
                    state_clock_ms: new_clock,
                    ..a
                });
                return;
            }
        },
        // walkingFromRoadEdge → enteringDoor when we hit the
        // exterior door anchor.
        "walkingFromRoadEdge" if arrived =>
            Some(("enteringDoor", ERRAND_DOOR_INTERIOR_X, ERRAND_DOOR_INTERIOR_Z, 0)),
        // enteringDoor → walkingToCounter (helper's home doubles as
        // the loiter spot near the supply counter).
        "enteringDoor" if arrived =>
            Some(("walkingToCounter", a.home_x, a.home_z, 0)),
        // walkingToCounter → atCounter (dwell at the counter while
        // signing for the delivery).
        "walkingToCounter" if arrived =>
            Some(("atCounter", a.home_x, a.home_z, 0)),
        // atCounter → returningHome after the dwell. ALSO drains the
        // shopping list into pantry_stock (the delivery side-effect
        // that local Game.completeErrandDelivery does).
        "atCounter" if new_clock >= ERRAND_COUNTER_DWELL_MS => {
            // Parse the frozen CSV and add units to pantry.
            if let Some(csv) = a.errand_trip_list_csv.as_deref() {
                for entry in csv.split(',').filter(|s| !s.is_empty()) {
                    let Some((ing, units_str)) = entry.split_once(':') else { continue };
                    let units: u32 = units_str.parse().unwrap_or(0);
                    if units == 0 { continue; }
                    let key = format!("{}:{}", a.restaurant_id, ing);
                    if let Some(p) = ctx.db.pantry_stock().key().find(key.clone()) {
                        let new_qty = p.quantity.saturating_add(units);
                        ctx.db.pantry_stock().key().update(PantryStock {
                            quantity: new_qty,
                            ..p
                        });
                    } else {
                        ctx.db.pantry_stock().insert(PantryStock {
                            key,
                            restaurant_id: a.restaurant_id,
                            ingredient_id: ing.to_string(),
                            quantity: units,
                        });
                    }
                }
                log::info!(
                    "tick_errand_actor: rid {} helper {} delivered {}",
                    a.restaurant_id, a.member_id, csv,
                );
            }
            Some(("returningHome", a.home_x, a.home_z, 0))
        },
        // returningHome → idle when we hit home. Clear errand state.
        "returningHome" if arrived => {
            ctx.db.staff_actor().member_id().update(StaffActor {
                x: new_x,
                z: new_z,
                state: "idle".to_string(),
                state_clock_ms: 0,
                errand_phase: None,
                errand_trip_list_csv: None,
                errand_offscreen_until_micros: 0,
                ..a
            });
            return;
        },
        // Default: still mid-walk or mid-dwell — step + advance clock.
        _ => None,
    };

    if let Some((next_phase, tx, tz, next_clock)) = next {
        ctx.db.staff_actor().member_id().update(StaffActor {
            x: new_x,
            z: new_z,
            state: "movingToWork".to_string(),
            state_clock_ms: next_clock,
            target_x: tx,
            target_z: tz,
            target_floor: 0,
            errand_phase: Some(next_phase.to_string()),
            ..a
        });
    } else {
        // Mid-walk: step + advance clock; phase unchanged.
        ctx.db.staff_actor().member_id().update(StaffActor {
            x: new_x,
            z: new_z,
            state_clock_ms: new_clock,
            ..a
        });
    }
}

fn try_server_wash_load(ctx: &ReducerContext, rid: u64) {
    /// Capacity per kind inside one dishwasher. Matches the client's
    /// DISHWASHER_CAPACITY in DishwareSystem.ts.
    const PLATE_CAPACITY: u32 = 10;
    const GLASS_CAPACITY: u32 = 5;
    /// Per-piece wash cycle extension, by dishwasher tier. Matches
    /// dishwasherWashPerItem in DishwareSystem.ts.
    const WASH_MS_REGULAR: i64 = 1_500;
    const WASH_MS_PRO: i64 = 1_000;
    /// Stuck threshold for a stale client wash trip. A real
    /// foreground wash trip transitions through state_clock_ms = 0
    /// every few seconds (each leg resets the clock); a stuck trip
    /// just keeps accumulating because nothing clears wash_target_uid.
    const STALE_WASH_MS: i64 = 60_000;

    // (1) Foreground guard — any non-stale client wash trip in flight?
    let client_active = ctx.db.staff_actor().restaurant_id().filter(rid)
        .any(|a|
            !a.wash_target_uid.is_empty()
                && a.state_clock_ms < STALE_WASH_MS
        );
    if client_active { return; }

    // (3) Find one (kind, tier) with dirty > 0. Prefer plate over
    //     glass and higher tier within the kind — matches the
    //     client's flush_one_dish preference order so the rendered
    //     state lines up if the client foregrounds soon.
    let mut best: Option<DishwarePool> = None;
    for p in ctx.db.dishware_pool().restaurant_id().filter(rid) {
        if p.dirty == 0 { continue; }
        // Prefer plate; otherwise pick higher tier.
        let take = match &best {
            None => true,
            Some(cur) => match (cur.kind.as_str(), p.kind.as_str()) {
                ("glass", "plate") => true,
                ("plate", "glass") => false,
                _ => p.tier > cur.tier,
            },
        };
        if take { best = Some(p); }
    }
    let Some(dirty_row) = best else { return; };

    // (2 + 4) Find a dishwasher with capacity for this kind.
    let mut dishwasher: Option<PlacedFurniture> = None;
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        if f.def_id != "dishwasher" && f.def_id != "dishwasher-pro" { continue; }
        let batch = ctx.db.dishwasher_batch().furniture_uid().find(f.uid.clone());
        let has_capacity = match &batch {
            None => true,
            Some(b) => match dirty_row.kind.as_str() {
                "plate" => b.plates < PLATE_CAPACITY,
                "glass" => b.glasses < GLASS_CAPACITY,
                _ => false,
            },
        };
        if has_capacity { dishwasher = Some(f); break; }
    }
    let Some(dw) = dishwasher else { return; };

    // Compute the cycle extension for this piece.
    let wash_extension_ms = if dw.def_id == "dishwasher-pro" { WASH_MS_PRO } else { WASH_MS_REGULAR };

    // Decrement dirty via the central mutator. The plate is now
    // LOGICALLY in the batch — pool[dirty] excludes it.
    // flush_one_dish at cycle completion ONLY increments clean (the
    // H.88 fix); the dirty decrement that previously also happened
    // there has been removed.
    let kind = dirty_row.kind.clone();
    let tier = dirty_row.tier;
    apply_pool_delta(ctx, rid, &kind, tier, 0, -1, "try_server_wash_load");

    // Load into the dishwasher's batch (insert if first piece).
    // Append the tier to the kind-appropriate CSV so flush at cycle
    // end can preserve it (H.93).
    if let Some(b) = ctx.db.dishwasher_batch().furniture_uid().find(dw.uid.clone()) {
        let new_plates = if kind == "plate" { b.plates + 1 } else { b.plates };
        let new_glasses = if kind == "glass" { b.glasses + 1 } else { b.glasses };
        let new_plate_csv = if kind == "plate" {
            Some(append_tier_csv(b.plates_tiers.as_deref(), tier))
        } else { b.plates_tiers.clone() };
        let new_glass_csv = if kind == "glass" {
            Some(append_tier_csv(b.glasses_tiers.as_deref(), tier))
        } else { b.glasses_tiers.clone() };
        ctx.db.dishwasher_batch().furniture_uid().update(DishwasherBatch {
            plates: new_plates,
            glasses: new_glasses,
            cycle_time_remaining_ms: b.cycle_time_remaining_ms.saturating_add(wash_extension_ms),
            plates_tiers: new_plate_csv,
            glasses_tiers: new_glass_csv,
            ..b
        });
    } else {
        let plate_csv = if kind == "plate" { Some(tier.to_string()) } else { None };
        let glass_csv = if kind == "glass" { Some(tier.to_string()) } else { None };
        ctx.db.dishwasher_batch().insert(DishwasherBatch {
            furniture_uid: dw.uid.clone(),
            restaurant_id: rid,
            def_id: dw.def_id.clone(),
            plates: if kind == "plate" { 1 } else { 0 },
            glasses: if kind == "glass" { 1 } else { 0 },
            cycle_time_remaining_ms: wash_extension_ms,
            plates_tiers: plate_csv,
            glasses_tiers: glass_csv,
        });
    }
    log::info!(
        "try_server_wash_load: loaded 1 {} (T{}) into dishwasher {} (rid={})",
        kind, tier, dw.uid, rid,
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
fn flush_one_dish(ctx: &ReducerContext, restaurant_id: u64, kind: &str, tier_hint: Option<u32>) {
    // Phase I (H.93) — Use the tier the plate was loaded with
    // (preserved through the wash cycle via dishwasher_batch's
    // plates_tiers / glasses_tiers CSVs). Pre-H.93 batches don't
    // carry tier info; in that case tier_hint=None and we fall
    // back to the legacy "highest existing tier in the pool"
    // heuristic. New batches always pass the precise tier so a T5
    // wash returns a T5 plate, not a T1 one.
    let tier = match tier_hint {
        Some(t) if (1..=5).contains(&t) => t,
        _ => {
            let mut best_tier: u32 = 0;
            let mut found = false;
            for p in ctx.db.dishware_pool().restaurant_id().filter(restaurant_id) {
                if p.kind != kind { continue; }
                if !found || p.tier > best_tier {
                    best_tier = p.tier;
                    found = true;
                }
            }
            if found { best_tier } else { 1 }
        }
    };
    apply_pool_delta(ctx, restaurant_id, kind, tier, 1, 0, "flush_one_dish");
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

// === H.52 — training-level multipliers (Phase I.3) ================
//
// Ports the client's per-member multipliers to the server so
// backgrounded play applies the same chef cook-speed and waiter
// walk-speed bonuses that foreground play does.  Formulas match
// StaffSystem.getChefCookMultiplier / getWaiterSpeedMultiplier
// exactly.

/// Chef / barman cook-time multiplier × 100 for the given staff
/// member.  Matches the client's max(0.1, 1 - 0.10 × level) — so
/// level 0 → 100, level 1 → 90, ..., level 9 → 10 (floor).
/// Returns 100 (no bonus) when the member id is unknown.
fn chef_cook_multiplier_x100(ctx: &ReducerContext, member_id: &str) -> i32 {
    let Some(m) = ctx.db.hired_staff_member().member_id().find(member_id.to_string())
    else { return 100; };
    let raw = 100i32 - (m.upgrade_level as i32) * 3; // 9.56 — 10% → 3%/level
    raw.max(10) // floor matches client's 0.1× cap
}

/// Apply chef training to a base cook time (ms).  Integer math: ms
/// × x100 / 100.  Saturating to keep us safe against negative
/// products even though all inputs here are positive.
fn apply_chef_speed(base_ms: i64, mult_x100: i32) -> i64 {
    let prod = (base_ms.max(0) as i128) * (mult_x100.max(0) as i128);
    (prod / 100).clamp(0, i64::MAX as i128) as i64
}

/// Walk-speed multiplier (float) for a staff actor.  Chefs/barmen
/// get no walk-speed bonus from training — their bonus is the
/// chef_cook_multiplier on cook time.  Waiters get +3% speed per
/// level (9.56), matching getWaiterSpeedMultiplier.  Unknown members
/// default to 1.0× (no bonus).
fn actor_speed_multiplier(ctx: &ReducerContext, role: &str, member_id: &str) -> f32 {
    if role != "waiter" { return 1.0; }
    let Some(m) = ctx.db.hired_staff_member().member_id().find(member_id.to_string())
    else { return 1.0; };
    1.0 + 0.03 * (m.upgrade_level as f32) // 9.56 — 10% → 3%/level
}

/// Convenience: full walk speed for an actor, role base × training
/// multiplier.  Replaces speed_for_role at tick_staff_actor /
/// tick_wash_trip step sites.
fn actor_walk_speed(ctx: &ReducerContext, role: &str, member_id: &str) -> f32 {
    speed_for_role(role) * actor_speed_multiplier(ctx, role, member_id)
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
/// Admin diagnostics — the activity bucket a staff actor is currently in,
/// derived from its server state + task fields. Mirrors the client's
/// waiterActivityKey so the dashboard vocabulary matches the in-game labels.
fn staff_activity_key(a: &StaffActor) -> &'static str {
    match a.state.as_str() {
        "idle" => "idle",
        "returningHome" => "returning",
        "movingToWork" => {
            if a.take_order_guest_id.is_some() { "→ take order" }
            else if a.wash_phase.as_str() == "pickup" { "→ grab dirty" }
            else if !a.wash_phase.is_empty() { "→ to sink" }
            else if a.role.as_str() == "chef" { "→ stove" }
            else if a.role.as_str() == "barman" { "→ bar" }
            else if a.ticket_id.is_some() {
                if a.delivery_phase.as_deref() == Some("deliver") { "→ serve" } else { "→ fetch dish" }
            } else { "→ work" }
        }
        "working" => {
            if a.take_order_guest_id.is_some() { "taking order" }
            else if !a.wash_phase.is_empty() { "washing" }
            else if a.role.as_str() == "chef" { "cooking" }
            else if a.role.as_str() == "barman" { "mixing" }
            else if a.ticket_id.is_some() { "serving" }
            else { "working" }
        }
        _ => "other",
    }
}

fn tick_staff_actor(ctx: &ReducerContext, member_id: &str, dt_ms: i64) {
    let Some(a) = ctx.db.staff_actor().member_id().find(member_id.to_string()) else { return };
    // Admin diagnostics — accumulate this frame's dt into the actor's current
    // activity bucket (per restaurant + role) so "where does staff time go" is
    // captured for every restaurant. One upsert per actor per tick.
    if dt_ms > 0 {
        let activity = staff_activity_key(&a);
        let key = format!("{}:{}:{}", a.restaurant_id, a.role, activity);
        match ctx.db.staff_stat().id().find(key.clone()) {
            Some(s) => {
                let total_ms = s.total_ms.saturating_add(dt_ms);
                ctx.db.staff_stat().id().update(StaffStat { total_ms, ..s });
            }
            None => {
                ctx.db.staff_stat().insert(StaffStat {
                    id: key,
                    restaurant_id: a.restaurant_id,
                    role: a.role.clone(),
                    activity: activity.to_string(),
                    total_ms: dt_ms,
                });
            }
        }
    }
    // Hard interior clamp for non-errand staff — runs every tick, including
    // for idle actors. Errands legitimately walk out to the road to shop, but
    // a waiter / chef / barman should NEVER be outside the walls. An already-
    // idle one whose target is never re-issued can sit stranded on the grass
    // forever (live: a waiter idle at x=8.1 on floor 3 — staff_home_target
    // only re-homes on a returningHome transition that never comes). Snap BOTH
    // body and target into the box [-4.2, 5.2] so the client renders it inside
    // at once; skip the rest of this tick (the next resumes from the new spot).
    if a.role != "errand" {
        let cx = a.x.clamp(-4.2_f32, 5.2_f32);
        let cz = a.z.clamp(-4.2_f32, 5.2_f32);
        let tx = a.target_x.clamp(-4.2_f32, 5.2_f32);
        let tz = a.target_z.clamp(-4.2_f32, 5.2_f32);
        if cx != a.x || cz != a.z || tx != a.target_x || tz != a.target_z {
            ctx.db.staff_actor().member_id().update(StaffActor {
                x: cx, z: cz, target_x: tx, target_z: tz, ..a
            });
            return;
        }
    }
    // Phase 9.48 — DEAD-BINDING self-heal. A chef/waiter can end up
    // pinned to a task whose row no longer exists: the diverging client
    // sim re-binds a stale ticket onto an actor the server had just
    // released, the task then completes + its row is deleted, but the
    // actor keeps the phantom binding — stuck "working", holding its
    // stove, with nothing left to release it (no tick_ticket_state runs
    // for a deleted ticket). Observed live: 7 of 9 chefs pinned to
    // already-deleted tickets, so only 2 of 6 stoves ever cycled and the
    // kitchen throttled to ~⅓ capacity. Detect any binding that points
    // at a missing row and release the actor home. (Phase 9.48's mirror
    // fix stops NEW ones; this clears the backlog + any future straggler.)
    let ticket_gone = a.ticket_id
        .map_or(false, |t| ctx.db.active_ticket().id().find(t).is_none());
    let order_gone = a.take_order_guest_id
        .map_or(false, |g| ctx.db.active_guest().id().find(g).is_none());
    // A station held with no ticket behind it (release clears both
    // together, auto-claim sets both together — so this only happens
    // when the binding got corrupted).
    let stove_orphan = !a.assigned_stove_uid.is_empty() && a.ticket_id.is_none();
    if ticket_gone || order_gone || stove_orphan {
        let (hx, hz, hf) = staff_home_target(ctx, &a);
        log::info!(
            "tick_staff_actor: releasing {} from a DEAD binding (ticket_gone={}, order_gone={}, stove_orphan={})",
            a.member_id, ticket_gone, order_gone, stove_orphan,
        );
        ctx.db.staff_actor().member_id().update(StaffActor {
            state: "returningHome".to_string(),
            state_clock_ms: 0,
            ticket_id: None,
            assigned_stove_uid: String::new(),
            take_order_guest_id: None,
            delivery_phase: None,
            target_x: hx,
            target_z: hz,
            target_floor: hf,
            floor: hf,
            ..a
        });
        return;
    }
    // Phase H.35 — if this actor is in the middle of a server-dispatched
    // wash trip (wash_target_uid set + non-empty wash_phase), the trip
    // has its own multi-leg state machine that's incompatible with the
    // delivery-phase tuple compute_waiter_transition uses. Branch out
    // to the dedicated handler and return.
    if !a.wash_target_uid.is_empty() && !a.wash_phase.is_empty() {
        tick_wash_trip(ctx, a, dt_ms);
        return;
    }
    // Phase H Phase 5.3 — same shape as the wash-trip branch: errand
    // helpers in flight run through the 9-phase tick_errand_actor.
    // Avoids running the chef/waiter transitions on actors whose
    // state strings would otherwise be reinterpreted incorrectly.
    if a.errand_phase.is_some() {
        tick_errand_actor(ctx, a, dt_ms);
        return;
    }
    // Phase 9.45 — same shape again: a waiter on a strict seat-clean
    // trip runs the dedicated single-leg tick_seat_clean. clean_seat_
    // uid is mutually exclusive with the wash/errand fields (dispatch
    // sets only one), so the branch order is unambiguous.
    if a.clean_seat_uid.is_some() {
        tick_seat_clean(ctx, a, dt_ms);
        return;
    }
    // H.52 — waiter walk speed includes training multiplier.
    // Phase 9.64 (staff migration Pass 3-5) — chefs/waiters/barmen now PATH
    // around furniture + walls instead of straight-lining through them (the
    // root of the "staff stuck / clipping / stranded outside" reports).
    // Recompute the path each tick (no stored path to desync); aim at the
    // next waypoint. Same-floor only — cross-floor keeps the straight step
    // (the client's stair anim covers it). Errands already branched out
    // above (they walk OUT to the road, off the interior grid). Empty/
    // blocked path → straight-line fallback, so a miss never freezes anyone.
    let (step_tx, step_tz) = if a.role != "errand" && a.floor == a.target_floor {
        next_path_step(ctx, a.restaurant_id, a.x, a.z, a.target_x, a.target_z, a.floor)
    } else {
        (a.target_x, a.target_z)
    };
    let (new_x, new_z) = step_toward_target(
        a.x, a.z, step_tx, step_tz,
        actor_walk_speed(ctx, &a.role, &a.member_id),
        dt_ms,
    );
    // Phase 9.66 — STUCK-STAFF WATCHDOG. An actor that's been moving toward
    // its target for far longer than any real walk has an UNREACHABLE one —
    // the inside of a closed / circular bar ring, a station boxed in by
    // furniture, a cross-floor spot, etc. Under the staffMove cutover the
    // client no longer runs its own stuck-recovery, so nothing rescues it
    // and it loops the walk animation forever ("barman endlessly trying to
    // get into his circular bar"). Snap it ONTO the target so it arrives +
    // starts working / goes idle. The row update below already pins floor =
    // target_floor, so this also rescues cross-floor strands. 15 s is far
    // longer than any legitimate same- or cross-floor walk.
    let moving_state = a.state == "movingToWork" || a.state == "returningHome";
    let (new_x, new_z) = if moving_state && a.state_clock_ms > 15_000
        && ((a.target_x - new_x).abs() > 0.05 || (a.target_z - new_z).abs() > 0.05) {
        log::info!(
            "tick_staff_actor: {} stuck {} {}ms — snapping to target ({:.1},{:.1})",
            a.member_id, a.state, a.state_clock_ms, a.target_x, a.target_z,
        );
        (a.target_x, a.target_z)
    } else {
        (new_x, new_z)
    };

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

    // H.34 — clear take_order_guest_id when the actor releases back to
    // idle / returningHome. Without this the field would persist past
    // the trip and falsely "cover" the guest in try_dispatch_take_order's
    // dedup set on the next tick. Harmless to clear unconditionally on
    // these states because chefs never have take_order_guest_id set
    // in the first place.
    let clear_take_order = new_state == "returningHome" || new_state == "idle";
    ctx.db.staff_actor().member_id().update(StaffActor {
        x: new_x,
        z: new_z,
        // Phase 9.46 — the server now owns the body for busy actors (the
        // client mirror is ignored for them), so it must own the FLOOR
        // too or a cross-floor waiter would keep its pre-trip storey
        // forever. The abstract server model walks straight to the
        // target with a stair-distance penalty, so the actor is
        // conceptually on its target's floor for the whole leg — snap
        // floor to target_floor. Same-floor tasks (the common case) are
        // a no-op; idle/returning actors carry their home floor here.
        floor: new_target_floor,
        state: new_state,
        state_clock_ms: if advance_clock {
            new_clock.saturating_add(dt_ms)
        } else { new_clock },
        target_x: new_target_x,
        target_z: new_target_z,
        target_floor: new_target_floor,
        delivery_phase: new_delivery_phase,
        ticket_id: new_ticket_id,
        take_order_guest_id: if clear_take_order { None } else { a.take_order_guest_id },
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
        // Non-pickup/deliver "working" — could be a chef at a stove
        // (tick_ticket_state handles their release) OR a waiter
        // running a take-order trip (H.34). For the take-order case
        // we recognize take_order_guest_id being set + state_clock_ms
        // past TAKE_ORDER_DWELL_MS as "done"; return home and let the
        // post-update step in tick_staff_actor clear the field.
        if phase != "pickup" && phase != "deliver" {
            if a.take_order_guest_id.is_some() && a.state_clock_ms >= TAKE_ORDER_DWELL_MS {
                let (hx, hz, hf) = staff_home_target(ctx, a); // Phase 9.31
                return ((
                    "returningHome".to_string(), 0,
                    hx, hz, hf,
                    None, None,
                ), false);
            }
            // Generic chef "working" — leave it to tick_ticket_state.
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
        let (hx, hz, hf) = staff_home_target(ctx, a); // Phase 9.31
        return ((
            "returningHome".to_string(), 0, hx, hz, hf,
            None, None,
        ), false);
    };
    let Some(ticket) = ctx.db.active_ticket().id().find(ticket_id) else {
        // Ticket vanished (guest left, cancellation cascade) — send
        // waiter home with no further action. release_waiter_from_ticket
        // would have hit this path for the cascade case already.
        let (hx, hz, hf) = staff_home_target(ctx, a); // Phase 9.31
        return ((
            "returningHome".to_string(), 0, hx, hz, hf,
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
    let (hx, hz, hf) = staff_home_target(ctx, a); // Phase 9.31
    ((
        "returningHome".to_string(), 0, hx, hz, hf,
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
fn tick_guest_state(ctx: &ReducerContext, guest_id: u64, dt_ms: i64, restaurant_open: bool) {
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else { return };

    // === Despawn path: leaving state has its own dwell timer ===
    // H.18 — also handles the client's "leaving variant" state strings
    // (walkingToDoor, exitingDoor, walkingOut). The short
    // LEAVING_DWELL_MS (4 s) applies to "leaving"/"done"; the longer
    // LEAVING_VARIANT_DWELL_MS (30 s) applies to the client variants.
    // Phase 9.16 — UNKNOWN-STATE watchdog. Guests carrying legacy
    // client-era state strings ("atToilet", "atSink",
    // "returningFromToilet", "walkingToWait", …) match NO transition
    // arm, NO patience branch, nothing — immortal statues parked at
    // fixtures (observed: four guests frozen in "atToilet" for 90 s+
    // with id series thousands older than the live crowd). Anything
    // the server's state machine doesn't own gets walked out; the
    // standard leaving flow settles + despawns them.
    if !server_models_guest_state(&g.state) {
        log::info!(
            "tick_guest_state: guest {} in unknown state '{}' — flipping to leaving",
            g.id, g.state,
        );
        ctx.db.active_guest().id().update(ActiveGuest {
            state: "leaving".to_string(),
            state_clock_ms: 0,
            target_x: 0.0,
            target_z: 0.0,
            target_floor: 0,
            ..g
        });
        return;
    }

    // Phase 9.21 — WC-STUCK watchdog. A guest who's spent more than
    // WC_STUCK_MS in any WC state never finished the cycle (fixture
    // unreachable, mid-walk desync, etc.) — observed as customers
    // standing in the bathroom "forever" not using anything. Give up
    // on the trip and send them back to their seat so the normal
    // seated→ordering flow resumes; wc_completed stays false so they
    // take the (small) "tried but couldn't" rating hit, not the
    // success bonus.
    const WC_STUCK_MS: i64 = 45_000;
    if matches!(g.state.as_str(), "wcWalking" | "wcSitting" | "wcWashing")
        && g.state_clock_ms.saturating_add(dt_ms) >= WC_STUCK_MS {
        log::info!(
            "tick_guest_state: guest {} stuck in {} {}ms — abandoning WC trip → seated",
            g.id, g.state, g.state_clock_ms,
        );
        ctx.db.active_guest().id().update(ActiveGuest {
            state: "seated".to_string(),
            state_clock_ms: 0,
            wc_target_uid: None,
            target_x: g.seat_x,
            target_z: g.seat_z,
            target_floor: g.seat_floor,
            ..g
        });
        return;
    }

    // === Closed-restaurant eject ===
    // Once the player closes up, the kitchen + waiters pause, so a guest
    // who's seated / ordering / waiting / eating can never be served and
    // would sit forever — the "customers stuck in a closed restaurant" bug.
    // Flip every not-already-leaving guest straight to the exit. order_recipes
    // is CLEARED so accumulate_pending_visit_rollup (course_count == 0) skips
    // the rating — closing for the day must not tank the player's stars, and
    // the patience_ms = 0 set here would otherwise pin the visit to 1★. Dish
    // settling keys off reserved_dish_tiers (unaffected); the leaving-dwell
    // flow below runs the ticket / dish / staff cascade + despawns them over
    // the next few ticks.
    if !restaurant_open && !is_leaving_state(&g.state) {
        ctx.db.active_guest().id().update(ActiveGuest {
            state: "leaving".to_string(),
            state_clock_ms: 0,
            patience_ms: 0,
            order_recipes: String::new(),
            target_x: 0.0,
            target_z: 0.0,
            target_floor: 0,
            ..g
        });
        return;
    }

    if is_leaving_state(&g.state) {
        let advanced_clock = g.state_clock_ms.saturating_add(dt_ms);
        let dwell_threshold = if g.state == "leaving" || g.state == "done" {
            LEAVING_DWELL_MS
        } else {
            LEAVING_VARIANT_DWELL_MS
        };
        if advanced_clock >= dwell_threshold {
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
            let orphan_pairs: Vec<(u64, String, String)> = ctx.db
                .active_ticket()
                .iter()
                .filter(|t| t.guest_id == g.id)
                .map(|t| (t.id, t.state.clone(), t.assigned_chef_id.clone()))
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
                orphan_pairs.iter().map(|(tid, _, _)| *tid).collect();
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
            // Phase 9.50 — COOKED-FOOD REUSE. The kitchen's work outlives
            // the customer. Rather than deleting a dish the chef already
            // started (and stranding the chef, and wasting the
            // ingredients), ORPHAN it into the pool (guest_id = 0) so it
            // finishes + waits for the next customer who orders the same
            // recipe. Only a not-yet-started (queued) ticket is discarded.
            for (tid, state, chef_id) in orphan_pairs {
                let Some(t) = ctx.db.active_ticket().id().find(tid) else { continue };
                // Pool only CHEF food a waiter delivers. Bar drinks are
                // made + served by the barman end-to-end, and a not-yet-
                // cooked (queued) ticket has no work to save — both keep
                // the old delete-on-leave behaviour.
                let poolable = !t.seat_at_bar
                    && matches!(state.as_str(), "cooking" | "ready" | "delivering");
                if poolable {
                    if state == "cooking" {
                        // Keep the chef cooking (do NOT release — its work
                        // completes); just cut the customer link.
                        ctx.db.active_ticket().id().update(ActiveTicket { guest_id: 0, ..t });
                    } else {
                        // Plated / mid-carry: pool the finished dish. A
                        // "delivering" one rolls back to "ready" (its
                        // waiter is in waiters_to_release below); reset
                        // the clock so the pool-spoilage timer starts now.
                        ctx.db.active_ticket().id().update(ActiveTicket {
                            guest_id: 0,
                            state: "ready".to_string(),
                            state_clock_ms: 0,
                            ..t
                        });
                    }
                } else {
                    ctx.db.active_ticket().id().delete(tid);
                    if !chef_id.is_empty() {
                        release_chef_from_ticket(ctx, &chef_id);
                    }
                }
            }
            for waiter_id in waiters_to_release {
                release_waiter_from_ticket(ctx, &waiter_id);
            }
            // H.20 — return / dirty-pool the guest's plates BEFORE the
            // row vanishes. Mirrors client settleGuestDishes; the
            // dishes_settled gate inside the helper keeps it
            // idempotent (and a no-op when the client already settled
            // and pushed `dishes_settled = true`).
            settle_guest_dishes(ctx, &g);
            // Phase 7.8 — accumulate runs for EVERY despawn. The
            // function's internal `pending_active = !dishes_settled`
            // gate keeps the pending_* counters off when the
            // foreground client already accounted for the visit
            // locally, while the cloud-canonical writes
            // (cloud_money_cents, cloud_rating_history_csv, daily
            // mirrors) always fire so visitors see live updates and
            // the host's local economy adopts via the Phase 7.7
            // delta subscription handler.
            accumulate_pending_visit_rollup(ctx, &g);
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
    //
    // Phase 9.52 — "eating" REMOVED. A guest who's been served and is
    // EATING is no longer waiting on anyone, so their patience must not
    // keep ticking down. Including it meant a guest who waited a while
    // (slow kitchen) ran out of patience MID-MEAL: the patience timeout
    // (below) fired before the eating→leaving completion, flipping them
    // to "leaving" with patience_ms = 0. The rating math then PINS any
    // patience_ms <= 0 visit to 1★ — so every well-served-but-not-
    // instant customer scored 1★. That's why a restaurant serving 81%
    // of its guests still read 1.0 avg / 500-of-500 one-star. Eating now
    // freezes patience; the meal completes via its own EATING_DURATION_MS
    // clock, and the guest leaves with patience intact → a REAL rating.
    let patience_active = matches!(g.state.as_str(),
        "walkingIn" | "seated" | "ordering" | "waitingForFood"
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
        // H.15 — also route target to door so H.2's position step
        // walks the guest out during LEAVING_DWELL_MS instead of
        // leaving them frozen at the seat.
        let door_x = g.door_x;
        let door_z = g.door_z;
        let door_floor = g.door_floor;
        ctx.db.active_guest().id().update(ActiveGuest {
            state: "leaving".to_string(),
            state_clock_ms: 0,
            patience_ms: 0,
            target_x: door_x,
            target_z: door_z,
            target_floor: door_floor,
            ..g
        });
        log::info!("guest {} timed out — transitioning to leaving", g.id);
        return;
    }

    // Phase H.5 — overflow-chair waiting timeout. Guests parked on a
    // yellow waiting chair use a SEPARATE clock from the patience
    // timer (which represents in-seat impatience). waiting_timeout_ms
    // counts down only while the guest is on the overflow chair; when
    // it hits zero the guest leaves in disgust. Same client-side
    // transition the local GuestSpawner runs today; mirroring it here
    // keeps the two devices in sync when the player switches mid-meal.
    //
    // H.19 — accepts both "waiting" (the plan-doc name) and the
    // "waitingForSeat" string the client actually writes via its
    // position-mirror loop. Together with set_guest_waiting_chair
    // setting waiting_timeout_ms once at chair assignment, this is
    // what wakes H.5 up from being dormant code.
    if is_waiting_state(&g.state) && g.waiting_timeout_ms > 0 {
        let new_wait = (g.waiting_timeout_ms - dt_ms).max(0);
        if new_wait == 0 {
            // H.15 — route to door on leaving (same pattern as the
            // patience-timeout branch above).
            let door_x = g.door_x;
            let door_z = g.door_z;
            let door_floor = g.door_floor;
            ctx.db.active_guest().id().update(ActiveGuest {
                state: "leaving".to_string(),
                state_clock_ms: 0,
                patience_ms: 0,
                waiting_timeout_ms: 0,
                target_x: door_x,
                target_z: door_z,
                target_floor: door_floor,
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
    // Section A — server-side WC trip target picking. When a guest
    // enters wcWalking without a wc_target_uid set (client hadn't
    // mirrored one, or backgrounded tab where the local sim doesn't
    // run), the server picks the nearest free toilet. Same for
    // wcSitting → wcWashing (need a sink). When wcWashing
    // transitions to seated below, the server clears wc_target_uid
    // and restores target back to the dining seat.
    let mut new_wc_target_uid: Option<String> = g.wc_target_uid.clone();
    let (wc_target_x, wc_target_z, wc_target_floor): (Option<f32>, Option<f32>, Option<u32>) =
        if g.state == "wcWalking" && g.wc_target_uid.as_deref().unwrap_or("").is_empty() {
            match try_pick_wc_target(ctx, &g, WcKind::Toilet) {
                Some((uid, tx, tz, tf)) => {
                    log::info!("guest {} assigned toilet {} (server fallback)", g.id, uid);
                    new_wc_target_uid = Some(uid);
                    (Some(tx), Some(tz), Some(tf))
                }
                None => (None, None, None),
            }
        } else if g.state == "wcWashing"
            && g.wc_target_uid.as_deref().map(is_toilet_def).unwrap_or(false) {
            // Transition from sitting on toilet to walking to sink.
            // wc_target_uid currently points at the toilet; swap it
            // for a sink uid.
            match try_pick_wc_target(ctx, &g, WcKind::Sink) {
                Some((uid, tx, tz, tf)) => {
                    log::info!("guest {} assigned sink {} (server fallback)", g.id, uid);
                    new_wc_target_uid = Some(uid);
                    (Some(tx), Some(tz), Some(tf))
                }
                None => (None, None, None),
            }
        } else {
            (None, None, None)
        };

    let (effective_target_x, effective_target_z, effective_target_floor) =
        match (wc_target_x, assigned_target) {
            (Some(tx), _) => (tx, wc_target_z.unwrap(), wc_target_floor.unwrap()),
            (None, Some((tx, tz, tf))) => (tx, tz, tf),
            (None, None) => (g.target_x, g.target_z, g.target_floor),
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
        // Phase 9.69 — route around furniture on the guest's own floor
        // instead of clipping straight through tables. Cross-floor legs
        // stay straight-line (stairs are handled by the floor pin).
        path_step_same_floor(
            ctx, g.restaurant_id, g.x, g.z,
            effective_target_x, effective_target_z,
            g.floor, effective_target_floor, GUEST_SPEED, dt_ms,
        )
    };

    // Phase H.9 — server-side guest state-machine transitions. Each
    // branch returns the new (state, state_clock) pair. None means
    // "no transition, advance the clock". Mirror-mode safety: every
    // branch rechecks the precondition; if the client already
    // transitioned via update_guest_position the cloud's state will
    // already be the next one and the branch skips.
    let arrived = (g.target_x - new_x).abs() < 0.01
        && (g.target_z - new_z).abs() < 0.01;

    // H.23 — toilet attempt active for this guest right now?
    let toilet_attempt_active = g.state == "seated"
        && g.will_use_toilet
        && !g.used_toilet;
    // H.24 — wash-only (pre-meal handwash, no toilet step) attempt
    // active? Mutually exclusive with the toilet attempt in normal
    // play; toilet wins if both flags somehow ended up true.
    let wash_attempt_active = g.state == "seated"
        && !toilet_attempt_active
        && g.will_wash_only
        && !g.washed_hands;
    let in_attempt_window = new_clock < SEATED_DWELL_MS + WC_GIVEUP_MS;

    // H.23 + H.24 — try to pick a toilet OR sink for a seated WC user.
    // Picks toilet first if toilet_attempt_active; else sink if
    // wash_attempt_active. None when (a) the guest isn't currently in
    // a WC attempt, (b) the give-up window already elapsed, or (c)
    // every fixture of the needed kind is busy this tick.
    let wc_initiation_target: Option<(String, f32, f32, u32)> =
        if toilet_attempt_active && in_attempt_window {
            try_pick_wc_target(ctx, &g, WcKind::Toilet)
        } else if wash_attempt_active && in_attempt_window {
            try_pick_wc_target(ctx, &g, WcKind::Sink)
        } else {
            None
        };
    // H.23 + H.24 — give-up signal. Set true when the wait window has
    // elapsed without finding a free fixture of the needed kind; the
    // post-match update latches the matching flag so the standard
    // seated → ordering arm fires on the next tick.
    let wc_giveup_triggered = (toilet_attempt_active || wash_attempt_active)
        && new_clock >= SEATED_DWELL_MS + WC_GIVEUP_MS
        && wc_initiation_target.is_none();

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
        // H.23 + H.24 — WC initiation. Covers BOTH the toilet path
        // (will_use_toilet) and the wash-only path (will_wash_only).
        // The foreground client owns these transitions under its own
        // state names ("walkingToToilet" / "walkingToSink"); this
        // branch is the backgrounded-tab fallback. Fires when:
        //   - a toilet OR wash attempt is active (computed above)
        //   - we found a free fixture via wc_initiation_target above
        // The give-up case is handled by wc_giveup_triggered below
        // (latches used_toilet OR washed_hands → standard
        // seated → ordering arm fires on the next tick).
        "seated" if (toilet_attempt_active || wash_attempt_active)
                    && wc_initiation_target.is_some() =>
            Some(("wcWalking".to_string(), 0)),
        // Withhold the standard ordering transition for WC users
        // until they've either gone OR given up. Without this gate a
        // willUseToilet / willWashOnly guest with no free fixture
        // would flip to ordering at SEATED_DWELL_MS and never get
        // their trip.
        "seated" if new_clock >= SEATED_DWELL_MS
                    && !toilet_attempt_active
                    && !wash_attempt_active =>
            Some(("ordering".to_string(), 0)),
        // ordering → waitingForFood when a waiter has been dwelling
        // at this guest's seat for the take-order step. The client
        // mirrors waiter.take_order_guest_id when a waiter walks to
        // a guest; the state_clock_ms accumulates while the waiter
        // is "working" at the seat. After TAKE_ORDER_DWELL_MS the
        // server flips guest state — and auto_place_next_course
        // (H.14) fires below to create the ticket from the stored
        // CSVs.
        "ordering" if waiter_finished_taking_order(ctx, g.id) =>
            Some(("waitingForFood".to_string(), 0)),
        // H.14 fallback — for backgrounded tabs where no waiter ever
        // walks over (local sim isn't running), advance after a
        // grace period regardless. Without this fallback, guests on
        // course 2+ would get stuck in ordering forever because the
        // re-enqueue path that DOES fire in foreground play uses a
        // direct beginNextCourse → state=waitingForFood, never going
        // through a take-order trip. ORDERING_FALLBACK_MS is longer
        // than TAKE_ORDER_DWELL_MS so foreground play's real waiter
        // dwell wins when both are firing.
        "ordering" if new_clock >= ORDERING_FALLBACK_MS =>
            Some(("waitingForFood".to_string(), 0)),
        // waitingForFood → eating when ANY active_ticket bound to this
        // guest has state "delivered" (H.8 waiter set it on arrival
        // at the seat). The plate has landed, customer starts eating.
        "waitingForFood" if has_delivered_ticket_for_guest(ctx, g.id) =>
            Some(("eating".to_string(), 0)),
        // Phase 9.11 — TICKETLESS watchdog. auto_place_next_course can
        // fail silently (recipe catalog race, no stock + failed
        // restock, restock unaffordable); pre-9.11 the guest then sat
        // in waitingForFood with no ticket and NO retry path. Stage 1
        // (≥20 s, ticketless): re-attempt placement — the pantry may
        // have restocked or the catalog seeded meanwhile. Stage 2
        // (≥120 s, still ticketless): the kitchen genuinely can't
        // serve them — walk out (patience pinned → 1★, correct: they
        // ordered and never got food). The clock guard keeps stage 1
        // from firing during the normal order→ticket window.
        "waitingForFood" if new_clock >= 20_000
                && !has_any_ticket_for_guest(ctx, g.id) => {
            if let Some(tid) = auto_place_next_course(ctx, &g, None) {
                log::info!(
                    "tick_guest_state: ticketless guest {} recovered — re-placed ticket {}",
                    g.id, tid,
                );
                None
            } else if new_clock >= 120_000 {
                log::info!(
                    "tick_guest_state: guest {} ticketless 120s — kitchen can't serve, leaving",
                    g.id,
                );
                Some(("leaving".to_string(), 0))
            } else {
                None
            }
        },
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
        //
        // Watchdog (stuck-eating fix): that guard waits for the order
        // CSV to mirror — but if it NEVER arrives (client dropped mid-
        // order, or the mirror was lost), the guest eats forever, and
        // eating also freezes patience (Phase 9.52) so nothing else times
        // them out. THESE were the customers frozen at a table for ages.
        // Cap the wait at 3× the meal: an empty CSV that long is never
        // coming, so send them home instead of stranding them.
        "eating" if g.order_recipes.is_empty()
            && new_clock >= EATING_DURATION_MS.saturating_mul(3) =>
            Some(("leaving".to_string(), 0)),
        "eating" if new_clock >= EATING_DURATION_MS && !g.order_recipes.is_empty() => {
            let total_courses = g.order_recipes
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .count() as u32;
            if g.order_index + 1 < total_courses {
                // Phase 9.26 — the waiter took the WHOLE order in one
                // visit, so subsequent courses flow straight to
                // waitingForFood (kitchen cooks the next plate, waiter
                // delivers) instead of bouncing back to seated →
                // ordering → ANOTHER take-order trip per course. That
                // per-course re-ordering was the "waiter takes one
                // plate at a time, back and forth" the user reported.
                Some(("waitingForFood".to_string(), 0))
            } else {
                Some(("leaving".to_string(), 0))
            }
        },
        // wcWalking → wcSitting on arrival at the toilet.
        // Phase 9.22 — when the fixture is on ANOTHER floor the client
        // is climbing stairs (≈5-8 s) while the server's 2D body slid
        // straight to the x/z in ~2 s. Hold the sit-transition for a
        // stair-climb grace so the state doesn't pop the guest onto
        // the toilet before they've visibly arrived. Same-floor keeps
        // the snappy arrival-only behaviour.
        "wcWalking" if arrived
            && (g.floor == effective_target_floor || new_clock >= CROSS_FLOOR_WC_WALK_MS) =>
            Some(("wcSitting".to_string(), 0)),
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

    // H.14 — when transitioning to waitingForFood (server-side
    // ordering→waitingForFood OR client mirror catches up), attempt
    // to place the current course's ticket if no ticket is currently
    // active for this guest. Foreground play has the client doing
    // this directly via place_order; backgrounded tabs rely on the
    // server now. auto_place_next_course bails on idempotency when
    // a non-terminal ticket already exists.
    // Phase 9.26 — order_index advance moved ABOVE auto_place so the
    // next-course ticket is placed for the RIGHT course. Advancing on
    // eating → waitingForFood (the new direct next-course path).
    let new_order_index = if g.state == "eating" && final_state == "waitingForFood" {
        g.order_index.saturating_add(1)
    } else {
        g.order_index
    };

    if final_state == "waitingForFood" {
        // Place the ticket for the course at new_order_index. For the
        // first-course ordering→waitingForFood path new_order_index ==
        // g.order_index (no advance); for the eating→waitingForFood
        // next-course path it's the freshly incremented index so the
        // kitchen cooks the NEXT plate, not the just-eaten one.
        auto_place_next_course(ctx, &g, Some(new_order_index));
    }

    // H.16 — credit the just-finished course's price + satisfaction
    // when transitioning out of "eating" (either to "seated" for the
    // next course OR to "leaving" for the final course). Counter
    // only — observation field, doesn't touch player money (the
    // foreground client's creditCourse still handles the real
    // economy.earnMoney). Parses the CSV entry at the OLD
    // order_index (the course just finished).
    // Phase 9.26 — next-course transition is now eating→waitingForFood
    // (was eating→seated); credit the just-eaten course on either it
    // or the final eating→leaving.
    let course_just_finished =
        g.state == "eating" && (final_state == "waitingForFood" || final_state == "leaving");
    let (added_paid, added_sat) = if course_just_finished {
        let idx = g.order_index as usize;
        let price = parse_csv_index_i64(g.order_prices_csv.as_deref(), idx).unwrap_or(0);
        let sat = parse_csv_index_i32(g.order_satisfactions_csv.as_deref(), idx).unwrap_or(0);
        (price, sat)
    } else {
        (0, 0)
    };
    let new_total_paid = g.total_paid_cents.saturating_add(added_paid);
    let new_total_sat = g.total_satisfaction_x100.saturating_add(added_sat);

    // H.17 — refresh patience to the SERVE pool × multiplier on the
    // two transitions the client also refreshes at:
    //   1. ordering → waitingForFood (waiter just took the order;
    //      kitchen has from-now to deliver before they walk).
    //   2. eating → seated (course finished; next course gets a fresh
    //      budget so a 4-course meal doesn't sum up to a single 90-s
    //      window).
    // Other transitions inherit new_patience (decremented above).
    // patience_active filter prevents WC trips from getting the bump.
    // Phase 9.26 — both "took the order" (ordering→waitingForFood) and
    // "finished a course, next plate incoming" (eating→waitingForFood)
    // get a fresh serve-patience budget.
    let patience_refresh = final_state == "waitingForFood"
        && (g.state == "ordering" || g.state == "eating");
    let final_patience = if patience_refresh {
        scale_patience(SERVE_PATIENCE_BASE_MS, g.patience_mult_x100)
    } else {
        new_patience
    };

    // Section A — wcWashing → seated transition clears wc_target_uid
    // and restores target back to the dining seat. The H.9 transition
    // map flipped state to "seated" if the dwell elapsed; if so we
    // route target_x/z back to seat_x/z so the body walks (or snaps)
    // back to the chair.
    //
    // H.23 — seated → wcWalking transition stamps the freshly-picked
    // toilet uid (from wc_initiation_target) onto the row so the
    // existing wcWalking → wcSitting branch sees a non-empty
    // wc_target_uid and doesn't try to pick AGAIN.
    let started_wc_trip = g.state == "seated" && final_state == "wcWalking";
    let final_wc_target_uid = if g.state == "wcWashing" && final_state == "seated" {
        None
    } else if started_wc_trip {
        wc_initiation_target.as_ref().map(|(uid, _, _, _)| uid.clone())
    } else {
        new_wc_target_uid
    };
    // Decide what the row's outgoing target_x/z should be. Priority:
    // 1. Eating → leaving — route to the door so H.2 walks them out
    //    instead of leaving them frozen at the seat.
    // 2. wcWashing → seated — restore the dining seat coords (else
    //    they'd be left targeting the sink they just walked away from).
    // 3. seated → wcWalking — route to the toilet stand spot we just
    //    picked (H.23).
    // 4. WC target picked above (toilet / sink stand spot, follow-up
    //    wcSitting → wcWashing transition).
    // 5. H.12 fallback seat target.
    // 6. Existing row target (no change).
    let just_started_leaving = g.state != "leaving" && final_state == "leaving";
    let (out_target_x, out_target_z, out_target_floor) =
        if just_started_leaving {
            (g.door_x, g.door_z, g.door_floor)
        } else if g.state == "wcWashing" && final_state == "seated" {
            (g.seat_x, g.seat_z, g.seat_floor)
        } else if started_wc_trip {
            // Unwrap is safe — `started_wc_trip` only true when the
            // wc_initiation_target match arm fired, which requires
            // wc_initiation_target.is_some().
            let (_uid, tx, tz, tf) = wc_initiation_target.as_ref().unwrap();
            (*tx, *tz, *tf)
        } else {
            (effective_target_x, effective_target_z, effective_target_floor)
        };

    // H.23 — latch used_toilet on cycle completion (only if the
    // guest was on the toilet path) OR on give-up of a toilet
    // attempt.
    let wc_cycle_completed = g.state == "wcWashing" && final_state == "seated";
    let new_used_toilet = g.used_toilet
        || (wc_cycle_completed && g.will_use_toilet)
        || (wc_giveup_triggered && toilet_attempt_active);
    // H.24 — latch washed_hands on cycle completion. Both toilet AND
    // wash-only cycles end with a sink dwell (wcWashing), so any
    // completion of the cycle counts as "they washed."  Give-up of a
    // wash-only attempt latches without actually washing — same
    // shape as used_toilet's give-up path.
    let new_washed_hands = g.washed_hands
        || wc_cycle_completed
        || (wc_giveup_triggered && wash_attempt_active);
    // H.29 — wc_completed flips ONLY on cycle completion, not on
    // give-up. accumulate_pending_visit_rollup uses this to apply
    // "wanted but couldn't" rating penalties separately from
    // "successfully visited" bonuses.
    let new_wc_completed = g.wc_completed || wc_cycle_completed;

    ctx.db.active_guest().id().update(ActiveGuest {
        state: final_state,
        state_clock_ms: final_clock,
        patience_ms: final_patience,
        order_index: new_order_index,
        x: new_x,
        z: new_z,
        // H.12 — apply server fallback seat assignment if it fired.
        // When assigned_target is None, these read back to the
        // existing row values (no change).
        seat_uid: assigned_seat,
        target_x: out_target_x,
        target_z: out_target_z,
        target_floor: out_target_floor,
        wc_target_uid: final_wc_target_uid,
        // H.16 — accumulate paid + satisfaction per finished course.
        total_paid_cents: new_total_paid,
        total_satisfaction_x100: new_total_sat,
        // H.23 — latch on cycle complete or give-up.
        used_toilet: new_used_toilet,
        // H.24 — same shape; wash-only OR toilet cycle completion.
        washed_hands: new_washed_hands,
        // H.29 — only on cycle completion (not give-up).
        wc_completed: new_wc_completed,
        ..g
    });
}

/// Parse a CSV (e.g. "120,200,180") and return the entry at `idx` as
/// i64. Returns None if the field is missing, the index is out of
/// range, or the cell doesn't parse. Empty cells parse as 0.
fn parse_csv_index_i64(csv: Option<&str>, idx: usize) -> Option<i64> {
    let s = csv?;
    let mut iter = s.split(',');
    let cell = iter.nth(idx)?;
    if cell.is_empty() { Some(0) } else { cell.parse::<i64>().ok() }
}

/// Same as parse_csv_index_i64 but returns i32 — used for the
/// satisfaction_x100 column which the schema stores as i32 to match
/// the existing total_satisfaction_x100 type.
fn parse_csv_index_i32(csv: Option<&str>, idx: usize) -> Option<i32> {
    let s = csv?;
    let mut iter = s.split(',');
    let cell = iter.nth(idx)?;
    if cell.is_empty() { Some(0) } else { cell.parse::<i32>().ok() }
}

/// Phase H.33 — Server-side conversion of a server-spawned pedestrian
/// into an active guest. Fired by pedestrian_tick when the pedestrian's
/// trip expires and the target plot's owner is OFFLINE — foreground
/// clients still handle the conversion via SharedPedestrians.onArrival
/// → triggerExternalArrival → local spawnGuest, but a backgrounded /
/// disconnected tab can't fire that path, so the customer would
/// otherwise be lost.
///
/// Spawns with neutral defaults (archetype = "regular", taste_diet =
/// "both", patience multiplier rolled in [0.8, 1.2], 20% will_use_toilet
/// / 30%-of-remainder will_wash_only). The full archetype/taste tables
/// only live in the client's TS today; porting them to Rust is a
/// separate migration. The existing simulation pipeline (H.12 seat
/// fallback, H.14 auto place_order, H.16+ payment tracking, etc.) picks
/// the guest up from here.
///
/// Returns true when a guest was inserted, false on any bail (restaurant
/// already full, etc.). pub(crate) so reducers::pedestrians can call it.
pub(crate) fn try_spawn_arrival_guest(
    ctx: &ReducerContext,
    restaurant_id: u64,
    variant: &str,
    door_x: f32,
    door_z: f32,
) -> bool {
    // Phase I (H.89) — RE-ENABLED with seat pre-assignment.
    //
    // H.84/H.86 disabled this entirely because the previous version
    // inserted with seat_uid="" and the client couldn't render those
    // ghost guests. We now pick a free table via try_assign_seat_for
    // BEFORE inserting; if no table is free we just don't spawn (no
    // ghost row created). On success the guest's seat_uid +
    // seat_x/z/floor are populated up front, so the client's H.47
    // hydrate path renders them correctly the moment the player
    // foregrounds.

    // Phase I (H.92) — REMOVED the MAX_ACTIVE_GUESTS=12 cap. It
    // was a defensive backstop from the H.84-era code when the
    // server could create ghost guests with no seat; we kept it
    // to bound runaway accrual. Now that try_assign_seat_for
    // gates every spawn on an actual free table, the real cap is
    // "how many seats the restaurant has" — which is the right
    // answer. A 30-seat restaurant should fill 30 seats while
    // offline, not 12.
    //
    // active_count still gets read because the entropy seed below
    // mixes it in for spawn-roll diversity (without it, two
    // back-to-back spawns at the same micro-timestamp would
    // produce the same archetype roll).
    let active_count = ctx.db.active_guest()
        .restaurant_id().filter(restaurant_id)
        .count();

    // Seat pre-assignment. Phase 9.6 — a full house no longer turns
    // everyone away: arrivals are population-driven, and when no
    // seat is free the guest may WAIT near the door for one to open
    // up. Willingness scales with the restaurant's rating average
    // (5.0★ → everyone waits, ≤2.0★ → nobody does), and so does the
    // wait timeout. try_promote_waiting_guest seats them the moment
    // a chair frees; the Phase 6.1b waiting-timeout tick walks them
    // out (dissatisfied) if it never does.
    // Phase 9.61 — roll archetype + taste BEFORE seat assignment so the
    // picker can honour decor/window/diet preferences, restoring the
    // seat-by-taste behaviour the client's pickBestSeatForTaste lost when
    // guest spawning went server-side (Phase 9.4). Pseudo-random rolls
    // hash (timestamp ^ restaurant_id ^ active_count) — Date.now()/
    // random() are disallowed in scheduled-reducer context.
    let seed: u64 = (ctx.timestamp.to_micros_since_unix_epoch() as u64)
        .wrapping_mul(restaurant_id.wrapping_add(1))
        .wrapping_mul(active_count as u64 + 17);
    let mut h: u64 = seed ^ 0x9E37_79B9_7F4A_7C15;
    h ^= h >> 30; h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27; h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 31;
    // H.38 — pick an archetype from the seeded catalog. Patience
    // multiplier + WC-use chance come from the archetype.
    let (archetype_id, archetype_patience_mult, wc_chance_x100, _order_bias)
        = pick_archetype(ctx, h);
    let wc_roll = ((h >> 24) % 100) as i32;
    let will_use_toilet = wc_roll < wc_chance_x100 / 5; // ~20% of wc-prone
    let will_wash_only = !will_use_toilet && wc_roll < wc_chance_x100 * 4 / 5;
    // Combine archetype's patience multiplier with a small per-guest
    // jitter so two casual diners aren't identical.
    let jitter = ((h >> 40) % 21) as i32 - 10; // ±10
    let patience_mult_x100 = (archetype_patience_mult + jitter).clamp(40, 200);
    let client_temp_id = format!("srv-arrival-{}", h & 0xFFFF_FFFF);

    // Taste roll biased by archetype — mirrors the client's
    // rollCustomerTaste (customerArchetypes.ts) so server-spawned guests
    // show the same variety: foodies/dates/critics care about decor,
    // dates want windows, quick-lunch barely notices, drink-only sit at
    // the bar. Distinct hash bit-slices give independent 0..1 randoms.
    let rng = |shift: u32| ((h >> shift) % 1000) as f32 / 1000.0;
    let (decor_base, window_base): (f32, f32) = match archetype_id.as_str() {
        "quick-lunch" => (0.15, 0.15),
        "foodie"      => (0.70, 0.55),
        "date-night"  => (0.70, 0.85),
        "critic"      => (0.70, 0.40),
        "tourist"     => (0.40, 0.55),
        _             => (0.40, 0.40),
    };
    let taste_decor_pref = (decor_base + (rng(8) - 0.5) * 0.3).clamp(0.0, 1.0);
    let taste_window_pref = (window_base + (rng(16) - 0.5) * 0.3).clamp(0.0, 1.0);
    let diet_roll = rng(48);
    let taste_diet: String = match archetype_id.as_str() {
        "quick-lunch" => if diet_roll < 0.85 { "food" } else { "drink" },
        "date-night" | "foodie" =>
            if diet_roll < 0.7 { "both" } else if diet_roll < 0.9 { "food" } else { "drink" },
        _ => if diet_roll < 0.25 { "drink" } else if diet_roll < 0.75 { "food" } else { "both" },
    }.to_string();

    let mut wait_mode = false;
    let mut waiting_timeout_ms: i64 = 0;
    let (seat_uid, seat_x, seat_z, seat_floor) =
        match try_assign_seat_for(ctx, restaurant_id, door_x, door_z, None,
            Some((taste_decor_pref, taste_window_pref, &taste_diet))) {
            Some(s) => s,
            None => {
                let avg_x100 = avg_rating_x100(ctx, restaurant_id); // 100..500
                let willing_pct = ((avg_x100 - 200) / 3).clamp(0, 100) as u64;
                let roll_h = (ctx.timestamp.to_micros_since_unix_epoch() as u64)
                    .wrapping_mul(restaurant_id.wrapping_add(31));
                if willing_pct == 0 || (roll_h >> 7) % 100 >= willing_pct {
                    log::info!(
                        "try_spawn_arrival_guest: no free seat in restaurant {} — guest unwilling to wait (avg rating x100 = {})",
                        restaurant_id, avg_x100,
                    );
                    return false;
                }
                // Cap concurrent waiters so the doorway doesn't mob.
                let waiting_now = ctx.db.active_guest()
                    .restaurant_id().filter(restaurant_id)
                    .filter(|g| is_waiting_state(&g.state))
                    .count();
                if waiting_now >= 4 {
                    return false;
                }
                wait_mode = true;
                // 36 s at 1★ avg up to 100 s at 5★ — better
                // restaurants are worth a longer wait.
                waiting_timeout_ms = 20_000 + avg_x100 * 160;
                // Fan wait spots alternately left/right of the door.
                let side = if waiting_now % 2 == 0 { 1.0 } else { -1.0 };
                let wx = door_x + side * (0.9 + 0.9 * (waiting_now / 2) as f32);
                (String::new(), wx, door_z - 0.6, 0u32)
            }
        };

    // H.40 — build a server-side order so the guest actually orders
    // something instead of sitting forever with an empty
    // order_recipes string.  Pulls recipe metadata from recipe_meta
    // + active_menu (both seeded by the client at boot); returns
    // empty CSVs gracefully if either isn't available (e.g. brand-
    // new restaurant pre-foreground), in which case the guest will
    // still sit + leave on patience timeout — pre-H.40 behavior.
    let (order_recipes_csv, order_appliances_csv, order_cooks_csv,
         order_prices_csv, order_satisfactions_csv)
        = build_server_order(ctx, restaurant_id, h);
    let order_appliances_opt = if order_appliances_csv.is_empty() { None } else { Some(order_appliances_csv) };
    let order_cooks_opt = if order_cooks_csv.is_empty() { None } else { Some(order_cooks_csv) };
    let order_prices_opt = if order_prices_csv.is_empty() { None } else { Some(order_prices_csv) };
    let order_sats_opt = if order_satisfactions_csv.is_empty() { None } else { Some(order_satisfactions_csv) };

    ctx.db.active_guest().insert(ActiveGuest {
        id: 0, // auto_inc
        restaurant_id,
        client_temp_id,
        variant: variant.to_string(),
        // H.38 — archetype from the seeded catalog (was hardcoded
        // "regular"). Falls back to "regular" if catalog is empty.
        archetype: archetype_id,
        // Phase 9.61 — rolled taste (was hardcoded both/0.5/0.5). Drives
        // the taste-aware seat pick above + the satisfaction rollup.
        taste_diet,
        taste_decor_pref,
        taste_window_pref,
        taste_cuisine_bias: String::new(),
        taste_drink_tolerance: 0.0,
        will_use_toilet,
        // Phase 9.6 — "waiting" guests park near the door until
        // try_promote_waiting_guest hands them a freed seat.
        state: if wait_mode { "waiting".to_string() } else { "walkingIn".to_string() },
        state_clock_ms: 0,
        patience_ms: scale_patience(ORDER_PATIENCE_BASE_MS, patience_mult_x100),
        // H.89 — populate seat fields from try_assign_seat_for above.
        // Without these the row would render as a ghost (client's
        // hydrate path keys on seat_uid being non-empty to mount the
        // guest on a chair).
        seat_uid: seat_uid.clone(),
        seat_x,
        seat_z,
        // Phase 9.10 — real chair facing + bar flag from the mirrored
        // seat_slot row (guests spawned facing -Z regardless of chair
        // orientation, and seat_at_bar was hardcoded false — which
        // killed the entire barman flow server-side: bar-seat tickets
        // route through the barman pool keyed on this flag). Fallbacks
        // cover wait-mode spawns + legacy def-id assignments.
        seat_facing_y: ctx.db.seat_slot().seat_uid().find(seat_uid.clone())
            .map(|s| s.facing_y).unwrap_or(0.0),
        seat_floor,
        seat_at_bar: ctx.db.seat_slot().seat_uid().find(seat_uid.clone())
            .map(|s| s.at_bar).unwrap_or(false),
        plate_x: seat_x,
        plate_z: seat_z,
        x: door_x,
        z: door_z,
        floor: 0,
        // Target the assigned seat so tick_guest_state walks them
        // there. Without this they'd sit at the door (target = door)
        // until the H.12 fallback re-picked a seat after the grace
        // period — wasting cycles and looking glitchy.
        target_x: seat_x,
        target_z: seat_z,
        target_floor: seat_floor,
        // H.40 — pre-populate the order CSVs so the guest actually
        // orders something. Empty string here = "no menu / no meta
        // seeded yet"; guest will sit and leave on patience timeout.
        order_recipes: order_recipes_csv,
        order_index: 0,
        ticket_id: None,
        reserved_dish_tiers: String::new(),
        // Phase 9.6 — synthetic wait-spot id; the client's waiting
        // branch keys on a non-empty value to pose the guest at the
        // wait spot. Not a furniture uid on purpose (no chair claim).
        waiting_chair_uid: if wait_mode { format!("wait-{}", h & 0xFFFF) } else { String::new() },
        waiting_timeout_ms,
        total_paid_cents: 0,
        total_satisfaction_x100: 0,
        dishes_settled: false,
        spawned_at: ctx.timestamp,
        wc_target_uid: None,
        order_appliances: order_appliances_opt,
        order_cook_seconds_csv: order_cooks_opt,
        door_x,
        door_z,
        door_floor: 0,
        order_prices_csv: order_prices_opt,
        order_satisfactions_csv: order_sats_opt,
        patience_mult_x100,
        used_toilet: false,
        will_wash_only,
        washed_hands: false,
        wc_completed: false,
    });
    log::info!(
        "try_spawn_arrival_guest: spawned guest at seat {} in restaurant {} (variant={}, toilet={}, wash={}, mult={})",
        seat_uid, restaurant_id, variant, will_use_toilet, will_wash_only, patience_mult_x100,
    );
    true
}

/// Phase I (H.71) — continuous server-side guest spawning while the
/// owner is OFFLINE.  Called from `restaurant_tick` every 0.5 s.  Most
/// of those calls early-out (online owner, no seats, cadence not
/// elapsed); the actual spawn-fire path runs at the SERVER_SPAWN
/// cadence below — same rate the foreground client's GuestSpawner
/// uses, so when the player comes back the restaurant has been
/// filling at roughly the right pace.
///
/// Why the offline gate: when the player is ONLINE the local
/// GuestSpawner fires arrivals at 5.5 s intervals.  Letting the
/// server fire in parallel would double the rate and overflow the
/// 12-guest cap immediately.  The 30 s last_seen_at threshold
/// matches pedestrians.rs's try_arrival_handoff for consistency.
fn try_server_spawn_guest(ctx: &ReducerContext, rid: u64, now: Timestamp) {
    // Phase I (H.89) — RE-ENABLED.  H.84 disabled this because the
    // underlying try_spawn_arrival_guest couldn't pick a chair and
    // produced "ghost" rows the client couldn't render.  H.89 added
    // server-side seat pre-assignment via try_assign_seat_for, so
    // the spawn now either places the guest at a real seat or
    // returns false without inserting anything.  Net effect: the
    // restaurant stays populated while the player is offline AND
    // those guests show up correctly when the player foregrounds.

    const SERVER_SPAWN_INTERVAL_MICROS: i64 = 5_500_000; // 5.5 s
    const OFFLINE_THRESHOLD_MICROS: i64 = 30_000_000;    // 30 s

    let Some(rest) = ctx.db.restaurant().id().find(rid) else { return; };

    if ctx.db.placed_furniture().restaurant_id().filter(rid).next().is_none() {
        return;
    }
    if ctx.db.staff_actor().restaurant_id().filter(rid).next().is_none() {
        return;
    }

    // Phase 6.5 — weather-adjusted interval. Foreground client
    // multiplies SPAWN_INTERVAL_SECONDS by spawnRateMultiplier so the
    // SAME windows here should: rainy 1.8× slower, festival 0.65×
    // faster. Without this, a tab closed during a festival window
    // misses the rate bump until the player reconnects. Multiplier
    // is x100, applied as `interval × mult / 100`.
    let weather_mult_x100 = ctx.db.weather_state().id().find(1u32)
        .map(|w| weather_spawn_mult_x100(&w.kind))
        .unwrap_or(100);
    // Phase 6.6 — attraction-adjusted interval. Client formula:
    //   attractionMult = max(0.35, 1 - min(0.65, attraction × 0.015))
    // attraction is a raw count (typically 0..50); ×100 form has it
    // pre-scaled, so the inner `attraction × 0.015` becomes
    // `attraction_x100 × 15 / 100_000` = `attraction_x100 × 15 / 10000`.
    // Result is also x100 (e.g. 0.5 → 50). Cap at 35 (= 0.35×).
    let attraction_x100 = rest.cached_attraction_bonus_x100 as i64;
    let attraction_inner_x100 = (attraction_x100.saturating_mul(15) / 10_000).min(65);
    let attraction_mult_x100 = (100 - attraction_inner_x100).max(35);
    let now_micros = now.to_micros_since_unix_epoch();
    // Phase 6.7 — paid-boost halving. Foreground client multiplies
    // its interval by 0.5 while a boost is active; mirror that here so
    // the player gets the spawns they paid for even with their tab
    // backgrounded. boost_expires_at_micros == 0 (default) means
    // "never boosted", which naturally fails the now < expiry check.
    let boost_mult_x100: i64 = if now_micros < rest.boost_expires_at_micros { 50 } else { 100 };
    // Combined multiplier: interval × weather × attraction × boost.
    // Each is x100 so we divide by 100 three times — saturating to keep
    // any single big factor from underflowing the cap.
    let weather_adjusted = SERVER_SPAWN_INTERVAL_MICROS
        .saturating_mul(weather_mult_x100) / 100;
    let attraction_adjusted = weather_adjusted
        .saturating_mul(attraction_mult_x100) / 100;
    let adjusted_interval = attraction_adjusted
        .saturating_mul(boost_mult_x100) / 100;
    if now_micros - rest.last_guest_spawn_micros < adjusted_interval {
        return;
    }

    // Restaurant open / free-seats gate.  Those flags live on the
    // PlayerSave row (keyed by Identity, not by Restaurant id) because
    // they're maintained by the foreground client as gameplay
    // signals for the attraction layer.  If no save row yet, treat
    // as "open with seats" — first sign-up player still gets the
    // first server spawn even before their save persists.
    let save = ctx.db.player_save().identity().find(rest.owner);
    let restaurant_open = save.as_ref().map(|s| s.restaurant_open).unwrap_or(true);
    if !restaurant_open { return; }
    // Phase 9.3 — free_seats gate DROPPED. It read player_save.
    // free_seats, a counter only the FOREGROUND client maintains —
    // frozen at whatever it was when the tab closed. Logging off
    // with a full restaurant froze it at 0 and silently disabled
    // ALL offline spawning until the next login ("the rule that
    // takes over when I'm off"). The real capacity check is
    // try_spawn_arrival_guest's server-side seat pre-assignment
    // (H.89), which counts actual free chairs from placed_furniture
    // minus occupied seat_uids and returns false when full — fresh
    // every tick, no staleness. restaurant_open stays: it's an
    // explicit player toggle, eagerly pushed on change (Phase 6.3).

    // Phase 9.1 — owner_online gate DROPPED. Per Path B (chosen by
    // user), the server is the sole continuous simulator. Spawning
    // fires regardless of whether the owner's tab is open; the
    // foreground client's local spawnGuest call is gated off in
    // tandem (GuestSpawner.update) so there's no double-spawn race.
    // last_seen / OFFLINE_THRESHOLD_MICROS stays referenced because
    // a few downstream reducers still check it for other purposes;
    // keep the local binding around in case we re-instate selective
    // throttling later.
    let _owner_online = ctx.db.player().identity().find(rest.owner)
        .map(|pl| (now_micros - pl.last_seen_at.to_micros_since_unix_epoch())
            < OFFLINE_THRESHOLD_MICROS)
        .unwrap_or(false);

    // Pick a variant by hashing the current micros + restaurant id so
    // consecutive spawns vary instead of cloning the same character.
    // Same hash-pull pattern as try_spawn_arrival_guest.  Pulled from
    // a stable list of 7 — matches the client's CharacterLoader pool.
    const VARIANTS: &[&str] = &[
        "guest-v0", "guest-v1", "guest-v2", "guest-v3",
        "guest-v4", "guest-v5", "guest-v6",
    ];
    let h: u64 = (now_micros as u64).wrapping_mul(rid.wrapping_add(1));
    let variant = VARIANTS[(h as usize) % VARIANTS.len()];

    // Restaurant-local door anchor — NOT (0,0) (that's the room centre, which
    // popped offline walk-ins in mid-room). The door is the southern wall at
    // local (0, ~5.45), matching ERRAND_DOOR_INTERIOR_Z + the door_z default.
    let spawned = try_spawn_arrival_guest(ctx, rid, variant, 0.0, 5.45);
    if spawned {
        ctx.db.restaurant().id().update(Restaurant {
            last_guest_spawn_micros: now_micros,
            ..rest
        });
        log::info!(
            "try_server_spawn_guest: spawned offline guest for restaurant {} (variant={})",
            rid, variant,
        );
    }
}

/// Phase H.25 — per-piece satisfaction contribution of a (kind, tier)
/// piece of dishware, expressed as i64 × 100 to keep the avgSat
/// math in integer space. Mirrors src/data/dishwareCatalog.ts's
/// satisfactionPerPiece column exactly:
///   plate T1..T5: 0.0, 0.5, 1.0, 1.6, 2.2
///   glass T1..T5: 0.0, 0.4, 0.8, 1.3, 1.9
/// Any unknown (kind, tier) returns 0 — so misconfigured or T0/T6
/// rows just don't contribute. Lookup table is hardcoded rather than
/// schema-driven; the client's catalog is also hardcoded in TS, and
/// keeping them in sync via two source files (the client TS + this
/// Rust constant) is cheaper than threading a dishware_def table.
fn dish_satisfaction_x100(kind: &str, tier: u32) -> i64 {
    match (kind, tier) {
        ("plate", 1) => 0,
        ("plate", 2) => 50,
        ("plate", 3) => 100,
        ("plate", 4) => 160,
        ("plate", 5) => 220,
        ("glass", 1) => 0,
        ("glass", 2) => 40,
        ("glass", 3) => 80,
        ("glass", 4) => 130,
        ("glass", 5) => 190,
        _ => 0,
    }
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
/// Phase 9.22 — stair-climb grace before a cross-floor WC guest is
/// allowed to "sit". Covers a typical up-and-over stair walk so the
/// client's stair pathfinder finishes before the server flips state.
const CROSS_FLOOR_WC_WALK_MS: i64 = 7_000;
/// Time the guest dwells at the sink before returning to seat.
const WC_WASH_MS: i64 = 3_000;
/// Phase H.23 — extra grace beyond SEATED_DWELL_MS during which a WC
/// user keeps re-attempting to pick a free toilet before giving up
/// and proceeding to ordering. Mirrors the client's
/// WC_PATIENCE_SECONDS (10 s).
const WC_GIVEUP_MS: i64 = 10_000;

/// Phase H.30 — Visual day cycle length. 720_000 ms = 720 s = 12 real
/// minutes per game day. Matches the client's
/// DayCycleSystem.dayLengthSeconds default. When day_elapsed_ms on a
/// Restaurant row crosses this in restaurant_tick, the server pops
/// one full day into pending_days_advanced.
const DAY_LENGTH_MS: i64 = 720_000;

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

/// Phase 9.11 — true if ANY ticket (any state) is bound to this
/// guest. The waitingForFood watchdog uses it to detect the
/// "ordered but no ticket ever materialised" orphan: auto_place can
/// fail silently (catalog race, no stock + failed restock, restock
/// unaffordable) and pre-9.11 nothing retried — the guest hung
/// until patience death with the kitchen idle.
fn has_any_ticket_for_guest(ctx: &ReducerContext, guest_id: u64) -> bool {
    ctx.db.active_ticket().iter().any(|t| t.guest_id == guest_id)
}

/// Section A migration — true if any staff_actor in the same
/// restaurant has take_order_guest_id == this guest's id AND has
/// been "working" (dwelling at the seat) for at least
/// TAKE_ORDER_DWELL_MS. Signals that a waiter has just finished
/// taking the order, so the guest state can advance to
/// waitingForFood server-side.
fn waiter_finished_taking_order(ctx: &ReducerContext, guest_id: u64) -> bool {
    for a in ctx.db.staff_actor().iter() {
        if a.take_order_guest_id != Some(guest_id) { continue; }
        if a.state != "working" { continue; }
        if a.state_clock_ms < TAKE_ORDER_DWELL_MS { continue; }
        return true;
    }
    false
}

/// Time a waiter spends dwelling at a guest's seat taking the order.
/// Matches the client's WAITER_TAKE_ORDER_DWELL_SECONDS. 2 seconds —
/// long enough to read as a deliberate beat, short enough that the
/// guest's patience isn't materially eaten by it.
const TAKE_ORDER_DWELL_MS: i64 = 2_000;

/// H.14 — Backgrounded-tab fallback for ordering → waitingForFood.
/// If a waiter never arrives within this window (no local sim
/// running, the take-order trip system is client-only), the server
/// gives up waiting and progresses the guest anyway. Longer than
/// TAKE_ORDER_DWELL_MS so foreground play's real waiter dwell
/// always wins the race.
const ORDERING_FALLBACK_MS: i64 = 10_000;

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

/// Toilet def_ids — guests in state=wcWalking head here.
fn is_toilet_def(def_id: &str) -> bool {
    matches!(def_id, "toilet" | "toilet-square")
}

/// Bathroom sink def_ids — guests in state=wcWashing head here.
/// Distinct from the kitchen "sink" (category=="wash") which the
/// waiters use for dishwashing.
fn is_sink_def(def_id: &str) -> bool {
    matches!(def_id, "bathroom-sink" | "bathroom-sink-sq")
}

#[derive(Clone, Copy)]
enum WcKind { Toilet, Sink }

/// Section A migration — pick a free toilet or sink for a guest's
/// WC trip. Returns (uid, stand_x, stand_z, floor) — stand position
/// is one tile ahead along the fixture's facing axis (matches the
/// client's getToilets / getBathroomSinks convention so the guest
/// renders next to the unit, not on top of it).
///
/// "Free" check filters out any uid currently held by another guest's
/// wc_target_uid. Strict per-fixture lock since toilets really are
/// single-occupancy.
fn try_pick_wc_target(ctx: &ReducerContext, g: &ActiveGuest, kind: WcKind)
    -> Option<(String, f32, f32, u32)> {
    let rid = g.restaurant_id;
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    for other in ctx.db.active_guest().restaurant_id().filter(rid) {
        if other.id == g.id { continue; }
        if let Some(uid) = &other.wc_target_uid {
            if !uid.is_empty() { taken.insert(uid.clone()); }
        }
    }
    let predicate: fn(&str) -> bool = match kind {
        WcKind::Toilet => is_toilet_def,
        WcKind::Sink => is_sink_def,
    };
    // Phase I (H.99) — STRONG same-floor preference. Collect every
    // viable fixture with its (stand_xz, floor, dist²). First pick
    // the nearest on the guest's CURRENT floor; only if there's no
    // same-floor candidate do we fall back to cross-floor (nearest
    // by straight-line — stair-cost approximation is best-effort,
    // the client's pathwayDistance is the better solver). Without
    // this gate, an upstairs fixture a few metres closer in XZ
    // wins, sending guests up the stairs for a wash.
    // Phase 9.67 — SAME-FLOOR ONLY. The old cross-floor fallback
    // (same_floor_best.or(any_floor_best)) sent a guest with no toilet on
    // their storey walking to one on ANOTHER floor — but that cross-floor
    // WC walk glitched, leaving them "using a toilet on another floor" from
    // an empty spot on their own. Now a guest only uses a fixture on their
    // CURRENT floor. With none, the caller's wc_initiation_target is None,
    // so the existing give-up path (wc_giveup_triggered) keeps them seated +
    // proceeds to ordering — a mild "wanted but couldn't" nudge to put a
    // toilet on each floor — instead of a broken cross-floor walk.
    let mut best: Option<(String, f32, f32, u32)> = None;
    let mut best_dist = f32::INFINITY;
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        if f.floor != g.floor { continue; }
        if !predicate(&f.def_id) { continue; }
        if taken.contains(&f.uid) { continue; }
        let stand_x = f.x + f.rot_y.sin();
        let stand_z = f.z + f.rot_y.cos();
        let dx = stand_x - g.x;
        let dz = stand_z - g.z;
        let dist = dx * dx + dz * dz;
        if dist < best_dist {
            best_dist = dist;
            best = Some((f.uid.clone(), stand_x, stand_z, f.floor));
        }
    }
    best
}

/// H.12 — Server-side fallback seat assignment. Called from
/// tick_guest_state when a guest has been in "walkingIn" for
/// ASSIGN_SEAT_GRACE_MS without the client having mirrored a seat
/// target. Picks the closest unoccupied table.
///
/// Thin wrapper around `try_assign_seat_for` — see that for details.
fn try_assign_seat(ctx: &ReducerContext, g: &ActiveGuest) -> Option<(String, f32, f32, u32)> {
    try_assign_seat_for(ctx, g.restaurant_id, g.x, g.z, Some(g.id),
        Some((g.taste_decor_pref, g.taste_window_pref, &g.taste_diet)))
}

/// Phase I (H.89) — Generalised seat picker, callable both during
/// state-machine fallback (try_assign_seat) and during initial
/// spawn (try_spawn_arrival_guest). Previously the seat-pick logic
/// was wedged into try_assign_seat which required an existing
/// &ActiveGuest, so the spawn path couldn't reuse it — it instead
/// inserted with seat_uid="" and produced "ghost" guests that the
/// client could never render. H.84/H.86 disabled spawning entirely
/// to stop the ghost flood; this helper unblocks re-enabling it.
///
/// Returns (uid, x, z, floor) of the assigned table, or None if no
/// free table exists. Caller is responsible for writing it back to
/// the guest row.
///
/// `exclude_guest_id` is Some(id) when an existing guest is being
/// re-assigned (skip themselves in the occupancy check), or None
/// when called pre-insert during a fresh spawn (no self to skip).
///
/// "Unoccupied" = no other active_guest in the same restaurant has
/// this table's uid in their seat_uid field. Conservative — a guest
/// mid-meal still holds the seat even on their leaving leg
/// (intentional; prevents instant double-booking when one guest
/// leaves and another spawns the same tick).
///
/// Limitations vs the client's pickBestSeatForTaste:
/// - Distance-based pick only; no scoring on decor / window / taste /
///   diet. The client still owns the "good seat" decision when the
///   local sim is running; H.12 is a backstop for backgrounded tabs.
/// - Sets target = table center, not a chair slot. Visit-mode
///   subscribers see the guest standing at the table centre, not on
///   a specific chair. The client's local sim, if running, will
///   override with proper chair coords.
/// Phase 9.19 — Mirror the player's auto-shop stock target so the
/// errand dispatcher shops toward it. Owner-gated upsert.
#[reducer]
pub fn set_pantry_target(
    ctx: &ReducerContext,
    restaurant_id: u64,
    target: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set the pantry target".into());
    }
    let clamped = target.clamp(1, 200);
    if let Some(existing) = ctx.db.pantry_target().restaurant_id().find(restaurant_id) {
        if existing.target == clamped { return Ok(()); }
        ctx.db.pantry_target().restaurant_id().update(PantryTarget {
            target: clamped,
            ..existing
        });
    } else {
        ctx.db.pantry_target().insert(PantryTarget { restaurant_id, target: clamped });
    }
    log::info!("set_pantry_target: restaurant {} → {}", restaurant_id, clamped);
    Ok(())
}

/// Phase 9.7 — Replace the restaurant's seat_slot rows with the
/// client's freshly resolved seat list. Owner-only. Entries are
/// "seat_uid;x;z;floor;facing;plate_x;plate_z;at_bar" joined by "|".
/// Fired from FurnitureRegistry on every placement mutation (same
/// cadence as update_restaurant_aggregates) — a full replace keeps
/// the server's picture exact without tombstone bookkeeping.
#[reducer]
pub fn replace_seat_slots(
    ctx: &ReducerContext,
    restaurant_id: u64,
    slots_csv: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can replace seat slots".into());
    }
    let stale: Vec<String> = ctx.db.seat_slot()
        .restaurant_id().filter(restaurant_id)
        .map(|s| s.seat_uid.clone())
        .collect();
    for uid in stale {
        ctx.db.seat_slot().seat_uid().delete(uid);
    }
    // Phase 9.61 — clear the parallel seat_appeal rows too; they're
    // rewritten below from the extended CSV (fields 9-11).
    let stale_appeal: Vec<String> = ctx.db.seat_appeal()
        .restaurant_id().filter(restaurant_id)
        .map(|s| s.seat_uid.clone())
        .collect();
    for uid in stale_appeal {
        ctx.db.seat_appeal().seat_uid().delete(uid);
    }
    // Phase 9.62 — collect furniture appeal records ONCE so per-seat
    // scoring below is a cheap in-memory scan, not an O(seats×furniture)
    // table re-scan.
    let appeal_furn = collect_appeal_furniture(ctx, restaurant_id);
    let mut inserted = 0u32;
    for entry in slots_csv.split('|') {
        let parts: Vec<&str> = entry.split(';').collect();
        if parts.len() < 8 { continue; }
        let (Ok(x), Ok(z), Ok(floor), Ok(facing), Ok(px), Ok(pz)) = (
            parts[1].parse::<f32>(), parts[2].parse::<f32>(),
            parts[3].parse::<u32>(), parts[4].parse::<f32>(),
            parts[5].parse::<f32>(), parts[6].parse::<f32>(),
        ) else { continue };
        let seat_uid = parts[0].to_string();
        let at_bar = parts[7] == "1";
        ctx.db.seat_slot().insert(SeatSlot {
            seat_uid: seat_uid.clone(),
            restaurant_id,
            x, z, floor,
            facing_y: facing,
            plate_x: px,
            plate_z: pz,
            at_bar,
        });
        // Phase 9.62 — the SERVER computes the seat's taste appeal from
        // placed_furniture + furniture_meta (the client only sent the
        // chair position). seat_uid is "{tableUid}#{slotIndex}".
        let table_uid = seat_uid.split('#').next().unwrap_or("");
        let (decor_score, window_adj, surface) =
            compute_seat_appeal(ctx, &appeal_furn, x, z, floor, table_uid, at_bar);
        ctx.db.seat_appeal().insert(SeatAppeal {
            seat_uid,
            restaurant_id,
            decor_score,
            window_adj,
            surface,
        });
        inserted += 1;
    }
    log::info!("replace_seat_slots: restaurant {} now has {} seat slots", restaurant_id, inserted);
    Ok(())
}

/// Phase 9.6 — average visit rating × 100 from the cloud rating
/// history CSV. 300 (3.0★) when no history exists yet so brand-new
/// restaurants get a middling willingness-to-wait instead of zero.
fn avg_rating_x100(ctx: &ReducerContext, rid: u64) -> i64 {
    let csv = ctx.db.restaurant().id().find(rid)
        .and_then(|r| r.cloud_rating_history_csv)
        .unwrap_or_default();
    let mut sum = 0i64;
    let mut n = 0i64;
    for s in csv.split(',') {
        if let Ok(v) = s.trim().parse::<i64>() {
            sum += v;
            n += 1;
        }
    }
    if n == 0 { 300 } else { (sum * 100) / n }
}

/// Phase 9.6 — seat the longest-waiting "waiting" guest when a chair
/// frees up. Called every restaurant tick; cheap no-op when nobody
/// is waiting. The promoted guest re-enters the normal walkingIn →
/// seated flow toward the freshly assigned seat.
fn try_promote_waiting_guest(ctx: &ReducerContext, rid: u64) {
    let Some(g) = ctx.db.active_guest()
        .restaurant_id().filter(rid)
        // Accept both names: the client mirrors its local "waitingForSeat"
        // back over the server's "waiting" (see is_waiting_state / H.19), so
        // matching only the literal "waiting" left promoted-able guests
        // stranded outside forever even with the dining room empty.
        .find(|g| is_waiting_state(&g.state))
    else { return };
    let Some((seat_uid, sx, sz, sf)) = try_assign_seat_for(ctx, rid, g.x, g.z, Some(g.id),
        Some((g.taste_decor_pref, g.taste_window_pref, &g.taste_diet)))
    else { return };
    log::info!(
        "try_promote_waiting_guest: guest {} → seat {} in restaurant {}",
        g.id, seat_uid, rid,
    );
    ctx.db.active_guest().id().update(ActiveGuest {
        state: "walkingIn".to_string(),
        state_clock_ms: 0,
        seat_uid: seat_uid.clone(),
        seat_x: sx,
        seat_z: sz,
        // Phase 9.10 — real chair facing + bar flag from the slot row.
        seat_facing_y: ctx.db.seat_slot().seat_uid().find(seat_uid.clone())
            .map(|s| s.facing_y).unwrap_or(0.0),
        seat_at_bar: ctx.db.seat_slot().seat_uid().find(seat_uid)
            .map(|s| s.at_bar).unwrap_or(false),
        seat_floor: sf,
        plate_x: sx,
        plate_z: sz,
        target_x: sx,
        target_z: sz,
        target_floor: sf,
        waiting_chair_uid: String::new(),
        waiting_timeout_ms: 0,
        ..g
    });
}

fn try_assign_seat_for(
    ctx: &ReducerContext,
    rid: u64,
    from_x: f32,
    from_z: f32,
    exclude_guest_id: Option<u64>,
    // Phase 9.61 — (decor_pref, window_pref, diet) for taste-aware seat
    // scoring, restoring the seat-by-preference behaviour the client's
    // pickBestSeatForTaste lost when guest spawning went server-side.
    // None → nearest-seat (legacy). Some → score against the seat_appeal
    // mirror. Scoring only REORDERS free seats, never excludes one, so a
    // guest is always seated when a seat is free (no starvation risk even
    // if the appeal data is missing or wrong).
    taste: Option<(f32, f32, &str)>,
) -> Option<(String, f32, f32, u32)> {
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
    for other in ctx.db.active_guest().restaurant_id().filter(rid) {
        if let Some(self_id) = exclude_guest_id {
            if other.id == self_id { continue; }
        }
        if !other.seat_uid.is_empty() {
            taken_uids.insert(other.seat_uid.clone());
        } else if other.state == "walkingIn" {
            // Walking-in guest with no explicit seat assignment
            // (probably picked locally; cloud row's seat_uid lags
            // until/unless we add it to the mirror reducer).
            taken_targets.push((other.target_x, other.target_z));
        }
    }
    // Phase 9.45 — STRICT cleaning: a seat with leftover plates on it
    // (one or more dirty_pile rows) is UNSERVABLE until a waiter buses
    // it. Collect those seat_uids and treat them exactly like occupied
    // seats below. This is what makes "dirty plates stay there and the
    // seat is unservable until cleaned" real — without it, guests would
    // be seated straight into a pile of someone else's dishes.
    let dirty_uids: std::collections::HashSet<String> = ctx.db.dirty_pile()
        .restaurant_id().filter(rid)
        .map(|d| d.seat_uid)
        .collect();
    // Phase 9.58 — the 9.57 "staffed-floors gate" is REVERTED. Where a
    // customer sits is the player's + the customer's call, not the
    // dispatcher's: the player decides staffing, and the customer's taste
    // decides their floor. A floor left unstaffed simply loses the guests
    // who go there — that's the player's problem to fix, not something we
    // paper over by refusing to seat them. (The gate was also wrong for a
    // BAR-ONLY floor: a barman serves bar customers with no waiter at all.)
    // Phase 9.7 — prefer the REAL seat list the client mirrors into
    // seat_slot (one row per chair-at-table slot, uid in the client's
    // "{tableUid}#{slotIndex}" format). The legacy fallback below
    // guessed from furniture def_ids — which matched the TABLES, so
    // a 65-seat room read as ~17 "seats", guests rendered sitting on
    // tabletops, and none of the server's uids matched the client's
    // occupancy bookkeeping. Fallback only runs while a restaurant
    // has never pushed slots (pre-9.7 client).
    let mut best: Option<(String, f32, f32, u32)> = None;
    let mut best_score = f32::NEG_INFINITY;
    let mut best_dist = f32::INFINITY;
    let mut have_slots = false;
    for s in ctx.db.seat_slot().restaurant_id().filter(rid) {
        have_slots = true;
        if taken_uids.contains(&s.seat_uid) { continue; }
        if dirty_uids.contains(&s.seat_uid) { continue; } // 9.45 — unservable while dirty
        let occupied_by_target = taken_targets.iter().any(|(tx, tz)| {
            let dx = s.x - tx;
            let dz = s.z - tz;
            dx * dx + dz * dz < SEAT_OCCUPANCY_RADIUS_SQ
        });
        if occupied_by_target { continue; }
        let dx = s.x - from_x;
        let dz = s.z - from_z;
        let dist = dx * dx + dz * dz;
        // Phase 9.61 — taste-aware score. taste=None reduces to -dist
        // (nearest seat, the legacy pick). taste=Some lets decor / window /
        // diet appeal dominate, with distance as a small capped tiebreaker.
        // The appeal lookup defaults to neutral, so a seat with no mirrored
        // appeal just scores on distance — never excluded.
        let score = match taste {
            None => -dist,
            Some((decor_pref, window_pref, diet)) => {
                let mut sc = 0.0_f32;
                if let Some(app) = ctx.db.seat_appeal().seat_uid().find(s.seat_uid.clone()) {
                    sc += app.decor_score * decor_pref;
                    if app.window_adj { sc += 20.0 * window_pref; }
                    if !app.surface.is_empty() {
                        let is_drink = app.surface == "drink";
                        let matches = diet == "both"
                            || (diet == "drink" && is_drink)
                            || (diet == "food" && !is_drink);
                        // Strong but SOFT diet preference: a matching seat
                        // wins big, a mismatch is penalised but still
                        // seatable (prevents starvation when the only free
                        // seat is the "wrong" surface).
                        sc += if matches { 60.0 } else { -40.0 };
                    }
                }
                sc - dist.min(100.0) * 0.15
            }
        };
        if score > best_score {
            best_score = score;
            best = Some((s.seat_uid.clone(), s.x, s.z, s.floor));
        }
    }
    if have_slots { return best; }
    // Legacy fallback — def-id guess (tables as seats).
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        if !is_seat_providing_def(&f.def_id) { continue; }
        if taken_uids.contains(&f.uid) { continue; }
        if dirty_uids.contains(&f.uid) { continue; } // 9.45 — unservable while dirty
        // Skip chairs another guest is walking toward (catches the
        // local-pick race).
        let occupied_by_target = taken_targets.iter().any(|(tx, tz)| {
            let dx = f.x - tx;
            let dz = f.z - tz;
            dx * dx + dz * dz < SEAT_OCCUPANCY_RADIUS_SQ
        });
        if occupied_by_target { continue; }
        let dx = f.x - from_x;
        let dz = f.z - from_z;
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

/// Phase 9.64 (staff migration Pass 3-5) — the next world point to walk
/// toward when path-following: the first waypoint on the A* path that's
/// more than the arrival threshold from the current position (skips a
/// leading start-tile waypoint and the direct-line case). Falls back to
/// the target itself on an empty path, so a pathfinder miss never freezes
/// the actor (it just walks straight, the pre-9.64 behaviour). Same-floor
/// callers only — cross-floor stays on the straight-line step.
fn next_path_step(ctx: &ReducerContext, rid: u64, x: f32, z: f32, tx: f32, tz: f32, floor: u32) -> (f32, f32) {
    let path = crate::reducers::pathfinding::find_path(ctx, rid, x, z, tx, tz, floor);
    for (wx, wz) in path {
        let dx = wx - x;
        let dz = wz - z;
        if dx * dx + dz * dz > 0.04 {
            // > 0.2 m
            return (wx, wz);
        }
    }
    (tx, tz)
}

/// Same-floor pathfinding step: route around furniture toward (tx,tz)
/// via the nav-grid (next_path_step), then speed-cap the move. A
/// cross-floor leg (floor != target_floor) keeps the straight-line step —
/// the 2D pather can't model stairs, and those legs are pinned by
/// target_floor elsewhere. Used by guests + the waiter wash / seat-clean
/// sub-trips so they stop clipping through tables on their own floor.
fn path_step_same_floor(
    ctx: &ReducerContext,
    rid: u64,
    x: f32, z: f32,
    tx: f32, tz: f32,
    floor: u32, target_floor: u32,
    speed: f32, dt_ms: i64,
) -> (f32, f32) {
    if floor == target_floor {
        let (wx, wz) = next_path_step(ctx, rid, x, z, tx, tz, floor);
        step_toward_target(x, z, wx, wz, speed, dt_ms)
    } else {
        step_toward_target(x, z, tx, tz, speed, dt_ms)
    }
}

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

    // Phase 9.50 — POOLED dish (guest_id == 0): a cooked-but-ownerless
    // dish parked on the counter for reuse. It's exempt from the
    // guestless watchdog below (it has NO guest BY DESIGN). A "cooking"
    // pooled dish just keeps cooking → flips to "ready" via the normal
    // cooking branch, staying pooled. A "ready" pooled dish ages here:
    // if no new order claims it within POOL_EXPIRY_MS it spoils and is
    // discarded so the pool can't grow without bound.
    if t.guest_id == 0 {
        const POOL_EXPIRY_MS: i64 = 45_000;
        if t.state == "ready" {
            let advanced = t.state_clock_ms.saturating_add(dt_ms);
            if advanced >= POOL_EXPIRY_MS {
                log::info!(
                    "tick_ticket_state: pooled dish {} ({}) spoiled unclaimed — discarded",
                    t.id, t.recipe_id,
                );
                ctx.db.active_ticket().id().delete(t.id);
                return;
            }
            ctx.db.active_ticket().id().update(ActiveTicket { state_clock_ms: advanced, ..t });
            return;
        }
        if t.state != "cooking" {
            // Any other state for an ownerless dish is a dead end
            // (shouldn't occur) — discard it.
            ctx.db.active_ticket().id().delete(t.id);
            return;
        }
        // "cooking" falls through to the cooking branch below.
    }

    // Phase 9.14 — GUESTLESS-TICKET watchdog. The guest-despawn
    // cascade deletes a leaving guest's tickets, but a ticket
    // created in the same tick window can slip through and live
    // forever (observed: ids 3289/3412 queued for WEEKS while the
    // id counter reached 49600+ — permanently showing "1 queued",
    // wasting chef claim cycles, and pinning one reserved plate
    // each, which is exactly the dishware "LEAK 2"). Any ticket
    // whose guest row no longer exists is dead work: release the
    // chef and delete it, whatever state it's in. (Pooled dishes
    // with guest_id == 0 were already handled + returned above.)
    if t.guest_id != 0 && ctx.db.active_guest().id().find(t.guest_id).is_none() {
        log::info!(
            "tick_ticket_state: ticket {} ({}) has no guest {} — deleting fossil",
            t.id, t.state, t.guest_id,
        );
        if !t.assigned_chef_id.is_empty() {
            release_chef_from_ticket(ctx, &t.assigned_chef_id);
        }
        ctx.db.active_ticket().id().delete(t.id);
        return;
    }

    // Phase 9.10 — ORPHANED-DELIVERING watchdog. A ticket in
    // "delivering" must have a waiter actually carrying it
    // (staff_actor.ticket_id == this id). Guest-leave cascades,
    // releases and reassignments could strand a plate mid-walk with
    // no carrier — observed live as 16 "delivering" tickets with
    // idle chefs and starving guests, because NOTHING re-assigned a
    // carrier-less delivering ticket (auto-assign only scans
    // "ready"). Roll it back to "ready" so the next tick's
    // auto_assign_ready_tickets hands it to a real waiter.
    if t.state == "delivering" && !t.seat_at_bar {
        let has_carrier = ctx.db.staff_actor()
            .restaurant_id().filter(t.restaurant_id)
            .any(|a| a.ticket_id == Some(t.id));
        if !has_carrier {
            log::info!(
                "tick_ticket_state: ticket {} was delivering with NO carrier — rolled back to ready",
                t.id,
            );
            ctx.db.active_ticket().id().update(ActiveTicket {
                state: "ready".to_string(),
                state_clock_ms: 0,
                ..t
            });
            return;
        }
    }

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
    //
    // Phase H Phase 1 — also stamp pickup_x/z/floor from the assigned
    // chef's current position at the moment cooking finishes. Before
    // Phase 1 the local sim called finish_cooking with these coords
    // and the server tick just preserved whatever was set. With the
    // client no longer the source of truth, the server has to derive
    // pickup from the chef row (which carries the working position
    // because auto_claim_queued_tickets set target_x/z = station and
    // tick_staff_actor moved x/z to match). Without this, the waiter
    // dispatch would route to (0,0) for any ticket the local sim
    // didn't claim.
    if t.state == "cooking" {
        let advanced = t.state_clock_ms.saturating_add(dt_ms);
        if advanced >= t.cook_seconds_ms && t.cook_seconds_ms > 0 {
            let chef_id = t.assigned_chef_id.clone();
            let (px, pz, pf) = if !chef_id.is_empty() {
                ctx.db.staff_actor().member_id().find(chef_id.clone())
                    .map(|c| (c.x, c.z, c.floor))
                    .unwrap_or((t.pickup_x, t.pickup_z, t.pickup_floor))
            } else {
                (t.pickup_x, t.pickup_z, t.pickup_floor)
            };
            // Phase H Phase 4e — bar-seat split. Bar tickets bypass
            // the "ready" state (no waiter trip) and go straight to
            // "delivering" so the barman's own delivery dwell can
            // hold them at the counter. Matches local tickBarman's
            // working-state bar branch.
            let next_state = if t.seat_at_bar { "delivering" } else { "ready" };
            ctx.db.active_ticket().id().update(ActiveTicket {
                state: next_state.to_string(),
                state_clock_ms: 0,
                pickup_x: px,
                pickup_z: pz,
                pickup_floor: pf,
                ..t
            });
            // Phase H.7 — release the assigned chef when cooking
            // finishes (non-bar only). Auto-claim (H.6) hooked the
            // chef to this ticket; without a release, the chef
            // stays in "working" at the stove forever. Bar tickets
            // KEEP the barman assigned because they're the delivery
            // agent too — release happens after the delivering
            // dwell below.
            if !chef_id.is_empty() && !t.seat_at_bar {
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

    // Phase H Phase 4e — bar-seat "delivering" dwell. Bar tickets
    // skipped "ready" above; here we hold them at "delivering" for
    // a short visual beat (barman holds the drink/plate behind the
    // bar) before flipping to "delivered" + releasing the barman.
    // Non-bar tickets in "delivering" are waiter trips driven by
    // tick_staff_actor / advance_waiter_leg; tick_ticket_state
    // leaves those alone.
    const BAR_DELIVER_DWELL_MS: i64 = 800;
    if t.state == "delivering" && t.seat_at_bar {
        let advanced = t.state_clock_ms.saturating_add(dt_ms);
        if advanced >= BAR_DELIVER_DWELL_MS {
            let chef_id = t.assigned_chef_id.clone();
            ctx.db.active_ticket().id().update(ActiveTicket {
                state: "delivered".to_string(),
                state_clock_ms: 0,
                ..t
            });
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

    // Other states (queued / ready / delivering for non-bar) are
    // client/waiter-driven — tick_staff_actor and the StaffRouter
    // reducers transition them. Nothing to do here per-tick.
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
    patience_mult_x100: i32,
    will_wash_only: bool,
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
        // H.17 — initial patience pool matches the client's ORDER
        // budget × the archetype multiplier. A guest with mult=50
        // (impatient) gets 30 s; mult=150 (heavy customer) gets 90 s.
        // Bumped on ordering → waitingForFood to the SERVE pool below
        // in tick_guest_state.
        patience_ms: scale_patience(ORDER_PATIENCE_BASE_MS, patience_mult_x100),
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
        wc_target_uid: None,
        // H.14 — per-course appliance + cook-time CSVs. Populated by
        // set_guest_order once buildOrder has produced g.order.
        order_appliances: None,
        order_cook_seconds_csv: None,
        // H.15 — Door coords so leaving routes back here. spawn_guest
        // already takes the door params; just stash them.
        door_x,
        door_z,
        door_floor,
        // H.16 — Per-course price + satisfaction CSVs. Populated by
        // set_guest_order alongside order_recipes once buildOrder runs.
        order_prices_csv: None,
        order_satisfactions_csv: None,
        // H.17 — Stored so subsequent patience refreshes
        // (ordering → waitingForFood, eating → next-course) can
        // recompute SERVE pool × multiplier.
        patience_mult_x100,
        // H.23 — Always false at spawn; the seated → wcWalking branch
        // sets it on completion (wcWashing → seated) OR on give-up.
        used_toilet: false,
        // H.24 — mirrored from client; only one of (will_use_toilet,
        // will_wash_only) is true per guest (toilet takes priority).
        will_wash_only,
        washed_hands: false,
        // H.29 — latches separately from used_toilet / washed_hands
        // to distinguish "trip completed" from "gave up." False at
        // spawn; the wcWashing → seated transition flips it.
        wc_completed: false,
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
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else {
        // Anti-spam — a guest that already despawned (left, or patience ran
        // out) before this client-mirror reducer landed is a NORMAL race,
        // not an error. No-op gracefully; returning Err here surfaced as a
        // flood of uncaught SenderError "Guest <id> not found" on the client.
        return Ok(());
    };
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

/// H.19 — Client tells the server which overflow chair a guest is
/// parked on AND how many milliseconds remain on their give-up timer.
/// Called once at spawn (after the local sim picks a yellow chair
/// because no real seat was available) AND on each "shuffled to a
/// different chair" event if that ever happens. Empty chair_uid OR
/// timeout_ms <= 0 clears both fields — used when promoteWaitingGuests
/// hands the guest a real seat.
///
/// Without this, the server's H.5 timeout-leave branch is dormant
/// (waiting_timeout_ms stays at 0, the branch's `> 0` gate never
/// passes). For backgrounded-tab survival this guarantees that an
/// overflow-waitlisted guest still gets dropped after their give-up
/// window expires even when the local sim isn't ticking.
///
/// Idempotent on the wire: writing the same chair/timeout combo as
/// the row already holds is a no-op.
#[reducer]
pub fn set_guest_waiting_chair(
    ctx: &ReducerContext,
    guest_id: u64,
    chair_uid: String,
    timeout_ms: i64,
) -> Result<(), String> {
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else {
        // Anti-spam — a guest that already despawned (left, or patience ran
        // out) before this client-mirror reducer landed is a NORMAL race,
        // not an error. No-op gracefully; returning Err here surfaced as a
        // flood of uncaught SenderError "Guest <id> not found" on the client.
        return Ok(());
    };
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can manage guests".into());
    }
    // Clamp the incoming timeout — keep it non-negative. A non-positive
    // value combined with empty chair_uid is the "clear" path.
    let new_timeout = timeout_ms.max(0);
    if g.waiting_chair_uid == chair_uid && g.waiting_timeout_ms == new_timeout {
        return Ok(()); // idempotent
    }
    ctx.db.active_guest().id().update(ActiveGuest {
        waiting_chair_uid: chair_uid,
        waiting_timeout_ms: new_timeout,
        ..g
    });
    Ok(())
}

/// H.20 — Client tells the server which dish tiers it reserved for
/// this guest's courses. CSV of u32 strings parallel to order_recipes
/// — e.g. "3,3,2" means a 3-course visit where courses 1 + 2 use T3
/// dishware and course 3 uses T2. The server uses this on despawn
/// (settle_guest_dishes) to move eaten courses' plates into the
/// dirty pool and refund any unused reservations back to clean.
///
/// Called by GuestSpawner's mirrorGuestReservedTiers — fires after
/// each `g.reservedDishTiers.push(...)` AND on the periodic stream
/// while the CSV is growing. Idempotent on the wire.
///
/// Empty CSV is a no-op (don't clobber existing data with a stale
/// "no reservations yet" push that races a successful one).
#[reducer]
pub fn set_guest_reserved_tiers(
    ctx: &ReducerContext,
    guest_id: u64,
    tiers_csv: String,
) -> Result<(), String> {
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else {
        // Anti-spam — a guest that already despawned (left, or patience ran
        // out) before this client-mirror reducer landed is a NORMAL race,
        // not an error. No-op gracefully; returning Err here surfaced as a
        // flood of uncaught SenderError "Guest <id> not found" on the client.
        return Ok(());
    };
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can manage guests".into());
    }
    if tiers_csv.is_empty() || g.reserved_dish_tiers == tiers_csv {
        return Ok(()); // idempotent
    }
    ctx.db.active_guest().id().update(ActiveGuest {
        reserved_dish_tiers: tiers_csv,
        ..g
    });
    Ok(())
}

/// H.20 — Client tells the server "I already settled this guest's
/// dishware accounting locally; please skip the server-side path."
/// Called by GuestSpawner.settleGuestDishes BEFORE it mutates
/// Game.dishware (which then mirrors absolute pool counts via
/// updateDishwarePool). The ordering matters: this reducer must land
/// before the pool mirror so that when the row's despawn dwell later
/// elapses, `dishes_settled = true` makes the server-side
/// settle_guest_dishes a no-op — otherwise the same eaten/refunded
/// plates would be counted twice (once by the client mirror, once
/// by the server settlement).
///
/// Idempotent: re-setting an already-true flag is a no-op.
#[reducer]
pub fn mark_guest_dishes_settled(
    ctx: &ReducerContext,
    guest_id: u64,
) -> Result<(), String> {
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else {
        // Anti-spam — a guest that already despawned (left, or patience ran
        // out) before this client-mirror reducer landed is a NORMAL race,
        // not an error. No-op gracefully; returning Err here surfaced as a
        // flood of uncaught SenderError "Guest <id> not found" on the client.
        return Ok(());
    };
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can manage guests".into());
    }
    if g.dishes_settled {
        return Ok(()); // idempotent
    }
    ctx.db.active_guest().id().update(ActiveGuest {
        dishes_settled: true,
        ..g
    });
    Ok(())
}

/// H.20 — Server-side equivalent of GuestSpawner.settleGuestDishes.
/// Fired once from the despawn block right before the active_guest
/// row is deleted. Walks the parallel CSVs (reserved_dish_tiers +
/// order_appliances) and:
///
///   - courses 0..order_index (eaten) → dishware_pool.dirty++ for the
///     matching (kind, tier).
///   - courses order_index..end (unused / mid-flight at give-up) →
///     dishware_pool.clean++ instead.
///
/// Kind derives from order_appliances: "bar" → glass, everything else
/// → plate. Matches the client's `recipe.category === "drink"` test
/// because mirrorGuestOrder uses "bar" for drinks specifically.
///
/// Idempotency: caller checks dishes_settled BEFORE invoking, then
/// the despawn path deletes the row (so re-entry is impossible). The
/// dishes_settled flag flip is therefore optional — included as a
/// defense-in-depth marker in case future code reuses the row.
fn settle_guest_dishes(ctx: &ReducerContext, g: &ActiveGuest) {
    if g.dishes_settled { return; }
    let tiers: Vec<u32> = g.reserved_dish_tiers
        .split(',')
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .collect();
    if tiers.is_empty() { return; }
    let appliance_csv = g.order_appliances.as_deref().unwrap_or("");
    let appliances: Vec<&str> = appliance_csv.split(',').collect();
    let order_index = g.order_index as usize;
    for (i, &tier) in tiers.iter().enumerate() {
        let appliance = appliances.get(i).copied().unwrap_or("stove");
        let kind = if appliance == "bar" { "glass" } else { "plate" };
        let (clean_delta, dirty_delta) = if i < order_index {
            (0u32, 1u32) // eaten — plate hits the dirty pool
        } else {
            (1u32, 0u32) // reservation refund back to clean
        };
        bump_dishware(ctx, g.restaurant_id, kind, tier, clean_delta, dirty_delta);
        // Phase 9.23 — eaten course leaves a VISIBLE dirty pile on the
        // table. Pre-9.23 only the client's add_dirty_pile reducer
        // wrote these rows, and that path is gated off under Path B —
        // so dirty plates went invisible after the migration. The
        // server now writes the pile on its own despawn/settle; the
        // wash-trip completion deletes them (below). slot_index fans
        // up to 4 leftovers around the seat so they don't stack.
        if i < order_index && !g.seat_uid.is_empty() {
            ctx.db.dirty_pile().insert(DirtyPile {
                id: 0,
                restaurant_id: g.restaurant_id,
                seat_uid: g.seat_uid.clone(),
                kind: kind.to_string(),
                tier,
                slot_index: (i % 4) as i32,
                floor: g.seat_floor,
                x: g.seat_x,
                z: g.seat_z,
                claimed_by: String::new(),
            });
        }
    }
    log::info!(
        "settle_guest_dishes: guest {} ({} reservations, {} eaten)",
        g.id, tiers.len(), order_index.min(tiers.len()),
    );
}

/// Phase I (H.91) — Increment-only thin wrapper around the central
/// apply_pool_delta. Kept as a separate function only because
/// settle_guest_dishes uses u32 deltas (no decrements), so the
/// caller doesn't have to cast to i32 at every call site. Truly
/// negative-delta mutations go straight through apply_pool_delta.
fn bump_dishware(
    ctx: &ReducerContext,
    restaurant_id: u64,
    kind: &str,
    tier: u32,
    clean_delta: u32,
    dirty_delta: u32,
) {
    apply_pool_delta(
        ctx, restaurant_id, kind, tier,
        clean_delta as i32, dirty_delta as i32,
        "bump_dishware",
    );
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
/// H.11 / H.14 — Client tells the server which recipes the guest
/// ordered + per-course appliance + cook_seconds. The CSV trio is
/// parallel (same length).
///
/// H.14 extension: appliances_csv + cook_seconds_csv let the server
/// create active_ticket rows autonomously when the guest reaches
/// waitingForFood (H.14 auto_place_next_course). Without these the
/// server can only flip guest state; ticket creation still needs
/// the client's recipe catalog.
///
/// Idempotent: re-setting identical CSVs is a no-op. Client typically
/// calls this once per guest, right after buildOrder populates
/// g.order.
#[reducer]
pub fn set_guest_order(
    ctx: &ReducerContext,
    guest_id: u64,
    recipes_csv: String,
    appliances_csv: String,
    cook_seconds_csv: String,
    prices_csv: String,
    satisfactions_csv: String,
) -> Result<(), String> {
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else {
        // Anti-spam — a guest that already despawned (left, or patience ran
        // out) before this client-mirror reducer landed is a NORMAL race,
        // not an error. No-op gracefully; returning Err here surfaced as a
        // flood of uncaught SenderError "Guest <id> not found" on the client.
        return Ok(());
    };
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set guest orders".into());
    }
    // Anti-cheat / DoS guard — cap the order payload. A legit order is a handful
    // of courses; without this a modded owner client could send multi-MB CSVs
    // (DoS) or a huge course count to inflate money / leaderboard scores. [bug-sweep]
    const MAX_ORDER_CSV: usize = 512;
    if recipes_csv.len() > MAX_ORDER_CSV || appliances_csv.len() > MAX_ORDER_CSV
        || cook_seconds_csv.len() > MAX_ORDER_CSV || prices_csv.len() > MAX_ORDER_CSV
        || satisfactions_csv.len() > MAX_ORDER_CSV
        || recipes_csv.split(',').count() > 8 {
        return Err("Order payload too large".into());
    }
    let new_appliances = if appliances_csv.is_empty() { None } else { Some(appliances_csv) };
    let new_cook_seconds = if cook_seconds_csv.is_empty() { None } else { Some(cook_seconds_csv) };
    let new_prices = if prices_csv.is_empty() { None } else { Some(prices_csv) };
    let new_satisfactions = if satisfactions_csv.is_empty() { None } else { Some(satisfactions_csv) };
    if g.order_recipes == recipes_csv
        && g.order_appliances == new_appliances
        && g.order_cook_seconds_csv == new_cook_seconds
        && g.order_prices_csv == new_prices
        && g.order_satisfactions_csv == new_satisfactions {
        return Ok(()); // idempotent
    }
    ctx.db.active_guest().id().update(ActiveGuest {
        order_recipes: recipes_csv,
        order_appliances: new_appliances,
        order_cook_seconds_csv: new_cook_seconds,
        order_prices_csv: new_prices,
        order_satisfactions_csv: new_satisfactions,
        ..g
    });
    Ok(())
}

/// H.14 — Server-side place_order for the guest's current course.
/// Inserts an active_ticket row using:
///   - recipe_id from order_recipes[order_index]
///   - appliance from order_appliances[order_index]
///   - base_cook_seconds_ms from order_cook_seconds_csv[order_index]
///   - seat coords from active_guest
///
/// Skipped silently when:
///   - per-course CSVs aren't populated yet (set_guest_order hasn't
///     fired or the client's catalog access failed)
///   - order_index >= number of courses (no more to place)
///   - a ticket for this guest's current course already exists
///     (client raced us with its own place_order — idempotency
///     guard via guest_id+state filter)
///
/// Returns the new ticket id on success, None on any of the bail
/// conditions above. Caller uses this to know whether the place
/// succeeded for logging.
fn auto_place_next_course(ctx: &ReducerContext, g: &ActiveGuest, idx_override: Option<u32>) -> Option<u64> {
    // Phase H Phase 4c — if the order CSVs are empty (a foreground
    // client-spawned guest where Phase 4b gated the local
    // buildOrder + mirrorGuestOrder), build the order server-side
    // and persist back to the active_guest row so subsequent ticks
    // read the same recipes. Mirrors what try_server_spawn_guest
    // does at spawn for offline-spawned guests. Hash is the guest's
    // id so the order is deterministic on resume.
    let g_owned: ActiveGuest;
    let g: &ActiveGuest = if g.order_recipes.split(',').all(|s| s.trim().is_empty()) {
        let (recipes_csv, appliances_csv, cooks_csv, prices_csv, sats_csv)
            = build_server_order(ctx, g.restaurant_id, g.id);
        if recipes_csv.is_empty() {
            // Catalog not seeded or empty menu — bail. Guest will sit
            // in waitingForFood until patience runs out and leaves,
            // same as the foreground "kitchen can't fulfill" case.
            return None;
        }
        log::info!(
            "auto_place_next_course: built server-side order for guest {} → {} courses",
            g.id, recipes_csv.split(',').count(),
        );
        // Read a fresh owned row so we can do the structural update
        // (..fresh). Update the row, then re-fetch so the rest of the
        // function reads through the persisted values.
        let Some(fresh) = ctx.db.active_guest().id().find(g.id) else { return None; };
        ctx.db.active_guest().id().update(ActiveGuest {
            order_recipes: recipes_csv,
            order_appliances: Some(appliances_csv),
            order_cook_seconds_csv: Some(cooks_csv),
            order_prices_csv: Some(prices_csv),
            order_satisfactions_csv: Some(sats_csv),
            ..fresh
        });
        let Some(refetched) = ctx.db.active_guest().id().find(g.id) else { return None; };
        g_owned = refetched;
        &g_owned
    } else {
        g
    };

    let recipes: Vec<&str> = g.order_recipes
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let appliances: Vec<&str> = g.order_appliances.as_deref().unwrap_or("")
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let cook_seconds: Vec<i64> = g.order_cook_seconds_csv.as_deref().unwrap_or("")
        .split(',')
        .map(|s| s.trim().parse::<i64>().unwrap_or(0))
        .collect();
    // Need all three populated and aligned.
    if recipes.is_empty() || appliances.is_empty() || cook_seconds.is_empty() {
        return None;
    }
    // Phase 9.26 — idx_override lets the eating→waitingForFood next-
    // course path place the ticket for the ADVANCED course without
    // cloning the (non-Clone) guest row; falls back to g.order_index.
    let idx = idx_override.unwrap_or(g.order_index) as usize;
    if idx >= recipes.len() || idx >= appliances.len() || idx >= cook_seconds.len() {
        return None;
    }
    // Idempotency — skip if a non-terminal ticket for this guest
    // already exists (client raced us, or we already fired this tick).
    let already_pending = ctx.db.active_ticket().iter().any(|t|
        t.guest_id == g.id
        && (t.state == "queued" || t.state == "cooking" || t.state == "ready" || t.state == "delivering"));
    if already_pending {
        return None;
    }
    let recipe_id = recipes[idx].to_string();
    let appliance = appliances[idx].to_string();
    let base_cook_seconds_ms = cook_seconds[idx];

    // Phase 9.50 — COOKED-FOOD REUSE. Before spending ingredients on a
    // fresh cook, see if the pool already holds a dish of this exact
    // recipe — one a previous customer left behind (guest_id == 0),
    // still cooking or already plated. If so, claim it for THIS guest:
    // the chef's work + the ingredients aren't wasted, and the customer
    // is served faster. Point the dish at the new seat; its cook
    // progress (and "ready" pickup spot) carry over untouched. Oldest
    // pooled dish first (FIFO) so nothing lingers to spoil. This is the
    // "undelivered food waits on the counter and serves whoever orders
    // it next" mechanism — the chef never touches a customer.
    if let Some(pooled) = ctx.db.active_ticket().restaurant_id().filter(g.restaurant_id)
        .filter(|t| t.guest_id == 0
            && t.recipe_id == recipe_id
            && (t.state == "ready" || t.state == "cooking"))
        .min_by_key(|t| t.id)
    {
        let pid = pooled.id;
        let from_state = pooled.state.clone();
        ctx.db.active_ticket().id().update(ActiveTicket {
            guest_id: g.id,
            client_temp_id: format!("srv-{}-{}", g.id, idx),
            seat_x: g.seat_x,
            seat_z: g.seat_z,
            seat_floor: g.seat_floor,
            seat_at_bar: g.seat_at_bar,
            ..pooled
        });
        log::info!(
            "auto_place_next_course: guest {} course {} → REUSED pooled {} dish {} ({})",
            g.id, idx, from_state, pid, recipe_id,
        );
        return Some(pid);
    }

    // Phase H.37 — server-side ingredient consumption. Look up the
    // recipe's ingredient list and verify availability BEFORE
    // creating the ticket. Insufficient stock → skip; the guest
    // sits in waitingForFood until patience runs out and they
    // leave (matching what the foreground client does when the
    // kitchen can't fulfill an order).
    //
    // Unseeded recipes (recipe_ingredients table empty for this id)
    // return an empty vec, which silently succeeds — graceful
    // degradation so a brand-new account that hasn't seeded the
    // catalog yet doesn't deadlock its kitchen on every order.
    let needed = lookup_recipe_ingredients(ctx, &recipe_id);
    if !needed.is_empty() && !pantry_has_all(ctx, g.restaurant_id, &needed) {
        // Phase H.41 — server-side just-in-time auto-shop.  Foreground
        // play has EconomySystem.shopForMissing that buys the gap
        // on-demand; mirror that here so backgrounded restaurants
        // don't stall the moment a single ingredient runs out.
        // try_restock_pantry adds RESTOCK_UNITS per missing entry and
        // accrues the cost on Restaurant.pending_restock_cost_cents,
        // which the client drains on reconnect.
        try_restock_pantry(ctx, g.restaurant_id, &needed);
        // Re-check.  Restock may still fail (e.g. ingredient_cost
        // catalog hasn't seeded an entry — though try_restock_pantry
        // adds stock anyway in that case, so pantry_has_all will
        // succeed).  If a catastrophic case slips through (negative
        // quantity bug, etc.) we bail to avoid corrupting stock.
        if !pantry_has_all(ctx, g.restaurant_id, &needed) {
            log::info!(
                "auto_place_next_course: guest {} course {} → restock failed for {} (need {:?})",
                g.id, idx, recipe_id, needed,
            );
            return None;
        }
    }
    pantry_consume(ctx, g.restaurant_id, &needed);

    let inserted = ctx.db.active_ticket().insert(ActiveTicket {
        id: 0, // auto_inc
        restaurant_id: g.restaurant_id,
        guest_id: g.id,
        client_temp_id: format!("srv-{}-{}", g.id, idx),
        recipe_id,
        state: "queued".to_string(),
        state_clock_ms: 0,
        base_cook_seconds_ms,
        cook_seconds_ms: 0,
        appliance,
        assigned_chef_id: String::new(),
        seat_x: g.seat_x,
        seat_z: g.seat_z,
        seat_floor: g.seat_floor,
        seat_at_bar: g.seat_at_bar,
        pickup_x: 0.0,
        pickup_z: 0.0,
        pickup_floor: 0,
        created_at: ctx.timestamp,
    });
    log::info!(
        "auto_place_next_course: guest {} course {} → ticket {} ({}@{})",
        g.id, idx, inserted.id, inserted.recipe_id, inserted.appliance,
    );
    Some(inserted.id)
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
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else {
        // Anti-spam — a guest that already despawned (left, or patience ran
        // out) before this client-mirror reducer landed is a NORMAL race,
        // not an error. No-op gracefully; returning Err here surfaced as a
        // flood of uncaught SenderError "Guest <id> not found" on the client.
        return Ok(());
    };
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can move their guests".into());
    }
    // Phase 9.38 / 9.43 (migration stage 1) — the server is the sole
    // authority for these "in-progress" states; the local sim either
    // doesn't model them by the same name ("ordering" is collapsed into
    // "seated"; the WC sub-states are walkingToToilet/atToilet/… locally)
    // or shouldn't be allowed to wind them back. A foreground client's
    // position mirror kept pushing its local name over the server's,
    // which REGRESSES the guest and (below) resets state_clock_ms — e.g.
    // ping-ponging seated↔ordering so the take-order never completes
    // (9.38), or bouncing a WC trip. Don't let the mirror move a guest
    // OUT of a server-owned state except to a genuine "leaving"; the
    // position/target still update either way.
    let server_owned_state = matches!(g.state.as_str(),
        "ordering" | "wcWalking" | "wcSitting" | "wcWashing"
        // Keep the canonical waiting state too, so the client's
        // "waitingForSeat" mirror can't overwrite it and break promotion.
        | "waiting" | "waitingForSeat");
    // Only ADOPT a mirrored state the server actually models. The client also
    // renders local-only states (returningFromToilet, atToilet, walkingToWait,
    // ...) and mirrors them up verbatim; adopting one strands the row where the
    // watchdog then force-leaves a still-seated guest (cross-floor WC despawn).
    let new_state = if (server_owned_state && state != "leaving")
        || !server_models_guest_state(&state)
    {
        g.state.clone()
    } else {
        state
    };
    // Reset state_clock when the state label actually flips so the
    // server tick's countdown (eating timer, ordering wait) starts
    // from zero on the transition rather than carrying the prior
    // state's elapsed time forward.
    let state_changed = g.state != new_state;
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
    // pushes don't reset the despawn timer. (new_state computed above —
    // 9.38 guards it against regressing the server's "ordering".)
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
    let Some(g) = ctx.db.active_guest().id().find(guest_id) else {
        // Anti-spam — a guest that already despawned (left, or patience ran
        // out) before this client-mirror reducer landed is a NORMAL race,
        // not an error. No-op gracefully; returning Err here surfaced as a
        // flood of uncaught SenderError "Guest <id> not found" on the client.
        return Ok(());
    };
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can place orders".into());
    }

    // Phase H Phase 2 — server-authoritative pantry consumption on
    // the foreground hot path. Matches what auto_place_next_course
    // (the offline path) already does. Looks up the recipe's
    // ingredient list and decrements pantry_stock by 1 per
    // ingredient. If the kitchen is short on stock, attempt the
    // same just-in-time auto-shop the offline path uses; if that
    // still fails (catalog gap), allow the order anyway — the local
    // foreground client's EconomySystem.shopForMissing already
    // bought the gap before calling place_order, so the pantry will
    // refill via bump_pantry_stock right after.
    //
    // Unseeded recipes (empty ingredients vec) silently no-op,
    // matching auto_place_next_course's "graceful degradation"
    // semantics.
    let needed = lookup_recipe_ingredients(ctx, &recipe_id);
    if !needed.is_empty() && !pantry_has_all(ctx, g.restaurant_id, &needed) {
        try_restock_pantry(ctx, g.restaurant_id, &needed);
    }
    pantry_consume(ctx, g.restaurant_id, &needed);

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
/// Phase H.39 — Client mirrors a hired-staff roster entry. Called
/// from StaffSystem.addStaff on hire AND from training completion
/// (upgrade_level changes).  Idempotent upsert: a row with the same
/// (member_id, role, name, upgrade_level) is a no-op; level-up just
/// writes the new value.
///
/// Owner-only.  Cross-restaurant member_ids in the same browser
/// would conflict on the PK, but the client's makeMemberId namespaces
/// by role and counter so collisions are essentially impossible in
/// practice.
#[reducer]
pub fn set_hired_staff_member(
    ctx: &ReducerContext,
    restaurant_id: u64,
    member_id: String,
    role: String,
    name: String,
    upgrade_level: u32,
    is_deactivated: bool,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set staff".into());
    }
    if member_id.is_empty() || member_id.len() > 64 {
        return Err("member_id must be 1-64 chars".into());
    }
    let existing = ctx.db.hired_staff_member().member_id().find(member_id.clone());
    if let Some(m) = &existing {
        if m.restaurant_id == restaurant_id
            && m.role == role
            && m.name == name
            && m.upgrade_level == upgrade_level
            && m.is_deactivated == is_deactivated {
            return Ok(()); // idempotent
        }
    }
    // Preserve any in-flight H.44 training deadline across set_*
    // calls (e.g. a client-driven name change shouldn't cancel the
    // server's pending level-up).  The dedicated set_member_training_
    // deadline reducer is the only path that clears or sets this.
    let preserved_training_completes_at = existing.as_ref()
        .map(|m| m.training_completes_at_micros)
        .unwrap_or(0);
    let row = HiredStaffMember {
        member_id,
        restaurant_id,
        role,
        name,
        upgrade_level,
        training_completes_at_micros: preserved_training_completes_at,
        is_deactivated,
    };
    if existing.is_some() {
        ctx.db.hired_staff_member().member_id().update(row);
    } else {
        ctx.db.hired_staff_member().insert(row);
    }
    Ok(())
}

/// Phase H.39 — Client mirrors a fire by deleting the roster row.
/// Idempotent: missing member_id is a no-op.  staff_actor lifetime
/// is managed separately via unregister_staff_actor (the client
/// calls both on fire — unregister to drop the world actor, delete
/// here to drop the roster).
#[reducer]
pub fn delete_hired_staff_member(
    ctx: &ReducerContext,
    member_id: String,
) -> Result<(), String> {
    let Some(m) = ctx.db.hired_staff_member().member_id().find(member_id.clone()) else {
        return Ok(()); // idempotent
    };
    let r = ctx.db.restaurant().id().find(m.restaurant_id)
        .ok_or_else(|| "Staff member's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can delete staff".into());
    }
    ctx.db.hired_staff_member().member_id().delete(member_id);
    Ok(())
}

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
        // Don't reset a SERVER-BUSY actor on re-register. The client's
        // healHomeFloorIfStale re-registers whenever the LOCAL actor looks
        // idle at home, but the server row can be mid ticket/cook/wash/clean;
        // a blind reset orphaned the task (chef stops cooking, ticket stalls).
        // Mirror update_staff_actor's server_busy guard: if busy, only refresh
        // home/role and leave the in-flight task to the server to finish.
        let prev_busy = prev.ticket_id.is_some()
            || prev.take_order_guest_id.is_some()
            || !prev.assigned_stove_uid.is_empty()
            || !prev.wash_target_uid.is_empty()
            || prev.clean_seat_uid.is_some();
        if prev_busy {
            ctx.db.staff_actor().member_id().update(StaffActor {
                role, home_floor, home_x, home_z,
                ..prev
            });
            return Ok(());
        }
        // Idle actor — full reset is fine (rehire / lingering old row).
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
            // Phase H Phase 5.1 — clear any in-flight errand state on
            // re-register. Re-register fires on save reload + client
            // re-bind, both of which should reset trip state.
            errand_phase: None,
            errand_trip_list_csv: None,
            errand_offscreen_until_micros: 0,
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
        // Phase H Phase 5.1 — errand-trip fields default to idle.
        errand_phase: None,
        errand_trip_list_csv: None,
        errand_offscreen_until_micros: 0,
        clean_seat_uid: None, // Phase 9.45 — not cleaning at spawn
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
    // Phase 9.43 (migration stage 1) — the server owns a staff actor's
    // TASK (its ticket/order/station binding + the state machine around
    // it; tick_staff_actor advances it every tick). While the actor is
    // mid-task, a foreground client's mirror must NOT regress its state
    // or drop the binding — the client still runs its own staff sim, and
    // a stale/stuck LOCAL actor (e.g. a frozen "→ pickup" waiter) would
    // otherwise stomp the server's healthy one. So when the server has
    // the actor bound to work, only the BODY POSITION follows the client;
    // everything else stays server-authoritative. (If this ever exposed
    // a server-side release gap, the 9.42 health scan flags the resulting
    // waiter_starved / backlog so it's visible rather than silent.)
    let server_busy = a.ticket_id.is_some()
        || a.take_order_guest_id.is_some()
        || !a.assigned_stove_uid.is_empty()
        || !a.wash_target_uid.is_empty()
        || a.clean_seat_uid.is_some(); // 9.45 — mid seat-clean trip
    if server_busy {
        // Phase 9.46 — IGNORE the client's mirrored position for a
        // server-busy actor. Pre-9.46 we adopted the client's x/z/floor
        // ("body follows the client"). But the client still runs its own
        // staff sim, and whenever it DIVERGES — the local waiter never
        // picked up the server's task and sits idle at its local home —
        // that stale position got mirrored back ~once a second and
        // OVERWROTE the straight-line step tick_staff_actor had just
        // taken toward the task target. Net effect: the waiter ran in
        // place, never reached the seat, the guest's patience expired,
        // and the room bled walkouts while EVERY waiter read as "busy."
        // (Diagnosed live: 12/12 waiters bound, 0 idle, positions frozen
        // ~6 units from their targets, 48% walkout.) The server's own
        // movement is the trustworthy driver — it's what powers offline
        // play — so for busy actors we keep the server position and drop
        // the mirror on the floor. Idle / returning actors (not busy)
        // still adopt the client position below, so a player dragging an
        // idle waiter around still works.
        return Ok(());
    }
    // Phase 9.48 — POSITION-ONLY mirror. The server now owns the ENTIRE
    // staff state machine + every task binding (dispatch sets them,
    // tick_staff_actor advances + releases them). The client mirror must
    // NOT write state / ticket_id / assigned_stove_uid / take_order /
    // wash fields: the local sim diverges, and in the brief window after
    // the server released a chef (returningHome, momentarily not busy)
    // it mirrored back state="working" + a stale ticket_id, re-pinning
    // the chef to a phantom task that then vanished — the dead-binding
    // bug the watchdog above had to clean up. Pre-9.48 this "non-busy"
    // branch trustingly copied all those client fields. Now it accepts
    // ONLY the body position (so a locally-rendered idle wander still
    // shows for an idle actor) and preserves every server-owned field.
    // The remaining params are part of the (frozen) reducer signature
    // the client bindings call with — consumed here, intentionally
    // unused, so the ABI is unchanged.
    let _ = (
        state, ticket_id, target_x, target_z, target_floor,
        assigned_stove_uid, last_stove_uid, wash_target_uid,
        wash_dirty_id, wash_phase, take_order_guest_id,
    );
    ctx.db.staff_actor().member_id().update(StaffActor { x, z, floor, ..a });
    Ok(())
}

/// Drop a staff actor's row (fired / restaurant deleted /
/// player-explicit despawn). Idempotent: missing actor is a no-op.
///
/// Phase H Phase 5.1+ — Dedicated mirror reducer for errand-helper
/// trip state. Separate from update_staff_actor so we don't have to
/// update every existing caller's call shape (chef / waiter / barman
/// mirrors are noisy and shouldn't carry errand-specific fields).
/// Owner-only; idempotent for identical payloads.
#[reducer]
pub fn set_errand_state(
    ctx: &ReducerContext,
    member_id: String,
    phase: Option<String>,
    trip_list_csv: Option<String>,
    offscreen_until_micros: i64,
) -> Result<(), String> {
    let a = ctx.db.staff_actor().member_id().find(member_id.clone())
        .ok_or_else(|| format!("Staff actor {member_id} not found"))?;
    let r = ctx.db.restaurant().id().find(a.restaurant_id)
        .ok_or_else(|| "Restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can update this actor".into());
    }
    if a.role != "errand" {
        // Not catastrophic — just ignore. The local code only fires
        // this for errand role, so a non-errand call means a wiring
        // bug worth surfacing as a soft error rather than corrupting
        // the row.
        return Err(format!("Actor {member_id} is role {}, not errand", a.role));
    }
    ctx.db.staff_actor().member_id().update(StaffActor {
        errand_phase: phase,
        errand_trip_list_csv: trip_list_csv,
        errand_offscreen_until_micros: offscreen_until_micros,
        ..a
    });
    Ok(())
}

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
        ctx.db.dishwasher_batch().furniture_uid().delete(uid.clone());
    }
    // Phase 9.6 — selling a seat out from under its diners evicts
    // them DISSATISFIED. seat_uid is either the furniture uid itself
    // (server-assigned) or "<uid>#<slot>" (client-assigned table
    // slots); prefix-with-# match covers both without false matches
    // on uids that merely share a prefix. patience_ms pinned to 0 is
    // the dissatisfaction signal the rollup reads (rating 1★); the
    // standard leaving dwell despawns + settles them.
    let evictees: Vec<ActiveGuest> = ctx.db.active_guest()
        .restaurant_id().filter(existing.restaurant_id)
        .filter(|g| !is_leaving_state(&g.state)
            && (g.seat_uid == uid
                || g.seat_uid.starts_with(&format!("{uid}#"))
                || g.waiting_chair_uid == uid))
        .collect();
    for g in evictees {
        log::info!(
            "sell_furniture: evicting guest {} (seat {} sold) — leaving dissatisfied",
            g.id, uid,
        );
        ctx.db.active_guest().id().update(ActiveGuest {
            state: "leaving".to_string(),
            state_clock_ms: 0,
            patience_ms: 0,
            target_x: 0.0,
            target_z: 0.0,
            target_floor: 0,
            ..g
        });
    }
    // Anti-cheat — under the money cutover the client's earn() no-ops, so
    // credit the server-authoritative sell-back here, priced from the
    // furniture_cost catalog (seeded from the client's exact refund
    // formula). Falls back to half the scaled cost until refund_cents is
    // reseeded by an admin load. Off-cutover this is skipped — the client
    // credits locally as before. NOTE: undo-of-place also routes through
    // sell_furniture, so under the cutover an undo refunds the 50% sell
    // value, not the full purchase price.
    if money_cutover_active(ctx) {
        let refund_cents = ctx.db.furniture_cost().def_id().find(existing.def_id.clone())
            .map(|c| if c.refund_cents > 0 { c.refund_cents } else { c.cost_cents / 2 })
            .unwrap_or(0);
        if refund_cents > 0 {
            if let Some(rr) = ctx.db.restaurant().id().find(existing.restaurant_id) {
                ctx.db.restaurant().id().update(Restaurant {
                    cloud_money_cents: rr.cloud_money_cents.saturating_add(refund_cents),
                    ..rr
                });
            }
        }
    }
    Ok(())
}

/// QoL storage — like sell_furniture, but the item is banked into the
/// owner's furniture_inventory (NO refund) so it can be re-placed for
/// free later. Same cascade as sell (dishwasher batch + evict diners
/// whose seat vanished). Idempotent: a missing uid is a no-op.
#[reducer]
pub fn store_furniture(ctx: &ReducerContext, uid: String) -> Result<(), String> {
    let existing = match ctx.db.placed_furniture().uid().find(uid.clone()) {
        Some(f) => f,
        None => return Ok(()),
    };
    let r = ctx.db.restaurant().id().find(existing.restaurant_id)
        .ok_or_else(|| "Item's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can store their furniture".into());
    }
    ctx.db.placed_furniture().uid().delete(uid.clone());
    if ctx.db.dishwasher_batch().furniture_uid().find(uid.clone()).is_some() {
        ctx.db.dishwasher_batch().furniture_uid().delete(uid.clone());
    }
    // Evict diners whose seat just vanished (mirror sell_furniture's
    // eviction — patience 0 = the 1★ dissatisfaction signal).
    let evictees: Vec<ActiveGuest> = ctx.db.active_guest()
        .restaurant_id().filter(existing.restaurant_id)
        .filter(|g| !is_leaving_state(&g.state)
            && (g.seat_uid == uid
                || g.seat_uid.starts_with(&format!("{uid}#"))
                || g.waiting_chair_uid == uid))
        .collect();
    for g in evictees {
        ctx.db.active_guest().id().update(ActiveGuest {
            state: "leaving".to_string(),
            state_clock_ms: 0,
            patience_ms: 0,
            target_x: 0.0,
            target_z: 0.0,
            target_floor: 0,
            ..g
        });
    }
    // Bank into inventory: +1 qty for (restaurant, def_id). No money
    // moves — the player gets the item back, not cash.
    let inv_id = format!("{}:{}", existing.restaurant_id, existing.def_id);
    if let Some(inv) = ctx.db.furniture_inventory().id().find(inv_id.clone()) {
        ctx.db.furniture_inventory().id().update(FurnitureInventory {
            qty: inv.qty.saturating_add(1),
            ..inv
        });
    } else {
        ctx.db.furniture_inventory().insert(FurnitureInventory {
            id: inv_id,
            restaurant_id: existing.restaurant_id,
            def_id: existing.def_id.clone(),
            qty: 1,
        });
    }
    log::info!("store_furniture: {} ({}) → storage", uid, existing.def_id);
    Ok(())
}

/// QoL storage — place an item the owner has in furniture_inventory back
/// onto the floor for FREE (no money debit), decrementing its stored
/// qty. Errors if nothing of that def is in storage. Mirrors
/// place_furniture's row shape so the client reuses its normal
/// placement bookkeeping (it just skips the spend on this path).
#[reducer]
pub fn place_from_inventory(
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
    let inv_id = format!("{restaurant_id}:{def_id}");
    let inv = ctx.db.furniture_inventory().id().find(inv_id.clone())
        .filter(|i| i.qty > 0)
        .ok_or_else(|| format!("No {def_id} in storage"))?;
    // Decrement (delete the row at zero) BEFORE inserting so a failure
    // can't double-spend the stored copy.
    if inv.qty <= 1 {
        ctx.db.furniture_inventory().id().delete(inv_id);
    } else {
        ctx.db.furniture_inventory().id().update(FurnitureInventory {
            qty: inv.qty - 1,
            ..inv
        });
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

/// QoL layout — save/overwrite a named layout preset for a restaurant.
/// `layout_json` is the client's serialized snapshot() (PersistedPlacement[]).
#[reducer]
pub fn save_layout_preset(
    ctx: &ReducerContext,
    restaurant_id: u64,
    name: String,
    layout_json: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can save layouts".into());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Layout name can't be empty".into());
    }
    if name.chars().count() > 40 {
        return Err("Layout name too long".into());
    }
    let id = format!("{restaurant_id}:{name}");
    let row = LayoutPreset { id: id.clone(), restaurant_id, name, layout_json };
    if ctx.db.layout_preset().id().find(id).is_some() {
        ctx.db.layout_preset().id().update(row);
    } else {
        ctx.db.layout_preset().insert(row);
    }
    Ok(())
}

/// QoL layout — delete a named preset. Idempotent.
#[reducer]
pub fn delete_layout_preset(
    ctx: &ReducerContext,
    restaurant_id: u64,
    name: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can delete layouts".into());
    }
    let id = format!("{}:{}", restaurant_id, name.trim());
    ctx.db.layout_preset().id().delete(id);
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
    // Phase I (H.93) — per-piece tier lists. CSV strings, "5,5,3"
    // means three plates (T5, T5, T3). Empty string == "no tier
    // info" — flush falls back to legacy tier picking for those.
    plates_tiers: String,
    glasses_tiers: String,
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
        plates_tiers: if plates_tiers.is_empty() { None } else { Some(plates_tiers) },
        glasses_tiers: if glasses_tiers.is_empty() { None } else { Some(glasses_tiers) },
    };
    if ctx.db.dishwasher_batch().furniture_uid().find(furniture_uid).is_some() {
        ctx.db.dishwasher_batch().furniture_uid().update(row);
    } else {
        ctx.db.dishwasher_batch().insert(row);
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────
// Phase I (H.B) — dirty_pile reducers.
//
// One row per dirty plate / glass left on a table by a guest who
// finished their meal. Lifecycle:
//
//   add_dirty_pile      — fired when a guest leaves (host's local
//                         sim or, future H.C, server settle_guest
//                         _dishes). Server assigns an auto_inc id.
//   claim_dirty_pile    — waiter starts a wash trip targeting this
//                         row. Reject if already claimed by someone
//                         else. Returns id so the caller can stash it.
//   release_dirty_pile  — waiter aborts the trip (mesh vanished,
//                         re-route, fired mid-walk). Frees the claim.
//   pickup_dirty_pile   — waiter arrived at the table; row is
//                         deleted, dish goes to the wash queue (the
//                         caller's existing washOne / loadDishwasher
//                         path handles the pool side).
//
// All reducers verify the row belongs to a restaurant the sender
// owns — prevents another player griefing your dirty piles.

#[reducer]
pub fn add_dirty_pile(
    ctx: &ReducerContext,
    restaurant_id: u64,
    seat_uid: String,
    kind: String,
    tier: u32,
    slot_index: i32,
    floor: u32,
    x: f32,
    z: f32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can add dirty piles".into());
    }
    if kind != "plate" && kind != "glass" {
        return Err(format!("Unknown dishware kind: {kind}"));
    }
    ctx.db.dirty_pile().insert(DirtyPile {
        id: 0, // auto_inc
        restaurant_id,
        seat_uid,
        kind,
        tier: tier.clamp(1, 5),
        slot_index,
        floor,
        x, z,
        claimed_by: String::new(),
    });
    Ok(())
}

#[reducer]
pub fn claim_dirty_pile(ctx: &ReducerContext, id: u64, member_id: String) -> Result<(), String> {
    let row = ctx.db.dirty_pile().id().find(id)
        .ok_or_else(|| format!("Dirty pile {id} not found"))?;
    let r = ctx.db.restaurant().id().find(row.restaurant_id)
        .ok_or_else(|| "Restaurant for dirty pile not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can claim dirty piles".into());
    }
    if !row.claimed_by.is_empty() && row.claimed_by != member_id {
        return Err(format!("Already claimed by {}", row.claimed_by));
    }
    ctx.db.dirty_pile().id().update(DirtyPile {
        claimed_by: member_id,
        ..row
    });
    Ok(())
}

#[reducer]
pub fn release_dirty_pile(ctx: &ReducerContext, id: u64) -> Result<(), String> {
    let row = ctx.db.dirty_pile().id().find(id);
    let Some(row) = row else { return Ok(()); }; // already gone — idempotent
    let r = ctx.db.restaurant().id().find(row.restaurant_id)
        .ok_or_else(|| "Restaurant for dirty pile not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can release dirty piles".into());
    }
    ctx.db.dirty_pile().id().update(DirtyPile {
        claimed_by: String::new(),
        ..row
    });
    Ok(())
}

#[reducer]
pub fn pickup_dirty_pile(ctx: &ReducerContext, id: u64) -> Result<(), String> {
    let row = ctx.db.dirty_pile().id().find(id);
    let Some(row) = row else { return Ok(()); }; // already gone — idempotent
    let r = ctx.db.restaurant().id().find(row.restaurant_id)
        .ok_or_else(|| "Restaurant for dirty pile not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can pickup dirty piles".into());
    }
    ctx.db.dirty_pile().id().delete(id);
    Ok(())
}

/// Phase I (H.B) — Host-side mirror cleanup. The local sim's
/// pickupDirty(id) uses a LOCAL numeric id namespace that doesn't
/// match the cloud's auto_inc id; rather than thread a
/// localId→cloudId map through the wash trip plumbing, this reducer
/// deletes ONE matching unclaimed pile by (seat_uid, kind) so the
/// mirror eventually drains as the local sim picks plates up.
///
/// Behavior:
///   - Looks up the FIRST dirty_pile row in restaurant_id where
///     seat_uid + kind match AND claimed_by is empty.
///   - Deletes that row. No-op if no match (idempotent).
///
/// Race window: if two pickups for the same seat+kind fire in the
/// same tick, both delete different matching rows — which is the
/// correct outcome (two physical piles → two cloud rows → two
/// deletes). The "first match" semantics matter only when there's
/// just one row and it gets stale: a second pickup is a no-op.
#[reducer]
pub fn pickup_dirty_pile_by_seat(
    ctx: &ReducerContext,
    restaurant_id: u64,
    seat_uid: String,
    kind: String,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can pickup dirty piles".into());
    }
    let target_id = ctx.db.dirty_pile()
        .restaurant_id().filter(restaurant_id)
        .find(|p| p.seat_uid == seat_uid && p.kind == kind && p.claimed_by.is_empty())
        .map(|p| p.id);
    if let Some(id) = target_id {
        ctx.db.dirty_pile().id().delete(id);
    }
    Ok(())
}
