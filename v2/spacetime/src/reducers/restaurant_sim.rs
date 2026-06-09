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
    active_guest, active_menu, active_ticket, customer_archetype, dirty_pile,
    dishware_pool, dishwasher_batch, hired_staff_member, ingredient_cost, pantry_stock,
    placed_furniture, player, player_save, recipe_ingredients, recipe_level, recipe_meta,
    recipe_upgrade_in_flight, restaurant, restaurant_tick_schedule,
    restaurant_tick_state, staff_actor,
    ActiveGuest, ActiveMenu, ActiveTicket, CustomerArchetypeDef, DirtyPile, DishwarePool,
    DishwasherBatch, HiredStaffMember, IngredientCost, PantryStock, PlacedFurniture,
    RecipeIngredients, RecipeLevel, RecipeMeta, RecipeUpgradeInFlight, Restaurant,
    RestaurantTickSchedule, RestaurantTickState, StaffActor,
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
    for guest_id in guest_ids {
        tick_guest_state(ctx, guest_id, dt_ms);
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

    // Phase H.8 — auto-assign ready tickets to idle waiters. Same
    // pattern as H.6 but for the delivery side of the kitchen
    // workflow. Without this, plates would sit at the pickup spot
    // forever in a backgrounded tab. With it, the server pairs each
    // ready ticket with an idle waiter, sets their target to the
    // plate's pickup position, and marks the ticket "delivering".
    // The two-leg waiter trip (pickup → seat) is encoded in the new
    // delivery_phase field, which tick_staff_actor reads on arrival.
    auto_assign_ready_tickets(ctx, rid);

    // Phase H.34 — take-order dispatch. Picks idle waiters and walks
    // them to seated/ordering guests who don't yet have a waiter en
    // route. Foreground client owns this when alive; this branch is
    // the backgrounded fallback so a reconnecting player sees the
    // waiter actually finishing the order trip instead of the guest
    // having already advanced via ORDERING_FALLBACK_MS. Gated on the
    // owner being offline (same heuristic as H.33's arrival handoff).
    try_dispatch_take_order(ctx, rid);

    // Phase H.35 — wash trip dispatch. Cosmetic for the offline case:
    // walks an idle waiter through a pseudo-pickup (any table) → wash
    // station (sink or dishwasher) → home cycle when dirty stock + an
    // available waiter both exist. Doesn't touch dishware_pool itself
    // (H.21's instantaneous loader still owns inventory motion); the
    // benefit is a reconnecting player sees waiters in motion rather
    // than idle staff next to magically-clean dishes. Same offline
    // guard pattern as H.33/H.34.
    try_dispatch_wash_trip(ctx, rid);

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
fn tick_day_clock(ctx: &ReducerContext, rid: u64, dt_ms: i64) {
    let Some(r) = ctx.db.restaurant().id().find(rid) else { return; };
    let mut elapsed = r.day_elapsed_ms.saturating_add(dt_ms);
    let mut pending = r.pending_days_advanced;
    while elapsed >= DAY_LENGTH_MS {
        elapsed -= DAY_LENGTH_MS;
        pending = pending.saturating_add(1);
    }
    if elapsed == r.day_elapsed_ms && pending == r.pending_days_advanced {
        return; // no change worth a write
    }
    ctx.db.restaurant().id().update(Restaurant {
        day_elapsed_ms: elapsed,
        pending_days_advanced: pending,
        ..r
    });
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
    if r.cloud_money_cents == money_cents {
        return Ok(());
    }
    ctx.db.restaurant().id().update(Restaurant {
        cloud_money_cents: money_cents,
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
    {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        cloud_daily_revenue_cents: revenue_cents,
        cloud_daily_expenses_cents: expenses_cents,
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
    if pool.is_empty() { return None; }
    let mut best_idx = 0usize;
    let mut best_dist = staff_dist_to(&pool[0], tx, tz, t_floor);
    for (i, a) in pool.iter().enumerate().skip(1) {
        let d = staff_dist_to(a, tx, tz, t_floor);
        if d < best_dist {
            best_dist = d;
            best_idx = i;
        }
    }
    Some(pool.swap_remove(best_idx))
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
            // Cheapest actor for this candidate station.
            let mut local_best: Option<(usize, f32)> = None;
            for (i, a) in pool.iter().enumerate() {
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
        .restaurant_id().filter(rid)
        .filter(|t| t.state == "ready")
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
/// Tip approximation: tipMultByRating[rating] × archetype.tipMultiplier
/// × weatherMult — but archetype mult + weather mult require state
/// the server doesn't carry yet, so we use 1.0× / 1.0× and only the
/// rating-derived rate. Better than dropping all tips.
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
            "stove" | "stove-electric" => stove_count += 1,
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

    // tipMultByRating: 1 → 0%, 2 → 0%, 3 → 5%, 4 → 15%, 5 → 30%.
    // Stored × 1000 (basis points scaled by 10) for integer math.
    let tip_rate_per_mille: i64 = match rating {
        3 => 50,
        4 => 150,
        5 => 300,
        _ => 0,
    };
    let tip_cents = (g.total_paid_cents.saturating_mul(tip_rate_per_mille)) / 1_000;

    // Read-modify-write the Restaurant row. If the row disappeared
    // (sell-mid-flight), skip silently.
    let Some(r) = ctx.db.restaurant().id().find(g.restaurant_id) else { return; };
    ctx.db.restaurant().id().update(Restaurant {
        pending_served: r.pending_served.saturating_add(1),
        pending_tips_cents: r.pending_tips_cents.saturating_add(tip_cents),
        pending_rating_sum_x100: r.pending_rating_sum_x100.saturating_add(rating as i64 * 100),
        pending_rating_count: r.pending_rating_count.saturating_add(1),
        // H.32 — also credit the tip to cloud_money_cents so other
        // clients see the running balance climb live during a
        // backgrounded session. The reconnecting owner's applyPending
        // path still credits Game.economy.earnMoney(pending) — the
        // foreground client's NEXT set_cloud_money tick after that
        // earn lands the local + tips total back on this column, so
        // the cloud value gets a one-frame "down + back up" blip
        // rather than double-counting.
        cloud_money_cents: r.cloud_money_cents.saturating_add(tip_cents),
        ..r
    });
    log::info!(
        "accumulate_pending_visit_rollup: guest {} → restaurant {} (rating={}, tip={} cents)",
        g.id, g.restaurant_id, rating, tip_cents,
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
    if new_qty == 0 {
        if existing.is_some() {
            ctx.db.pantry_stock().key().delete(key);
        }
        return Ok(());
    }
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

/// Phase H.53 — TIER_BASE_PROFIT in cents.  Matches the client's
/// [0, 3, 4, 5, 6, 7] × 100 dollars.  Indexed by recipe tier
/// (1..5); tier 0 is a degenerate "unknown" that contributes no
/// profit bonus.  Same shape as the client constant.
const TIER_BASE_PROFIT_CENTS: [i64; 6] = [0, 300, 400, 500, 600, 700];

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
    //   price = base + (level - 1) × TIER_BASE_PROFIT[tier]
    //   sat   = base + (level - 1) × 1.5  (× 100 here)
    let prices: Vec<String> = courses.iter().map(|c| {
        let level = recipe_level_for(ctx, restaurant_id, &c.recipe_id);
        let tier_idx = (c.tier as usize).min(TIER_BASE_PROFIT_CENTS.len() - 1);
        let bonus_per_level = TIER_BASE_PROFIT_CENTS[tier_idx];
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
        if let Some(p) = ctx.db.pantry_stock().key().find(key.clone()) {
            let new_qty = p.quantity.saturating_sub(1);
            if new_qty == 0 {
                ctx.db.pantry_stock().key().delete(key);
            } else {
                ctx.db.pantry_stock().key().update(PantryStock {
                    quantity: new_qty,
                    ..p
                });
            }
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
    let row = IngredientCost { ingredient_id, cost_cents };
    if existing.is_some() {
        ctx.db.ingredient_cost().ingredient_id().update(row);
    } else {
        ctx.db.ingredient_cost().insert(row);
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
    // Roll up the cost onto the restaurant row so the next foreground
    // reconnect can debit the player.
    if accrued_cents > 0 {
        if let Some(r) = ctx.db.restaurant().id().find(restaurant_id) {
            let new_total = r.pending_restock_cost_cents.saturating_add(accrued_cents);
            ctx.db.restaurant().id().update(Restaurant {
                pending_restock_cost_cents: new_total,
                ..r
            });
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

/// Phase H.45 — Per-restaurant tick.  When the owner has been offline
/// past the threshold AND a base payroll rate has been mirrored AND
/// the restaurant has staff, accrue cents into pending_salary_cost_cents.
///
/// On the very first tick after offline (last_salary_tick_micros == 0),
/// just seed last_salary_tick to now and return — we don't bill for
/// the seam between online and offline.  Subsequent ticks compute
/// elapsed × per-min and add to the accumulator.
fn tick_offline_salary(ctx: &ReducerContext, rid: u64) {
    let Some(r) = ctx.db.restaurant().id().find(rid) else { return; };
    if r.cloud_base_payroll_per_min_cents <= 0 { return; }
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let owner_online = ctx.db.player().identity().find(r.owner)
        .map(|pl| (now_micros - pl.last_seen_at.to_micros_since_unix_epoch()) < SALARY_OFFLINE_THRESHOLD_MICROS)
        .unwrap_or(false);
    if owner_online {
        // If the client is online, ensure last_salary_tick_micros is
        // reset so future offline accruals start fresh.  This is the
        // backstop if the client somehow didn't fire
        // reset_salary_tick_clock on connect.
        if r.last_salary_tick_micros != 0 {
            ctx.db.restaurant().id().update(Restaurant {
                last_salary_tick_micros: 0,
                ..r
            });
        }
        return;
    }
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
    let total_per_min_cents = r.cloud_base_payroll_per_min_cents
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
    let new_pending = r.pending_salary_cost_cents.saturating_add(whole_cents);
    ctx.db.restaurant().id().update(Restaurant {
        pending_salary_cost_cents: new_pending,
        pending_salary_remainder_x: new_remainder,
        last_salary_tick_micros: now_micros,
        ..r
    });
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

/// Phase H.28 — client pushes the latest aggregate furniture stats
/// computed via FurnitureRegistry.getAggregateStats +
/// getBathroomScore. Cached on the Restaurant row so the server can
/// apply vibe + bathroom rating modifiers to backgrounded guests
/// without porting the catalog data to Rust.
///
/// Owner-only. Idempotent: a push with identical values is a no-op.
#[reducer]
pub fn update_restaurant_aggregates(
    ctx: &ReducerContext,
    restaurant_id: u64,
    style_x100: i32,
    comfort_x100: i32,
    rating_bonus_x100: i32,
    bathroom_quality_x100: i32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can update aggregates".into());
    }
    if r.cached_style_x100 == style_x100
        && r.cached_comfort_x100 == comfort_x100
        && r.cached_rating_bonus_x100 == rating_bonus_x100
        && r.cached_bathroom_quality_x100 == bathroom_quality_x100 {
        return Ok(()); // idempotent
    }
    ctx.db.restaurant().id().update(Restaurant {
        cached_style_x100: style_x100,
        cached_comfort_x100: comfort_x100,
        cached_rating_bonus_x100: rating_bonus_x100,
        cached_bathroom_quality_x100: bathroom_quality_x100,
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
        && r.pending_rating_count == 0 {
        return Ok(()); // already cleared
    }
    log::info!(
        "consume_pending_visit_rollup: clearing {} served / {} tip cents / {} ratings on restaurant {}",
        r.pending_served, r.pending_tips_cents, r.pending_rating_count, restaurant_id,
    );
    ctx.db.restaurant().id().update(Restaurant {
        pending_served: 0,
        pending_tips_cents: 0,
        pending_rating_sum_x100: 0,
        pending_rating_count: 0,
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
fn try_dispatch_take_order(ctx: &ReducerContext, rid: u64) {
    // Phase H Phase 4 — the original H.34 gated this on owner-offline
    // because the local StaffRouter raced it when foregrounded. With
    // the Phase 1+3 bridges in place, the client no longer dispatches
    // take-order trips on its own when serverOwnsTicketDispatch() is
    // on; this path is now always-on. Coverage check below
    // (take_order_guest_id) keeps the dispatcher idempotent across
    // ticks so the same guest never gets two waiters.
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
    for g in ctx.db.active_guest().restaurant_id().filter(rid) {
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
    const OFFLINE_THRESHOLD_MICROS: i64 = 30_000_000;
    let r = match ctx.db.restaurant().id().find(rid) {
        Some(x) => x,
        None => return,
    };
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let owner_online = ctx.db.player().identity().find(r.owner)
        .map(|pl| (now_micros - pl.last_seen_at.to_micros_since_unix_epoch()) < OFFLINE_THRESHOLD_MICROS)
        .unwrap_or(false);
    if owner_online { return; }

    // Need at least one dirty piece somewhere in the pool.
    let any_dirty = ctx.db.dishware_pool()
        .restaurant_id().filter(rid)
        .any(|p| p.dirty > 0);
    if !any_dirty { return; }

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
    let (new_x, new_z) = step_toward_target(
        a.x, a.z, a.target_x, a.target_z,
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
                    ctx.db.staff_actor().member_id().update(StaffActor {
                        x: new_x,
                        z: new_z,
                        state: "returningHome".to_string(),
                        state_clock_ms: 0,
                        target_x: a.home_x,
                        target_z: a.home_z,
                        target_floor: a.home_floor,
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
            // wash_phase == "drop": done with the trip. Clear wash
            // fields + return home. Inventory motion stays with H.21.
            ctx.db.staff_actor().member_id().update(StaffActor {
                x: new_x,
                z: new_z,
                state: "returningHome".to_string(),
                state_clock_ms: 0,
                target_x: a.home_x,
                target_z: a.home_z,
                target_floor: a.home_floor,
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
    let raw = 100i32 - (m.upgrade_level as i32) * 10;
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
/// chef_cook_multiplier on cook time.  Waiters get +10% speed per
/// level, matching getWaiterSpeedMultiplier.  Unknown members
/// default to 1.0× (no bonus).
fn actor_speed_multiplier(ctx: &ReducerContext, role: &str, member_id: &str) -> f32 {
    if role != "waiter" { return 1.0; }
    let Some(m) = ctx.db.hired_staff_member().member_id().find(member_id.to_string())
    else { return 1.0; };
    1.0 + 0.10 * (m.upgrade_level as f32)
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
fn tick_staff_actor(ctx: &ReducerContext, member_id: &str, dt_ms: i64) {
    let Some(a) = ctx.db.staff_actor().member_id().find(member_id.to_string()) else { return };
    // Phase H.35 — if this actor is in the middle of a server-dispatched
    // wash trip (wash_target_uid set + non-empty wash_phase), the trip
    // has its own multi-leg state machine that's incompatible with the
    // delivery-phase tuple compute_waiter_transition uses. Branch out
    // to the dedicated handler and return.
    if !a.wash_target_uid.is_empty() && !a.wash_phase.is_empty() {
        tick_wash_trip(ctx, a, dt_ms);
        return;
    }
    // H.52 — waiter walk speed includes training multiplier.
    let (new_x, new_z) = step_toward_target(
        a.x, a.z, a.target_x, a.target_z,
        actor_walk_speed(ctx, &a.role, &a.member_id),
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
                return ((
                    "returningHome".to_string(), 0,
                    a.home_x, a.home_z, a.home_floor,
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
    // H.18 — also handles the client's "leaving variant" state strings
    // (walkingToDoor, exitingDoor, walkingOut). The short
    // LEAVING_DWELL_MS (4 s) applies to "leaving"/"done"; the longer
    // LEAVING_VARIANT_DWELL_MS (30 s) applies to the client variants.
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
            // H.20 — return / dirty-pool the guest's plates BEFORE the
            // row vanishes. Mirrors client settleGuestDishes; the
            // dishes_settled gate inside the helper keeps it
            // idempotent (and a no-op when the client already settled
            // and pushed `dishes_settled = true`).
            settle_guest_dishes(ctx, &g);
            // H.22 — also accumulate approximate tip + star rating on
            // the Restaurant's pending_* counters if this guest never
            // got credited locally. Same dishes_settled gate keeps
            // foreground guests (which run their own finalizeVisit
            // with the full grading formula) from getting counted
            // twice. The foreground client drains these via
            // consume_pending_visit_rollup on connect.
            if !g.dishes_settled {
                accumulate_pending_visit_rollup(ctx, &g);
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

    // H.14 — when transitioning to waitingForFood (server-side
    // ordering→waitingForFood OR client mirror catches up), attempt
    // to place the current course's ticket if no ticket is currently
    // active for this guest. Foreground play has the client doing
    // this directly via place_order; backgrounded tabs rely on the
    // server now. auto_place_next_course bails on idempotency when
    // a non-terminal ticket already exists.
    if final_state == "waitingForFood" {
        auto_place_next_course(ctx, &g);
    }

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

    // H.16 — credit the just-finished course's price + satisfaction
    // when transitioning out of "eating" (either to "seated" for the
    // next course OR to "leaving" for the final course). Counter
    // only — observation field, doesn't touch player money (the
    // foreground client's creditCourse still handles the real
    // economy.earnMoney). Parses the CSV entry at the OLD
    // order_index (the course just finished).
    let course_just_finished =
        g.state == "eating" && (final_state == "seated" || final_state == "leaving");
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
    let patience_refresh = (g.state == "ordering" && final_state == "waitingForFood")
        || (g.state == "eating" && final_state == "seated");
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

    // Seat pre-assignment — gates the spawn. No free table → no
    // spawn. This is what was missing pre-H.89 and produced ghosts.
    let Some((seat_uid, seat_x, seat_z, seat_floor)) =
        try_assign_seat_for(ctx, restaurant_id, door_x, door_z, None)
    else {
        log::info!(
            "try_spawn_arrival_guest: no free seat in restaurant {} — skipping spawn",
            restaurant_id,
        );
        return false;
    };

    // Pseudo-random rolls — Date.now()/random() are disallowed in
    // scheduled-reducer context, so we hash (timestamp ^ restaurant_id
    // ^ active_count) and pull bits off it. Distribution good enough
    // for archetype-like flavor rolls.
    let seed: u64 = (ctx.timestamp.to_micros_since_unix_epoch() as u64)
        .wrapping_mul(restaurant_id.wrapping_add(1))
        .wrapping_mul(active_count as u64 + 17);
    let mut h: u64 = seed ^ 0x9E37_79B9_7F4A_7C15;
    h ^= h >> 30; h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27; h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 31;
    // H.38 — pick an archetype from the seeded catalog instead of
    // hardcoding "regular". Patience multiplier + WC-use chance come
    // from the archetype; previously they were rolled inline.
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
        taste_diet: "both".to_string(),
        taste_decor_pref: 0.5,
        taste_window_pref: 0.5,
        taste_cuisine_bias: String::new(),
        taste_drink_tolerance: 0.0,
        will_use_toilet,
        state: "walkingIn".to_string(),
        state_clock_ms: 0,
        patience_ms: scale_patience(ORDER_PATIENCE_BASE_MS, patience_mult_x100),
        // H.89 — populate seat fields from try_assign_seat_for above.
        // Without these the row would render as a ghost (client's
        // hydrate path keys on seat_uid being non-empty to mount the
        // guest on a chair).
        seat_uid: seat_uid.clone(),
        seat_x,
        seat_z,
        seat_facing_y: 0.0, // chair facing unknown server-side; client recomputes on hydrate
        seat_floor,
        seat_at_bar: false,
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
        waiting_chair_uid: String::new(),
        waiting_timeout_ms: 0,
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

    let now_micros = now.to_micros_since_unix_epoch();
    if now_micros - rest.last_guest_spawn_micros < SERVER_SPAWN_INTERVAL_MICROS {
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
    let free_seats = save.as_ref().map(|s| s.free_seats).unwrap_or(4);
    if !restaurant_open { return; }
    if free_seats == 0 { return; }

    // Owner-offline gate.  See doc comment above.
    let owner_online = ctx.db.player().identity().find(rest.owner)
        .map(|pl| (now_micros - pl.last_seen_at.to_micros_since_unix_epoch())
            < OFFLINE_THRESHOLD_MICROS)
        .unwrap_or(false);
    if owner_online { return; }

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

    // Restaurant-local door anchor is (0, 0) by convention — the
    // client's WorldScene puts the front door at origin so a guest
    // appearing here walks naturally to a seat.
    let spawned = try_spawn_arrival_guest(ctx, rid, variant, 0.0, 0.0);
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
    let mut same_floor_best: Option<(String, f32, f32, u32)> = None;
    let mut same_floor_best_dist = f32::INFINITY;
    let mut any_floor_best: Option<(String, f32, f32, u32)> = None;
    let mut any_floor_best_dist = f32::INFINITY;
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
        if !predicate(&f.def_id) { continue; }
        if taken.contains(&f.uid) { continue; }
        let stand_x = f.x + f.rot_y.sin();
        let stand_z = f.z + f.rot_y.cos();
        let dx = stand_x - g.x;
        let dz = stand_z - g.z;
        let dist = dx * dx + dz * dz;
        if f.floor == g.floor {
            if dist < same_floor_best_dist {
                same_floor_best_dist = dist;
                same_floor_best = Some((f.uid.clone(), stand_x, stand_z, f.floor));
            }
        } else if dist < any_floor_best_dist {
            any_floor_best_dist = dist;
            any_floor_best = Some((f.uid.clone(), stand_x, stand_z, f.floor));
        }
    }
    same_floor_best.or(any_floor_best)
}

/// H.12 — Server-side fallback seat assignment. Called from
/// tick_guest_state when a guest has been in "walkingIn" for
/// ASSIGN_SEAT_GRACE_MS without the client having mirrored a seat
/// target. Picks the closest unoccupied table.
///
/// Thin wrapper around `try_assign_seat_for` — see that for details.
fn try_assign_seat(ctx: &ReducerContext, g: &ActiveGuest) -> Option<(String, f32, f32, u32)> {
    try_assign_seat_for(ctx, g.restaurant_id, g.x, g.z, Some(g.id))
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
fn try_assign_seat_for(
    ctx: &ReducerContext,
    rid: u64,
    from_x: f32,
    from_z: f32,
    exclude_guest_id: Option<u64>,
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
    // Find the closest free table.
    let mut best: Option<(String, f32, f32, u32)> = None;
    let mut best_dist = f32::INFINITY;
    for f in ctx.db.placed_furniture().restaurant_id().filter(rid) {
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
            ctx.db.active_ticket().id().update(ActiveTicket {
                state: "ready".to_string(),
                state_clock_ms: 0,
                pickup_x: px,
                pickup_z: pz,
                pickup_floor: pf,
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
    let g = ctx.db.active_guest().id().find(guest_id)
        .ok_or_else(|| format!("Guest {guest_id} not found"))?;
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
    let g = ctx.db.active_guest().id().find(guest_id)
        .ok_or_else(|| format!("Guest {guest_id} not found"))?;
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
    let g = ctx.db.active_guest().id().find(guest_id)
        .ok_or_else(|| format!("Guest {guest_id} not found"))?;
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
    let g = ctx.db.active_guest().id().find(guest_id)
        .ok_or_else(|| format!("Guest {guest_id} not found"))?;
    let r = ctx.db.restaurant().id().find(g.restaurant_id)
        .ok_or_else(|| "Guest's restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can set guest orders".into());
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
fn auto_place_next_course(ctx: &ReducerContext, g: &ActiveGuest) -> Option<u64> {
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
    let idx = g.order_index as usize;
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
            && m.upgrade_level == upgrade_level {
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
