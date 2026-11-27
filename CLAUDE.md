# Cozy Bistro 3D — project notes for Claude

The real game is `v2/` (Three.js + SpacetimeDB). The repo root's own
index.html is the legacy 2D game, served at /classic/. Design docs: `docs/`.

## Where things run
- LIVE: https://cozy-bistro.com (GitHub Pages, repo stamelakis/cozy-bistro,
  DNS at Papaki). Backend: SpacetimeDB `dunnin` on OUR Hetzner box,
  wss://db.cozy-bistro.com (host baked in at build time: `CB_HOST`, see
  vite.config.ts). Runbook, design and tests: `ops/backend/README.md`.
  Installed 2026-11-22. (Jercy's ownsun.de box is gone.)
- STAGING: /staging/cozy-bistro-3d/ + `?env=staging` → DB `dunnin-staging`,
  built from the `staging` BRANCH. Keep it synced: push both branches in ONE
  command, `git push origin main main:staging` (step 5 below says why), and
  publish the module to dunnin-staging too — do both on every server change.

## Deploy pipeline (what actually works)
1. Server: open the SSH tunnel (`ops/backend/README.md`), then
   `spacetime publish --server cozybox -p . dunnin --yes` from `v2/spacetime`
   (repeat for dunnin-staging). Schema adds → clients reconnect.
2. After any schema change: `spacetime generate --lang typescript
   --out-dir ../src/cloud/generated --module-path .` then rebuild the client.
3. Client: `$env:CB_BASE='/'; npm run build` in v2 (tsc must pass), commit,
   `git push origin main main:staging`; GitHub Actions deploys. Verify with
   `gh run watch`, then the served `index-*.js`: its `Last-Modified` is
   the run's time and it contains a string that is new in this change.
   Its NAME does not match a local build's (GitHub builds on Linux with
   Node 20; seen 2026-11-23), so do not compare names with `v2/dist`.
4. Pages builds BOTH branches on any push; concurrent pushes cancel the first
   run — watch the LATEST run.
5. Pages deploys a commit only ONCE. Pushing `main` and later `main:staging`
   at the same commit makes a second run that reports success and changes
   nothing: /staging/ keeps the build from the first run (seen 2026-11-23).
   So push both in one command, and check the staging page's `index-*.js`
   name changed. If it did not, a new commit pushed to both fixes it.

## Gotchas (each one cost real time)
- 🚨 `spacetime sql` (CLI v2.3) **UPDATE ignores the WHERE clause** — it
  updated every row in the table. SELECT respects WHERE; DELETE worked in
  nuke-prod.sh. NEVER use SQL UPDATE on live data; write a reducer.
- PowerShell `git commit -m` with $-signs/quotes/colons in the message breaks
  as pathspecs. ALWAYS write the message to a scratch file and `git commit -F`.
- New table columns: append LAST with `#[default(...)]` or publish aborts
  (mid-struct = manual migration). Option<String> uses `#[default(None::<String>)]`.
- `init` runs once per DB lifetime: new scheduled tables need an idempotent
  bootstrap reducer called manually after publish (pattern:
  bootstrap_world_events, bootstrap_season_stamps).
- `initMobileUI()` runs AFTER the Engine constructor (main.ts) — boot-time
  mobile checks must use `isMobileDevice()` from MobileUI, not body.cb-mobile.
- UI widgets refreshed by the ~5Hz HUD tick must NOT rebuild DOM every tick:
  buttons die between mousedown/mouseup ("eaten clicks"). Pattern: signature-
  gated rebuild + in-place text updates (see GoalsWidget).
- Lockstep formulas (server ⟷ client must match EXACTLY):
  rating_demand ⟷ demandForRating; daily_goals_for ⟷
  SpacetimeClient.getDailyGoals (splitmix64 via BigInt).
- The browser pane can verify geometry/DOM on the live site via
  javascript_tool, but it registers as MOBILE (zero viewport) — simulate
  desktop by removing body.cb-mobile before measuring; it can't log in.

- The server module cannot run `cargo test` (it only links inside
  SpacetimeDB). Tests live in `v2/spacetime/rules-tests/`, which includes
  database-free rule files by path: `npm run test:server` in `v2/`.
- A page built before a schema change cannot read the upgraded server
  (empty restaurant, "Tried to read 65536 byte(s)"). Publish the server
  and push the regenerated page back to back; never commit regenerated
  bindings to `main` before the server is published.
- `spacetime` CLI: its default server is NOT the local one. For a local
  test always pass `--server http://127.0.0.1:3000`.

## Decisions (do not undo casually)
- **Money rules are pure functions with tests (guest wishes, 2026-11-23):**
  `wish_rules.rs` decides and returns "what to write"; `restaurant_sim.rs`
  only reads rows and applies it. The $60-a-game-day ceiling comes from
  the pause (min 120 s) stamped on EVERY wish event in
  `restaurant.last_wish_micros`; change a number there and a test fails.
  Rejected: rules inline in the reducers (untestable on the PC), a
  per-day counter (a second thing to reset).
- **Page code for a new server field goes in as "may be missing" first
  (guest wishes, 2026-11-23):** an optional type for the new columns and
  a cast for the new reducers let the page build with bindings from
  before AND after the schema change, so the page code can sit on `main`
  while the regenerated bindings wait for the server publish. Rejected:
  committing the bindings early (a push would break the live page). The
  optional types come out once server and bindings are live (done for
  the wishes on 2026-11-28; the pattern is in commit `520a41c`).
- **Lives at `C:\Users\andre\Restaurant Game`, outside OneDrive, since
  2026-11-22.** OneDrive couldn't sync code projects (3,607 sync problems on
  2026-11-19). Backup is git + GitHub. Don't move it back into OneDrive.
- **Backend is self-hosted with a nightly prune and a hard disk cap
  (2026-11-22).** SpacetimeDB's log never shrinks by itself; that filled the
  previous host and the database was deleted without a backup. Rejected:
  Maincloud (ticks cost ~$25/month), running without pruning, pruning a
  database that isn't healthy (lost the lab database). Rules that must stay:
  `ops/backend/README.md` "Why it is built this way".
- **Staffing gates (0149af8):** no orders without an active waiter (barman for
  bar seats), no ticket/ingredients/restock without an active chef/barman, no
  auto-shopping without auto_shop_enabled AND an active errand helper. The
  H.14 ordering fallback is gated on roster presence — it exists for BUSY
  staff, not ABSENT staff. Rejected: letting the 24/7 economy run unstaffed
  (it silently drained wallets with zero sales).
- **Litter is manual (0149af8):** pieces persist (cap 12) until the player
  taps ♻ (+$2, client drips claims every 2.6s; server claim_recycle cooldown
  2.5s). Rejected: passive auto-recycle income.
- **Season reset is ACCOUNT-scoped (773f317):** auth_record.season_gen_done +
  process_season_reset (stamp+wipe in one transaction). localStorage marker is
  only a per-browser hint. Rejected: per-browser marker alone — it wiped the
  live restaurant from every new device/domain (ate two restaurants).
- **Dishware reservations are server-side (61b0728):** reserve_course_dish at
  ticket creation (both paths), idempotent by CSV length; client reserve/
  settle/mirror fully gated off under isServerSim("dishware"). Tier-0 CSV
  entries are positional sentinels — skip in place, never filter.
- **PC GUI = one top bar (…57b7e6c):** TopStrip zones (nav left / labeled tile
  rows center / timers+bell right / floor tab below); Build, Recipe Menu,
  Chat, Players start HIDDEN and toggle as bar-anchored dropdowns
  (Engine.toggleDock). Desktop hides sidebar .cb-hud-buttons; mobile hides the
  dock and keeps ALL its old layouts via `position:fixed !important`
  overrides on .cb-floorsel/.cb-cameracontrols — never break those overrides.
- **Demand model is absolute, not %-of-seats** (Andreas's explicit call):
  1★=6 … 5★=140 geometric, LINE_ALLOWANCE 10.
- Claim-style reducers: owner gate → `last_*_micros` cooldown with silent
  `Ok(())` → effect + stamp in one update → record_money_event (copy
  claim_tip_bonus).

## Data on this PC
- Docker image `cozybistro-stdb:<version>` (~300 MB): the server image we
  ship to the box. Keep only the version that runs on the box; delete the
  older one after an update. Local test containers, volumes and the 3.5 GB
  official `clockworklabs/spacetime` image are removed when a test ends.
- `v2/dist` (build output, gitignored): overwritten by every build.
- `v2/spacetime/target` (~1.2 GB) and `v2/spacetime/rules-tests/target`
  (~25 MB): Rust build caches, gitignored, safe to delete (the next build
  takes a few minutes longer).

## Memory
Deep per-feature history (dishware audit, resets, retention features, stats)
lives in Claude's auto-memory under `## Cozy Bistro`, not in this repo.
