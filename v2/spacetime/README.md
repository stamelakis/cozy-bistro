# Cozy Bistro — SpacetimeDB module

The server-side database for Cozy Bistro 3D. Handles cloud saves,
achievements, leaderboards, friends, and co-owned restaurants.

## What's in here

```
spacetime/
├── Cargo.toml                  Rust crate (compiles to WASM)
├── src/
│   ├── lib.rs                  module entry
│   ├── tables.rs               schema (Player, Restaurant, SaveSnapshot, …)
│   └── reducers/
│       ├── mod.rs              re-exports
│       ├── lifecycle.rs        init / client_connected / set_player_name
│       ├── restaurants.rs      create / delete / save_snapshot
│       ├── achievements.rs     unlock_achievement
│       ├── leaderboard.rs      submit_leaderboard
│       └── friends.rs          friend requests + co-owners
```

## One-time setup

Install Rust (we compile to WebAssembly) and the SpacetimeDB CLI:

```bash
# Rust toolchain (Windows: use the rustup-init.exe from https://rustup.rs)
# After install, in a NEW shell:
rustup target add wasm32-unknown-unknown

# SpacetimeDB CLI
#   Windows:    iwr https://install.spacetimedb.com -useb | iex
#   macOS/Linux: curl -sSf https://install.spacetimedb.com | bash
```

Verify:

```bash
rustup --version
spacetime version
```

## Build + publish

From the repo root:

```bash
cd v2/spacetime

# Compile the module (fast incremental once the first build is done).
spacetime build

# Publish to SpacetimeDB Maincloud. Names must be lowercase + hyphens.
# Pick something unique like cozy-bistro-andre or cozy-bistro-prod.
spacetime publish --project-path . cozy-bistro-andre

# Maincloud will print the module's host + identity. Save the module name
# somewhere — the client points at it.
```

The first publish prompts you to log in (browser-based OAuth). Subsequent
publishes reuse the token.

## Generate TypeScript bindings for the v2 client

```bash
# From v2/spacetime, generate bindings into the client's cloud/ folder:
spacetime generate --lang typescript --out-dir ../src/cloud/generated \
  --project-path .
```

Re-run this anytime you change `tables.rs` or any reducer signature.

## Quick test (CLI)

```bash
# Open a shell against the live module
spacetime sql cozy-bistro-andre "SELECT * FROM player"

# Call a reducer as your CLI identity
spacetime call cozy-bistro-andre create_restaurant '["My First Bistro", true]'
```

## What ships v0

- Cloud saves: one `save_snapshot` per restaurant, upserted by the owner
  or a co-owner. Stores a JSON blob + denormalized day/money/rating for
  quick listing.
- Achievements: `achievement_unlock` rows. Idempotent reducer skips dupes.
- Leaderboards: `submit_leaderboard(restaurant_id, category, score, day)`
  appends a row. Top-N is computed client-side from the subscription.
- Friends + co-owners: full CRUD via reducers, friendship pair stored
  canonically (player_a < player_b by raw bytes).

## What client work it needs (v2/src/cloud/)

- `SpacetimeClient.ts` — wraps connect / disconnect / re-subscribe
- Bind `Engine.saver.saveNow()` to also call `save_snapshot` on the DB
- Auto-load cloud save on startup (latest restaurant for this identity)
- Hook `AchievementSystem.onUnlock` → `unlock_achievement(id)`
- Hook `Game.onDayEnded` → `submit_leaderboard(...)` for each category
- New UI modals: Restaurants list, Friends, Leaderboards
