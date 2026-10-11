# Cozy Bistro 3D — project notes for Claude

The real game is `v2/` (Three.js + SpacetimeDB). The repo root's own
index.html is the legacy 2D game, served at /classic/. Design docs: `docs/`.

## Where things run
- LIVE: https://cozy-bistro.com (GitHub Pages, repo stamelakis/cozy-bistro,
  DNS at Papaki). Backend: SpacetimeDB `dunnin` on wss://dunnin-spacetime.ownsun.de.
- STAGING: /staging/cozy-bistro-3d/ + `?env=staging` → DB `dunnin-staging`,
  built from the `staging` BRANCH. Keep it synced: `git push origin main:staging`
  and publish the module to dunnin-staging too — do both on every server change.

## Deploy pipeline (what actually works)
1. Server: `spacetime publish --server ownsun -p . dunnin --yes` from
   `v2/spacetime` (repeat for dunnin-staging). Schema adds → clients reconnect.
2. After any schema change: `spacetime generate --lang typescript
   --out-dir ../src/cloud/generated --module-path .` then rebuild the client.
3. Client: `$env:CB_BASE='/'; npm run build` in v2 (tsc must pass), commit,
   push main (+ main:staging); GitHub Actions deploys. Verify with
   `gh run watch` + compare the live `index-*.js` hash to `v2/dist/assets/`.
4. Pages builds BOTH branches on any push; concurrent pushes cancel the first
   run — watch the LATEST run.

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
- OneDrive path: the repo lives under OneDrive — never create .cmd files here.

## Decisions (do not undo casually)
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

## Memory
Deep per-feature history (dishware audit, resets, retention features, stats)
lives in Claude's auto-memory under `## Cozy Bistro`, not in this repo.
