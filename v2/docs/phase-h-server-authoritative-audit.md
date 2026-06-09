# Phase H — Server-Authoritative Gap Audit

**Date:** 2026-06-08
**Goal:** Make the restaurant simulation run entirely on the server so it continues 24/7 even when no player is online. Client becomes a renderer + input forwarder.

This doc maps what the server already does vs. what the local TS sim does. Each gap is sized so we know the real scope of the migration.

---

## TL;DR

The server is **30-40% there**. The local sim still owns most decision-making — chef claims, waiter dispatch, guest state transitions during a meal, WC timing, course advancement, etc. The server is mostly a passive mirror that picks up the slack only when the player is offline.

**Estimated effort to full server-authoritative:** ~10-20 focused workdays. The bulk is porting decision logic from TS to Rust + accepting that movement happens in straight lines on the server (or porting the pathfinder, which is itself ~3-5 days).

This is a real project, not a session.

---

## What the server already covers (✓ done)

### Tickets — `tick_ticket_state` ([restaurant_sim.rs:4666](../spacetime/src/reducers/restaurant_sim.rs))
- `cooking` → `ready` when state-clock reaches cook-seconds
- `delivered` → deleted after 1s dwell
- Releases the assigned chef on cooking completion (H.7)

### Staff actors — `tick_staff_actor` ([restaurant_sim.rs:3217](../spacetime/src/reducers/restaurant_sim.rs))
- Position interpolation toward target
- `movingToWork` → `working` on arrival (H.3)
- `returningHome` → `idle` on arrival
- Waiter delivery state machine (H.8): `movingToWork`→`working at pickup`→carry leg→`working at seat`→`returningHome`
- Take-order trip completion (H.34)
- Cross-floor handoff via target_floor

### Wash trips — `tick_wash_trip` ([restaurant_sim.rs:2894](../spacetime/src/reducers/restaurant_sim.rs))
- Dedicated multi-leg state machine for waiter wash trips
- Picks up dirty piece, walks to wash station, dwells, completes

### Guests — `tick_guest_state` ([restaurant_sim.rs:3457](../spacetime/src/reducers/restaurant_sim.rs))
- `leaving` dwell + delete cascade (also deletes orphan tickets, releases waiters)
- Patience timeout → kick to `leaving`
- Waiting-chair timeout (H.5)
- Seat fallback assignment (H.12) — picks closest free table when client hasn't
- WC trip target picking — toilet for `wcWalking`, sink for `wcSitting`→`wcWashing`
- Calls `settle_guest_dishes` + `accumulate_pending_visit_rollup` on despawn

### Dishware
- `tick_dishwasher_batch` — cycle countdown + flush
- `try_server_wash_load` — background wash dispatch
- `flush_one_dish` — clean pool increment

### Customer arrivals
- `try_server_spawn_guest` — continuous arrivals when owner offline (H.89)
- `try_spawn_arrival_guest` — seat-pre-assigned spawn (no ghosts)

### Long-running timers
- Recipe upgrade completions (H.43)
- Training completions (H.44)
- Salary deduction (H.45)
- Daily revenue / expense mirror (H.46)
- Rating history mirror (H.60)
- Day clock (`tick_day_clock`)

---

## Gaps — local TS sim still owns these (✗ to port)

### Tickets

| Transition | Where (client) | Effort |
|---|---|---|
| Order placement (guest → kitchen) | `StaffRouter.enqueueOrder` (line 1281) | small — already a reducer mirror; just need server to be source |
| `queued` → `cooking` (chef claim) | `StaffRouter.tryClaimCookForChef` (line 2271) | **medium** — needs server-side chef selection (closest free chef on right floor, station picker, multipliers) |
| `ready` → `delivering` (waiter pickup) | `StaffRouter.tickWaiter` ticket pickup logic | medium — needs server-side waiter selection (nearest free waiter, claim race) |
| `delivering` → `delivered` (waiter arrives at seat) | `StaffRouter.tickWaiter` arrival branch | already partially covered by `tick_staff_actor` H.8, but needs verification |
| Stall recovery (chef gives up, returns to queue) | `StaffRouter.recoverStalledTickets` | small — port the time-based bounce |
| Cancel on guest leave | already cascaded in `tick_guest_state` despawn | ✓ covered |

### Guests — in-meal state machine

| Transition | Where (client) | Effort |
|---|---|---|
| `walkingIn` → `seated` (arrive at chair) | `GuestSpawner.tickGuest case "walkingIn"` (line 2707) | medium — straight-line movement OK, but need to detect arrival |
| `seated` → `ordering` (waiter starts taking order) | triggered by `StaffRouter.tickWaiter` matching them with a seated guest | medium — needs server-side waiter dispatch (next gap below) |
| `ordering` → `waitingForFood` (waiter finishes order-take dwell) | `StaffRouter` take-order completion fires `enqueueOrder` | small — happens at TAKE_ORDER_DWELL_MS already; just need server reducer chain |
| `waitingForFood` → `eating` (ticket delivered → start eating) | `GuestSpawner.popDeliveredFor` triggers state flip | small — server can flip when matching delivered ticket arrives |
| `eating` → next course (orderIndex++) | timer-based in `GuestSpawner.tickGuest case "eating"` (line 3033) | **medium** — server needs course logic + `beginNextCourse` equivalent (which itself involves `reserveOne` from dishware pool) |
| `eating` → `leaving` (final course done) | same `case "eating"` branch | small — once course state is on server |
| Patience-reset on course transitions | `GuestSpawner.beginNextCourse` resets to SERVE_PATIENCE | small |
| WC trip initiation (mid-meal interruption) | `GuestSpawner.maybeStartWcTrip` | small — already partial server logic, just needs the *trigger* |
| Course → `wcWalking` interrupt | `GuestSpawner` WC trip flow | small |
| `wcSitting` → `wcWashing` (auto-flip after dwell) | `GuestSpawner.tickGuest` WC branch | small |
| `wcWashing` → resume previous state | same | small |
| `walkingToWait` → `waiting` (arrive at overflow chair) | `GuestSpawner.tickGuest case "walkingToWait"` (line 2740) | medium |
| `seated` initialization (waiter's been notified) | `GuestSpawner.tickGuest` seated transition (line 2763) | medium |

### Staff dispatch — local TS sim drives chef/waiter/barman/errand decisions

| Logic | Where (client) | Effort |
|---|---|---|
| Idle chef picks next queued ticket (per-floor preference, backlog fairness) | `StaffRouter.tryClaimCookForChef` chef-floor logic | **medium-large** — complex multi-criteria pick |
| Idle waiter picks: order-take vs. ticket-pickup vs. wash trip (priority order) | `StaffRouter.tickWaiter` idle dispatch | **medium-large** — priority is non-trivial |
| Barman picks bar tickets | `StaffRouter.tryClaimDrinkForBarman` | medium — chef variant for bar appliance |
| Errand-boy shopping trip dispatch | `ErrandRouter.tickErrand` (separate file) | medium — server already does the *transactions*; just needs the trip simulation |
| Wash-trip dispatch (pair best dirty with best station by total dist) | `StaffRouter.tryStartWashTrip` | medium-large — H.95 batch-pickup logic is non-trivial; server's `try_server_wash_load` is the offline analog but missing some logic |
| Cross-floor spill-over (chef on F0 takes F1 ticket when F1 chefs all busy) | `StaffRouter.pickChefForTicket` | small once base picker exists |
| Floor home assignment | `StaffSystem` (cloud-mirrored) | ✓ already mirrored |

### Pantry / ingredients

| Logic | Where (client) | Effort |
|---|---|---|
| Decrement ingredients when ticket enters cooking | `CookingSystem.consumeIngredientsFor` | small — already partial server logic via `recipe_ingredients` table; just needs the trigger |
| Stock-out detection (ticket rejected if no ingredients) | `StaffRouter.enqueueOrder` check | small |
| Auto-shop trigger (when stock hits low threshold) | `AutoShop` system + `ErrandRouter` | ✓ H.41 covers offline; foreground still local |

### Economy / day clock

| Logic | Where (client) | Effort |
|---|---|---|
| Income on ticket delivery → payment | `GuestSpawner.creditCourse` | medium — pricing involves taste/satisfaction math; server has *some* of this via `accumulate_pending_visit_rollup` but not the live foreground path |
| Expense on furniture purchase | `Game.buyFurniture` | ✓ already a reducer |
| Day advance | both client and server tick clocks | small |
| Rent deduction | `Game.rolloverDay` | small (already mirrored) |
| Boost button effect | `Game.activateBoost` (local-only) | small — port spawn-rate boost to server flag |

### Pathfinding

| Issue | Effort |
|---|---|
| Client uses `Pathfinder` for multi-floor routing through walls/doors | **large** — porting the pathfinder to Rust is ~3-5 days |
| Server currently uses straight-line + stair penalty | acceptable for first cut; characters will clip walls until pathfinder ports |

### Client-side rendering refactor

| Refactor | Effort |
|---|---|
| `GuestSpawner` becomes pure subscription consumer (no `this.guests` array) | **large** — ~3554 lines, many call sites |
| `StaffRouter` becomes pure subscription consumer (no `this.tickets`, `this.chefs[]`, etc.) | **large** — ~3113 lines, deeply integrated |
| `Game` removes the per-frame `update(dt)` calls that drive local sim | medium |
| Visualizers (already done in H.A/B) work with host's view too | small — just wire the existing visualizers into the main scene |

---

## Phased rollout plan

Sized so each phase is a 1-3 day commit and verifiable independently.

### Phase 1 — Ticket lifecycle (smallest, lowest risk)
Server takes over the chef-claim and waiter-pickup decisions. Local sim observes via subscription.
- Server: `tick_chef_dispatch` reducer that picks best chef for each queued ticket
- Server: `tick_waiter_pickup` for ready tickets
- Server: existing `tick_ticket_state` covers timer transitions
- Client: subscription handlers update local Ticket from cloud
- Effort: ~3 days

### Phase 2 — Pantry + economy on the server's hot path
Foreground play flows through server reducers for ingredient consumption and payment crediting (offline already works).
- Effort: ~1-2 days

### Phase 3 — Guest in-meal state machine
Port `tickGuest` state transitions for `seated`/`ordering`/`waitingForFood`/`eating`/course-advancement to Rust.
- Server: `tick_guest_meal` that handles all meal-phase transitions
- Client: pure subscription consumer for guest state
- Effort: ~3-4 days

### Phase 4 — Staff dispatch
Server picks who does what (which waiter takes which order, which waiter does which wash trip, etc.).
- Server: full chef + waiter + barman + errand dispatch in their `tick_*` functions
- Client: stops calling `cancelTicket`, `claimDirtyPickup`, etc.
- Effort: ~3-5 days

### Phase 5 — Pathfinding (or accept straight-line for v1)
Either port the multi-floor pathfinder to Rust or accept characters walking straight lines server-side (visit mode already does this; OK as a v1 trade-off).
- Effort: 0 (accept) or ~3-5 days (port)

### Phase 6 — Client refactor
Strip the local sim down to a thin subscription consumer + input forwarder. Delete `GuestSpawner.guests`, `StaffRouter.tickets`, etc.
- Effort: ~3 days

### Phase 7 — Verify continuous operation
Take a restaurant offline for a day, verify the server simulated it correctly (customers came, food was cooked, money was earned, dishes washed).
- Effort: ~1 day of monitoring + bug-fixing

**Total realistic estimate: 14-23 working days.**

---

## Risk register

| Risk | Mitigation |
|---|---|
| Server tick cost — 10Hz × N restaurants × all simulation work | profile early; throttle to 5Hz if needed; batch updates |
| Pathfinding desync (server straight-line vs. client smart paths) | accept v1; port pathfinder in v2 |
| Subscription bandwidth — high-frequency position updates | ✓ already throttled to 1Hz per actor today |
| Subtle state machine edge cases (cross-floor handoffs, course transitions) | each phase has its own test plan; verify against current local behavior |
| Latency on player actions | most actions are configuration (place furniture, hire) — accept |
| Save format compatibility | server is the save; localStorage becomes a presentation cache |

---

## What to commit to first

Phase 1 (ticket lifecycle) is the natural entry point:
- Smallest scope, contained blast radius
- Server already has most of the timer logic; just needs the dispatch decisions
- Verifiable: kitchen pipeline works end-to-end with the local sim stripped of its ticket array

Once Phase 1 ships and bakes for a session, move to Phase 2.

---

## Honest framing

This is a real refactor project, not a single session's worth of work. If we commit to it:
- Each phase is a separate commit, each shipped + verified before the next
- Roughly 2-3 weeks of focused work, depending on whether pathfinder is in scope
- Real regression risk per phase — each one moves authority

If the budget is "couple more sessions," we should pick a focused subset (e.g., Phase 1 only — server owns the ticket lifecycle, the rest stays local) and accept that we don't reach "server only for everything" in this push.

The choice is yours. The audit above is here so we can plan against reality, not estimates.
