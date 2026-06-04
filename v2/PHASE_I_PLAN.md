# Phase I — Full Server-Authoritative Refactor

**Goal:** Make SpacetimeDB the single source of truth for ALL gameplay.
Client becomes a renderer + input forwarder. Login = see live state.
Visit mode = same render path as own session.

**Scope:** 7-11 sessions of careful work. Each step shippable on its own.

---

## Where we are (post H.41-H.46)

- ✅ Server has tables for every gameplay entity (active_guest, active_ticket,
  staff_actor, dishware_pool, pantry_stock, hired_staff_member,
  recipe_upgrade_in_flight, restaurant rollup fields).
- ✅ Server tick at 10 Hz drives offline simulation (H.33-H.45).
- ✅ Reconnect drain pattern works for tips, restock cost, salary, day rollovers,
  recipe upgrades, training completions.
- ✅ Visit mode renders live state from cloud (active_guest, staff_actor,
  active_ticket subscriptions).
- ❌ Owner's own reload reads only the save snapshot, ignoring cloud state.
- ❌ Foreground play has the local sim as source of truth; cloud is a mirror.
- ❌ Several quality features only exist on the client (CustomerTaste, wall-aware
  A*, chef-training multipliers, recipe-upgrade satisfaction bonuses, decor
  adjacency, reputation decay, achievement progress checks).

---

## Phase I.1 — Hydrate from cloud on reload (1-2 sessions)

### H.47 — Guest hydrate
- ✅ `listActiveGuests` extended to return all hydrate-needed fields
  (taste, seat, order, courses, plates, totals). Type `HydratableGuestRow`
  exported. (SHIPPED in foundation commit.)
- [ ] Add `GuestSpawner.hydrateFromCloud(rid)`:
  - Iterate `cloud.listActiveGuests()`.
  - For each row not matching a local guest (by `clientTempId` or cloud
    `id`), construct a local `Guest` matching the cloud state and add to
    `this.guests`.
  - For each local guest with NO matching cloud row, despawn (server
    already settled them during offline; keeping them locally creates
    zombies).
  - Resume local sim from there.
- [ ] Field mapping:
  - state (string) — direct copy
  - position (x,z,floor) — direct
  - seat (uid, x, z, floor, facingY, atBar) — direct, look up
    FurnitureRegistry by uid for live position
  - order — parse CSV recipe ids, look up RecipeDefinitions
  - patience (ms → s)
  - taste — copy from cloud (no re-roll; server has all fields after
    H.38 + spawnGuest mirror)
  - plates — defaulted (server doesn't track individual plate visuals;
    they'll regenerate as state advances; if cloud says "eating" with
    no plate, that's a minor visual gap on hydrate only)
  - waiting (chair uid + timeout) — direct
  - totalPaid / totalSatisfaction — direct
  - dishesSettled — set true if state == "leaving" or terminal
- [ ] Wire into Engine.onSubscriptionReady AFTER save load AND spawner init.
- [ ] Despawn-stale-locals: iterate `this.guests`; if cloud doesn't have
  matching id, call existing `despawnGuest(idx)`.

### H.48 — Staff actor hydrate
- [ ] `StaffSystem` and `StaffRouter` already have `staff_actor` mirror.
  On reload, restore each staff actor's STATE from cloud, not save:
  - state ("idle" / "movingToWork" / "working" / "returningHome")
  - target (x, z, floor)
  - ticket_id assignment
  - wash_target_uid, wash_phase
  - delivery_phase
- [ ] Without this, an offline server-dispatched chef who was mid-cook
  gets restored as "idle at home" by the save → loses the cook progress.

### H.48b — Ticket hydrate
- [ ] On reload, iterate `active_ticket` for own restaurant.
- [ ] For each row not in local Game state, construct a local
  TicketRouter entry matching cloud state.
- [ ] Sync state_clock so cook timers continue from where server left
  them.

### H.48c — Dishware hydrate
- [ ] `dishware_pool` already mirrors. On reload, override local
  `Game.dishware` pool counts from cloud (cloud is authoritative
  after H.31's delta pattern).

### H.48d — Pantry hydrate (already done via H.36 subscription)
- [x] Pantry is already cloud-mirrored. Just ensure on reload the
  local `CookingSystem.pantry` reads from cloud not save.

---

## Phase I.2 — Subscriptions as live source (1-2 sessions)

### H.49 — Convert local guests to subscription-driven
- [ ] `Game.guests` array becomes a Map keyed by cloud_id.
- [ ] Subscription onInsert → spawn local visual.
- [ ] Subscription onUpdate → update local state from cloud.
- [ ] Subscription onDelete → despawn local.
- [ ] Local sim NO LONGER drives guest state machine — it just renders
  what the cloud says.
- [ ] Inputs that affected guests (e.g. spawn-from-pedestrian-arrival)
  route through reducers.

### H.49b — Same for staff, tickets, dishware, pantry, furniture
- [ ] Each system flips to subscription-driven.
- [ ] Local input → reducer → server → subscription → local render.
- [ ] Cross-device sync becomes automatic.

---

## Phase I.3 — Port missing gameplay to server (3-5 sessions)

Each sub-phase ports one quality feature from client to server:

### H.50 — Customer taste server-side
- [ ] Server's `try_spawn_arrival_guest` already rolls archetype + reads
  taste from H.38 catalog. Confirm taste_diet filter is applied in
  server seat picker.
- [ ] Server-side seat scoring: port `pickBestSeatForTaste` to Rust.
  Needs decor adjacency, window adjacency, comfort, theme bias inputs
  (all already cached in H.28's restaurant aggregates).
- [ ] Order satisfaction calc with taste bias: port `computeServeSatisfaction`
  to Rust.

### H.51 — Multi-floor wall-aware A* pathfinding
- [ ] Port the navmesh + A* algorithm to Rust.
- [ ] Server maintains a per-restaurant wall graph synced from
  placed_furniture changes.
- [ ] All guest / staff target-walks use the A* path, not straight line.
- [ ] This is the BIGGEST sub-phase — likely 1-2 sessions on its own.

### H.52 — Chef / waiter training speed multipliers
- [ ] Server applies cook-speed multiplier from chef's upgrade_level.
- [ ] Server applies delivery-speed multiplier from waiter's upgrade_level.
- [ ] Affects cook_seconds_ms on ticket creation.

### H.53 — Recipe upgrade level satisfaction bonuses
- [ ] Server-side cumulative satisfaction = base × (1 + level × bonus).
- [ ] Needs `recipe_upgrade_level` mirror per (restaurant, recipe) since
  H.43 only tracks in-flight timers, not the resolved levels.
- [ ] New table: `recipe_level` (rid, recipe_id, level).

### H.54 — Reputation rating decay
- [ ] Port `Game.reputation`'s decay algorithm to Rust.
- [ ] Per-tick aging of rating entries.
- [ ] Compute current average for cloud_rating.

### H.55 — Achievement progress checks
- [ ] Port `AchievementSystem.check` to Rust.
- [ ] Server fires achievement_unlocked event when criteria met.
- [ ] Client drains pending_achievement_unlocks_csv on reconnect (same
  pattern as H.43 recipe upgrades).

### H.56 — Day rollover effects server-side
- [ ] H.30 already advances the day counter. Port the rollover EFFECTS:
  daily revenue/expense summary snapshot, end-of-day rent, etc.

---

## Phase I.4 — Delete the local sim (1 session)

### H.57 — Strip local game ticks
- [ ] Remove `GuestSpawner.update()` body (or reduce to position
  interpolation only).
- [ ] Remove `StaffRouter.update()` body.
- [ ] Remove `CookingSystem.tick`.
- [ ] Remove `DishwashingSystem.tick`.
- [ ] Remove `EconomySystem.tickSalary` (server handles via H.45).
- [ ] Client `Game.update(dt)` becomes: read subscriptions, lerp visual
  positions, update animations.

---

## Phase I.5 — Deprecate save_snapshot blob (1 session)

### H.58 — Server tables become the save
- [ ] `save_snapshot` JSON blob no longer needed for state restore
  (server has everything).
- [ ] Keep as backup/recovery only OR remove entirely.
- [ ] `player_save` keeps just visit-mode visibility fields
  (money, rating_avg, etc.).

### Straggler migrations (all post-H.53 → must happen before H.58)
These fields are CURRENTLY only persisted in the save_snapshot JSON.
Each gets its own cloud table + mirror reducer + hydrate path before
the save blob can be retired:

- [x] **Achievement unlocks** — already mirrored via `unlock_achievement`
  reducer + `achievement_unlock` table.  Just needs a read-side
  hydrate (compare cloud unlocks vs local save unlocks; union).
  *Effort: small.  H.59.*
- [ ] **Reputation rating history** — new `reputation_rating` table
  (rid, id, value_x100, recorded_at_micros).  Mirror on every
  `Game.reputation.recordRating(avg)`.  Hydrate on connect (rebuild
  the rolling-window list with timestamps for decay calc).
  *Effort: medium.  H.60.*
- [ ] **Transaction log** — new `transaction_log` table (rid, id,
  label, delta_cents, recorded_at_micros).  Append-only.  Mirror on
  every `recordTransaction` call.  Needs pruning policy (keep last
  N or last 24h).
  *Effort: medium.  H.61.*
- [ ] **Tutorial state** — small.  Either a column on `Player` table
  or new `tutorial_state` (identity, shown_csv).  Mirror on tutorial
  step shown.
  *Effort: small.  H.62.*
- [ ] **Daily revenue/expense per-day history** — new `daily_history`
  (rid, day_number, revenue_cents, expenses_cents).  Mirror on day
  rollover.  Current-day totals already in H.46.
  *Effort: medium.  H.63.*

### Cleanup (final)
- [ ] **H.64** — Stop cloud `save_snapshot` upload entirely (delete
  `cloudSaveNow` / `scheduleCloudSave`).  Keep local IndexedDB save
  for offline backup OR remove if confident.

### Recent energy cut (shipped already)
- **Cloud save_snapshot upload cadence** dropped from "every autosave
  (5 s × 2 s debounce)" to a 5-minute minimum gap.  Per-table mirrors
  carry the live state; the blob is now a once-every-few-minutes
  backup of the straggler fields until they're migrated.  Tab-close
  beforeunload path still fires `cloudSaveNow` immediately as a
  last-chance commit.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Input latency (50-200ms round-trip on Maincloud) | Optimistic client predict, server reconcile on drift |
| Feature loss during migration | Each phase ships independently; keep playable at all times |
| State conflicts during overlap (local sim + cloud both writing) | Hard-cutover per subsystem — once flipped to cloud, local stops writing |
| Large code deletion | Keep deleted code in git history for rollback |
| Wall-aware A* port complexity | Allocate full session(s) for H.51 alone |

---

## Session breakdown estimate

| Session | Sub-phases | Output |
|---|---|---|
| 1 (NEXT) | H.47 | Guest hydrate on reload |
| 2 | H.48 + H.48b/c/d | Staff + ticket + dishware + pantry hydrate |
| 3 | H.49 + H.49b | Subscriptions as live source |
| 4 | H.50 + H.52 | Server-side taste scoring + training multipliers |
| 5 | H.51 (part 1) | Navmesh data structure + Rust port skeleton |
| 6 | H.51 (part 2) | Multi-floor A* in Rust |
| 7 | H.53 + H.54 | Recipe upgrade bonuses + reputation decay |
| 8 | H.55 + H.56 | Achievements + day rollover effects |
| 9 | H.57 | Delete local sim |
| 10 | H.58 | Save deprecation + final polish |

---

## Foundation already shipped (this session, pre-PLAN)

- ✅ `HydratableGuestRow` interface in SpacetimeClient.ts
- ✅ `listActiveGuests` returns all fields needed for hydrate
- ✅ This PLAN.md committed for reference
