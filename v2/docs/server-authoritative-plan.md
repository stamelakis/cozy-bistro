# Server-Authoritative Simulation — Design

This is the planning doc for migrating the live restaurant simulation
(guests, tickets, staff, dishware, furniture) from the client to
SpacetimeDB. Everything lives in tables; reducers drive state
transitions; the client becomes a renderer + input forwarder. Same
architecture pattern as the existing P5 shared pedestrians.

Status: **Phase A1 + A2 — inventory + schema draft**. No code changes
yet to the simulation itself; the next phase adds the `serverSim`
feature flag.

---

## Phase A1 — Inventory of client-only mutable state

Everything in this list needs a home in SpacetimeDB before we can flip
the `serverSim` flag for that subsystem. Listed roughly in load-order
dependency (downstream things need upstream things).

### 1. `GuestSpawner` — `ActiveGuest` (≈40 fields per row)

Live customers from spawn to despawn. Today: in-memory `Map<id,
ActiveGuest>` on `GuestSpawner`. State per guest:

- **Identity / kind**: `id`, `variantId`, `archetype`, `taste`
- **State machine**: `state` (~12 enum values: walkingIn / seated /
  ordering / waitingForFood / eating / leaving / waiting / wcWalking /
  wcSitting / wcWashing / done), `stateClock`, `patience`
- **Seat assignment**: `seatId`, `seatPos`, `seatFacingY`, `seatFloor`,
  `seatAtBar`, `platePos`, `waiting` overflow chair info
- **Order**: `order: RecipeDefinition[]`, `orderIndex`, `ticketId`,
  `reservedDishTiers: number[]`
- **Movement**: `target`, `path: MultiFloorPathStep[]`, `currentFloor`,
  `prevWaypoint`, `replanAccum`, `passedDoor`, `passedExterior`
- **Bathroom**: `willUseToilet`, `wcDone`, `toiletUid`, `sinkUid`,
  `originalSeatHeight`
- **Bookkeeping**: `totalPaid`, `totalSatisfaction`, `dishesSettled`

### 2. `StaffRouter` — `Ticket` (≈15 fields)

Cooking + delivery state per ordered dish.

- **Identity**: `id`, `guestId`, `recipeId`
- **State**: `state` (queued / cooking / ready / delivering / delivered),
  `clock`
- **Cooking**: `baseCookSeconds`, `cookSeconds`, `appliance`,
  `assignedChefId`
- **Delivery**: `seatPos`, `seatFloor`, `pickupPos`, `pickupFloor`,
  `seatAtBar`

### 3. `StaffRouter` — `StaffActor` (≈25 fields × 4 roles)

Live position + AI state per hired staff member.

- **Identity**: `memberId`, `role` (chef / waiter / barman), `homeFloor`
- **Body**: world position (driven by `character.root.position` today),
  `currentFloor`, `path`, `prevWaypoint`, `replanAccum`, `speed`
- **State machine**: `state` (idle / movingToWork / working /
  returningHome), `target`, `targetFloor`, `clock`, `ticketId`
- **Role-specific**:
  - Chef: `assignedStoveUid`, `lastStoveUid`
  - Waiter: `washTrip?`, `takeOrderRequest?`
  - Barman: same as waiter but only bar-counter assignments

Plus `ErrandActor` for the errand helper (separate file
`ErrandRouter.ts`) — single instance, much simpler state machine.

### 4. `StaffRouter` — auxiliary queues

- `orderRequests: OrderRequest[]` — guests waiting for a waiter to take
  their order
- `washTrip` candidate pool — dirty pieces visible to waiters

### 5. `DishwareSystem`

- `plates: Map<tier, {clean, dirty}>` + `glasses: Map<...>` 
- `dishwasherBatches: Map<uid, DishwasherBatch>` — per-station mid-cycle
  state with `cycleTimeRemaining`
- `lifetimeAddedPlate`, `lifetimeAddedGlass` — high-water marks
- `purchaseLog: Array<{kind, tier, count, at}>` — audit trail

### 6. `FurnitureRegistry`

Placed items in the restaurant. Today: in-memory + serialised to
localStorage on save. Roughly ~50-200 rows per restaurant.

- Per item: `uid`, `defId`, `x`, `z`, `rotY`, `floor`, `parentUid?`,
  `slotIndex?`, `localRotY?`
- Plus the derived "occupancy grid" computed on demand — that stays
  client-side (a cache).

### 7. Cooking / Pantry (`Game.cooking`)

- `ingredients: IngredientStock[]` — pantry counts
- `preparedServings: Record<recipeId, number>` — pre-prepped portions
- `unlockedRecipeIds`, `menuRecipeIds`, `recipeUpgradeLevels`
- `recipeTrainingCompletesAt` — pending upgrades

### 8. Economy + Day

- `money`, `dailyRevenue`, `dailyExpenses`, `transactionLog`
- `dayNumber`, `getDayProgress()` (in-game clock)
- `dailyServed`, `dailyLost`
- `rentElapsedSeconds`, `totalPlaySeconds`
- `ratingTotal`, `ratingCount`, `ratingHistory`

### 9. Staff (`Game.staff`)

Already partly persisted in save_snapshot.

- `staffMembers: HiredStaffMember[]` — per-member id, name, training,
  homeFloor, role
- `staffUpgrades` (legacy fallback)

### 10. Theme / sign / per-floor configuration

- `themeId`, `themeByFloor`, `restaurantName`, `signStyle`

### 11. Player counters / achievements / day history

Already mostly handled via existing tables — confirm completeness.

---

## Phase A2 — Schema draft

The whole live simulation is per-restaurant, so every table below has
a `restaurant_id: u64` foreign key + a btree index on it so the
scheduled tick reducer can iterate one restaurant's state without
scanning the whole DB.

### Tables

```rust
// === Live guests in a restaurant ===
#[table(name = active_guest, public)]
pub struct ActiveGuest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub restaurant_id: u64,
    // Identity / kind
    pub variant: String,         // "guest-v0".."guest-v6"
    pub archetype: String,       // CustomerArchetype enum as string
    // CustomerTaste — expanded out of the JSON blob into real columns
    // (review feedback: prefer queryable over compact).
    pub taste_diet: String,      // "food" | "drink" | "both"
    pub taste_decor_pref: f32,   // 0..1, how much decor quality matters
    pub taste_window_pref: f32,
    pub taste_cuisine_bias: String, // recipe-category id, "" = no bias
    pub taste_drink_tolerance: f32,
    pub taste_wc_use_chance: f32, // rolled here vs derived
    // State machine
    pub state: String,           // enum: walkingIn/seated/ordering/...
    pub state_clock_ms: i64,     // elapsed in this state, milliseconds
    pub patience_ms: i64,        // remaining patience this state
    // Seat (nullable until seated)
    pub seat_uid: String,        // furniture uid or "" if waitlisted
    pub seat_x: f32,
    pub seat_z: f32,
    pub seat_facing_y: f32,
    pub seat_floor: u32,
    pub seat_at_bar: bool,
    // Body
    pub x: f32,
    pub z: f32,
    pub floor: u32,
    pub target_x: f32,
    pub target_z: f32,
    // Order
    pub order_recipes: String,   // comma-separated recipe ids
    pub order_index: u32,
    pub ticket_id: Option<u64>,
    pub reserved_dish_tiers: String, // CSV of u32 (max 5 entries)
    // Bookkeeping
    pub total_paid: i64,
    pub total_satisfaction: i32, // sum × 100 to avoid floats
    pub dishes_settled: bool,
    pub spawned_at: Timestamp,
}

// === Live tickets ===
#[table(name = active_ticket, public)]
pub struct ActiveTicket {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub restaurant_id: u64,
    #[index(btree)]
    pub guest_id: u64,
    pub recipe_id: String,
    pub state: String,           // queued/cooking/ready/delivering/delivered
    pub clock_ms: i64,
    pub base_cook_seconds: f32,
    pub cook_seconds: f32,       // base × current-chef multiplier
    pub appliance: String,
    pub assigned_chef_id: String, // "" = unassigned
    // Seat the plate goes to
    pub seat_x: f32,
    pub seat_z: f32,
    pub seat_floor: u32,
    pub seat_at_bar: bool,
    // Pickup spot (where the cooked plate sits waiting)
    pub pickup_x: f32,
    pub pickup_z: f32,
    pub pickup_floor: u32,
}

// === Live staff actors ===
#[table(name = staff_actor, public)]
pub struct StaffActor {
    #[primary_key]
    pub member_id: String,       // matches HiredStaffMember.id
    #[index(btree)]
    pub restaurant_id: u64,
    pub role: String,            // chef/waiter/barman/errand
    pub home_floor: u32,
    pub home_x: f32,
    pub home_z: f32,
    // State
    pub state: String,           // idle/movingToWork/working/returningHome
    pub state_clock_ms: i64,
    pub ticket_id: Option<u64>,
    // Body
    pub x: f32,
    pub z: f32,
    pub floor: u32,
    pub target_x: f32,
    pub target_z: f32,
    pub target_floor: u32,
    // Role-specific (nulls / empty strings when N/A)
    pub assigned_stove_uid: String,
    pub last_stove_uid: String,
    // WashTrip — expanded into real columns. Active when
    // wash_target_uid != "". Mutually exclusive with ticket_id +
    // take_order_guest_id.
    pub wash_target_uid: String,    // station the waiter is washing at
    pub wash_dirty_id: i64,         // dirty piece they're carrying, -1 = none yet
    pub wash_phase: String,         // "" | "pickup" | "scrub" | "drop"
    pub take_order_guest_id: Option<u64>,
}

// === Placed furniture ===
#[table(name = placed_furniture, public)]
pub struct PlacedFurniture {
    #[primary_key]
    pub uid: String,
    #[index(btree)]
    pub restaurant_id: u64,
    pub def_id: String,
    pub x: f32,
    pub z: f32,
    pub rot_y: f32,
    pub floor: u32,
    pub parent_uid: String,      // "" when not a surface child
    pub slot_index: i32,         // -1 when not on a surface
    pub local_rot_y: f32,
}

// === Dishware pool ===
#[table(name = dishware_pool, public)]
pub struct DishwarePool {
    /// Composite key: format "{restaurant_id}:{kind}:{tier}"
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub restaurant_id: u64,
    pub kind: String,            // "plate" | "glass"
    pub tier: u32,
    pub clean: u32,
    pub dirty: u32,
}

// === Dishwasher batches (mid-cycle wash state) ===
#[table(name = dishwasher_batch, public)]
pub struct DishwasherBatch {
    #[primary_key]
    pub furniture_uid: String,   // uid of the placed dishwasher
    #[index(btree)]
    pub restaurant_id: u64,
    pub def_id: String,          // "dishwasher" | "dishwasher-pro"
    pub plates: u32,
    pub glasses: u32,
    pub cycle_time_remaining_ms: i64,
}

// === Pantry / ingredients ===
#[table(name = pantry_stock, public)]
pub struct PantryStock {
    /// "{restaurant_id}:{ingredient_id}"
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub restaurant_id: u64,
    pub ingredient_id: String,
    pub count: u32,
}

// === Prepared servings (pre-prepped recipe portions) ===
#[table(name = prepared_serving, public)]
pub struct PreparedServing {
    /// "{restaurant_id}:{recipe_id}"
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub restaurant_id: u64,
    pub recipe_id: String,
    pub count: u32,
}

// === Restaurant runtime state — SPLIT into focused tables ===
// Original draft had a single restaurant_state row; review feedback
// said "split it". Each table below holds one logical concept so a
// money change doesn't push a day_number subscription update etc.

// Economy: money + daily revenue/expense running totals.
#[table(name = economy_state, public)]
pub struct EconomyState {
    #[primary_key]
    pub restaurant_id: u64,
    pub money_cents: i64,         // × 100 to avoid floats
    pub daily_revenue_cents: i64,
    pub daily_expenses_cents: i64,
}

// Day clock + per-day counters that reset at day end.
#[table(name = day_state, public)]
pub struct DayState {
    #[primary_key]
    pub restaurant_id: u64,
    pub day_number: u32,
    pub day_progress_x10000: u32, // 0..10000 for 4-decimal precision
    pub daily_served: u32,
    pub daily_lost: u32,
    pub rent_elapsed_ms: i64,
    pub total_play_ms: i64,
}

// Reputation running totals. Rating history goes in a sibling table
// (one row per finished day) so the history can grow without
// re-publishing the running totals.
#[table(name = reputation_state, public)]
pub struct ReputationState {
    #[primary_key]
    pub restaurant_id: u64,
    pub rating_total_x100: i64,   // sum × 100 (rating values 0..5)
    pub rating_count: u32,
}

#[table(name = rating_history_entry, public)]
pub struct RatingHistoryEntry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub restaurant_id: u64,
    pub day_number: u32,
    pub rating_x100: i32,
}

// Player-set configuration. Sign-style struct was a JSON blob in the
// first draft; split into proper columns.
#[table(name = restaurant_config, public)]
pub struct RestaurantConfig {
    #[primary_key]
    pub restaurant_id: u64,
    pub is_open: bool,
    pub auto_shop: bool,
    pub stock_target: u32,
    pub ground_theme_id: String,  // Floor 0 theme; upper floors live in theme_per_floor
    pub restaurant_name: String,
    pub sign_font: String,
    pub sign_text_color: String,
    pub sign_plaque_style: String,
}

// Per-floor theme override. One row per (restaurant_id, floor)
// keying. Absent rows fall back to RestaurantConfig.ground_theme_id.
#[table(name = theme_per_floor, public)]
pub struct ThemePerFloor {
    /// "{restaurant_id}:{floor}"
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub restaurant_id: u64,
    pub floor: u32,
    pub theme_id: String,
}

// Master tick bookkeeping — when the last tick fired for this
// restaurant. Used by the scheduled reducer to compute dt.
#[table(name = restaurant_tick_state, public)]
pub struct RestaurantTickState {
    #[primary_key]
    pub restaurant_id: u64,
    pub last_tick_at: Timestamp,
}

// === Scheduled tick row that drives the simulation ===
#[table(name = restaurant_tick_schedule,
        scheduled(crate::reducers::restaurant_tick))]
pub struct RestaurantTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
    pub restaurant_id: u64,
}
```

### Indexes / lookup patterns

- `active_guest.restaurant_id` btree → tick reducer iterates one
  restaurant's guests
- `active_guest.seat_uid` (added later if hot) → fast "is this seat
  occupied"
- `active_ticket.restaurant_id` + `active_ticket.guest_id` btree → ticket
  scanning per restaurant + lookup by guest
- `staff_actor.restaurant_id` btree → tick reducer
- `placed_furniture.restaurant_id` btree → blocked-cells computation
- Everything else: composite-key primary keys for direct lookup

### Reducer surface

User-action reducers (called from the client when the player does
something):

- `place_furniture(restaurant_id, def_id, x, z, rot_y, floor, parent_uid?, slot_index?)`
- `move_furniture(uid, x, z, rot_y, floor)`
- `sell_furniture(uid)`
- `buy_ingredients(restaurant_id, ingredient_id, count)`
- `buy_dishware(restaurant_id, set_id)`
- `hire_staff(restaurant_id, role)`
- `fire_staff(member_id)`
- `train_staff(member_id)`
- `set_recipe_on_menu(restaurant_id, recipe_id, on)`
- `upgrade_recipe(restaurant_id, recipe_id)`
- `set_theme(restaurant_id, theme_id, floor?)`
- `set_restaurant_name(restaurant_id, name)`
- `toggle_open(restaurant_id, open)`

Simulation-only reducers (called by the scheduled tick):

- `restaurant_tick(ctx, schedule)` — the master 10 Hz tick. Iterates
  every guest, ticket, staff actor in this restaurant; calls the
  state-machine helpers below.
- `tick_guest_state(ctx, g)` — patience countdown, state transition
  (seated → ordering → waitingForFood → eating → leaving)
- `tick_ticket_state(ctx, t)` — cook timer, state transition
- `tick_staff_state(ctx, s)` — claim work, move toward target, dwell
  at workstation
- `try_spawn_guest(ctx, restaurant_id)` — rolls archetype / taste /
  pick seat; called when a pedestrian arrives at this restaurant's door
- `cleanup_finished(ctx, restaurant_id)` — drop done guests, delivered
  tickets, fired staff actors

### Things that STAY on the client

- Three.js scene graph (rendering — must stay local)
- Character pose / animation interpolation (state-driven from server,
  but rendered locally)
- Pathfinding (called server-side to GENERATE the path waypoints, but
  computed in WASM compiled into the module — same Pathfinding.ts
  logic ported to Rust)
- Camera / input handling / UI panels / sound effects

### Open design questions

1. **Where does pathfinding live?** Two options:
   - Server runs it in Rust (full authority, but ~200 LoC port from
     TypeScript and a 10×10 grid solve per tick × N actors)
   - Client computes the path, sends it as a list of waypoints to the
     server with the action ("walk to here, via these tiles") — fewer
     server cycles but trusts the client's routing.
   
   **Decision:** Server. The 10×10 A* with MAX_ITERATIONS=500 is sub-
   millisecond; we already proved this on the client side. Cheaper to
   own it than to validate client-supplied paths.

2. **How is the master tick scheduled?**
   - **Option A**: one `RestaurantTickSchedule` row per open restaurant.
     Module fires the reducer per restaurant. Scales linearly with
     active restaurants.
   - **Option B**: single global tick row that walks every active
     restaurant inside one call. Better batching for low restaurant
     counts; worse latency control.
   
   **Decision:** Option A. Keeps each restaurant's tick independent —
   crashes / slow ticks in one shouldn't stall others.

3. **Tick rate?**
   Pedestrians use ~0.5 Hz (2 s interval). Live game sim needs to feel
   responsive on patience countdowns + cook timers; pick **10 Hz**
   (100 ms interval). That's 6× the pedestrian rate. Energy budget per
   tick should be tiny (~30 guests × small state-machine evaluation).

4. **Position interpolation strategy?**
   The server publishes `(x, z, floor, target_x, target_z, speed)` on
   the actor row. Client lerps from current → target between rows.
   Same pattern P5 pedestrians use, just at higher cadence.

5. **Save snapshot survival?**
   Once `serverSim` flag is on, the JSON `save_snapshot` becomes
   redundant — the live tables ARE the save. Keep it during Phase B-G
   as a fallback / for backup; remove in Phase H.

6. **Cross-device "same shop simultaneous" arbitration?**
   With server-authoritative state, two clients on the same account
   both subscribed to the same restaurant naturally see the same
   world. No special arbitration needed for read; for writes
   (player-triggered build/buy actions) the reducer is the
   serialisation point — both clients submit, reducer processes one
   at a time, both see the result.

7. **Offline play?**
   Lost. The game requires a working SpacetimeDB connection in the
   `serverSim=ON` world. The flag's existence means a fallback for
   "play locally if cloud is down" is technically possible but
   would mean maintaining both code paths forever — not worth it.

---

## Phase ordering recap (what comes next)

- **A3** — add `serverSim` feature flag (off by default, no behaviour
  change yet)
- **A4** — wire the `restaurant_tick_schedule` skeleton (does nothing)
- **B** — guest spawning + lifecycle moves first because the
  pedestrian → customer handoff already crosses the client/server
  boundary, so the integration point is already understood
- **C** — tickets next; depends on guests
- **D** — staff actors; depends on tickets
- **E** — dishware; depends on tickets (which consume plates)
- **F** — placed furniture; mostly independent but should land before
  staff so the server-side blocked-cells computation has real data
- **G** — client-side prediction polish (no schema changes)
- **H** — cutover + remove client-sim paths

Each phase commits with the flag still routing to the OLD client path
by default; integration testing flips the flag locally for that
subsystem. Final cutover only happens when every subsystem is on.

---

## Lessons learned (deploy operations)

### Adding a column to a populated table

SpacetimeDB's macros only accept `#[default(...)]` for values that
are evaluable at compile time. Primitive defaults (`#[default(true)]`,
`#[default(0)]`, `#[default(None)]`) work. `#[default(String::new())]`
or `#[default("".to_string())]` do **not** — they require runtime
heap allocation and the macro rejects them.

This matters because adding a non-defaulted column to an already-
populated table on Maincloud requires `--delete-data`, which the
publish CLI applies **to the entire module's data, not just the
affected table.** The first time we hit this we wiped the whole
DB (6 restaurants, all save_snapshots, all auth_records,
achievements, leaderboards, friendships, chat history).

**Rule going forward** — any new column on a public table that
might already hold rows on Maincloud MUST be one of:

1. `Option<T>` with `#[default(None)]` (works for any T, including
   String), so the migration is non-destructive.
2. A primitive with a const-evaluable `#[default(...)]`.

Never use `--delete-data=on-conflict` on Maincloud unless the
intent is genuinely to nuke the module. Use a fresh local
module (`spacetime publish --server local ...`) for destructive
testing instead.

### Init reducer runs once

`#[reducer(init)]` fires only on the FIRST publish of a module —
not on subsequent re-publishes. Any one-time setup that needs to
backfill new infrastructure for existing rows (e.g., the
restaurant_tick_schedule rows added in Phase A4) needs a manual
"bootstrap" reducer the operator can invoke once after the
publish. Phase A4 had this bug; `bootstrap_sim_schedules` is the
fix pattern.

## Open invitation for review

Before I start Phase A3, give this doc a read and push back on:

1. Tables I've missed (anything client-only I haven't listed?)
2. Field types I've gotten wrong (the `_blob: String` JSON pickling
   for `taste`, `wash_trip`, etc. should arguably be expanded into
   proper columns — depends on whether we want to query them)
3. The 10 Hz tick rate — could be 5 Hz or 20 Hz
4. Pathfinding-on-server vs. client-supplied-paths
5. Anything else
