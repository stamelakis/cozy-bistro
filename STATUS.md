# STATUS — Cozy Bistro 3D

Updated: 2026-11-22

**Status:** 🚨 GAME DOWN, new backend PREPARED but not installed. Jercy's box
is gone and its database was deleted without a backup (confirmed 2026-11-22),
so the game restarts from zero. Andreas chose option A on 2026-11-22: our own
SpacetimeDB on the shared Hetzner box. Everything for it is written and
tested locally in Docker (image, setup script, nightly prune + encrypted
backup, uptime check, Caddy block, runbook): `ops/backend/README.md` has the
design, the test table and the install steps. Nothing on the server, DNS or
GitHub has been changed yet. Note: `cozybistro.gr` does not exist; the only
live address is cozy-bistro.com.

**In progress / unfinished:** the install itself (Next #0). Local `main` is
ahead of GitHub and must NOT be pushed before the server answers: the client
now points at `wss://db.cozy-bistro.com` (`CB_HOST` in `v2/vite.config.ts`),
and a push redeploys the site. Leftover from the OneDrive move: the old
folder `C:\Users\andre\OneDrive\Documents\Restaurant Game` is EMPTY but was
locked. Its deletion is approved: a later session removes it (only if still
empty) and drops its old lines from `~/.claude/skills/start/groups.txt` and
`~/.codex/config.toml`.

**Next:**
0. [you: OK each server step] Install the backend on the box, following
   "First install" in `ops/backend/README.md` (step 1, DNS, is done). Needs
   from Andreas: an OK for the server steps and for the two changes in
   the education project's files (Caddyfile, compose network), the backup
   key into his password manager, and signing up the username `dunnin`
   first (that name is the game's admin). Also run `/security-review`
   before the push.
   Done when: cozy-bistro.com connects, a new restaurant survives a server
   restart, the 8 GB cap is proven on the box (a throwaway 64 MB image fills
   and `df -h /` does not move), the first nightly backup restores on a test,
   every other site on the box still answers 200, and disk growth has been
   measured for a few days before testers return.
1. [you: post in Discord] (after #0) Tell the testers the game is back and
   starts from zero, then post Patch 12 notes (`docs/patch-notes-12.md`, bump
   the date). Done when: posted with @Tester ping.
2. [you: tester feedback] (after #0) Collect tester reactions to the new command bar + manual litter + staffing
   gates (the in-game 💬 Feedback button feeds the admin inbox: Dev tools →
   💬 FEEDBACK INBOX). Tune tile sizes/order per feedback — one-liners in
   `v2/src/ui/CommandDock.ts`.
3. [you: pick one] Parked ideas, in rough order: sidebar button grouping (#3 of GUI ideas),
   edge-docked layout long-term (#4), special guest requests (Patch D
   leftover), first seasonal event (explicitly saved for later).

**Waiting on Andreas:**
- FIRST: a yes to the install steps (Next #0), one step at a time. The DNS
  record `db.cozy-bistro.com` → `178.104.158.125` is DONE (added at Papaki
  2026-11-22, answers on public DNS).
- After go-live: sign up `dunnin` before anyone else, then the Discord post.
- Still open from earlier: the friend's iPhone black screen — next failed boot
  shows a real error screen; ask him to retry and screenshot it.

**Known problems:**
- The compensation grant for the two bug-eaten restaurants is moot: everyone
  starts from zero.
- The game's admin is whoever owns the username `dunnin`; on the fresh
  database it must be registered before the site is public.
- Tester-facing: litter no longer pays passively and unstaffed restaurants
  earn/spend nothing — intentional, but expect "is this a bug?" feedback.
- Minor, by design: greet/stir/bus badges hide while visiting; critic sweep
  averages ~1/hour so it's rarely seen live (admin 🧪 EVENT TESTS can force it).
- The browser-pane verification trick can't log in on the live site, so
  in-game flows there are verified by Andreas, not me.

## History
- 2026-11-22: Andreas chose to self-host the backend (option A). Prepared and tested locally: `ops/backend/` (slim image, 8 GB capped data space, nightly prune + age backup, uptime check, Caddy block with 4 paths). The lab found and fixed two traps: signing keys outside the data folder, and pruning after a full-disk crash destroying the database.
- 2026-11-22: Moved out of OneDrive to `C:\Users\andre\Restaurant Game` (copy verified, builds + server compile + local start pass, pushed, old copy deleted). 4676c71, 44381f4
- 2026-11-22: State check — site up, backend DNS name gone (game down); recorded here, no code changed.
- 2026-08-12: Daily-goals click fix (persistent DOM, day-keyed claim latch, margin). 53850ce
- 2026-08-12: Top bar v3 per Andreas's spec (nav left stacked, labeled tile rows center, timers+bell right, floor tab below) + thinner. a31ec86, 57b7e6c
- 2026-08-12: Nothing floats on PC — Build/Recipes/Chat/Players are bar-anchored dropdowns; CommandDock tiles; mobile-boot race fixed. 3ea2879…a8bcb4c
- 2026-08-12: Unified TopStrip; bell/tray repositioning; RECIPE MENU rename + pulses + sidebar shortcuts. 1abf206…3d0a818
- 2026-08-12: Litter manual (+emoji decals) + staffing gates (no orders/cooking/shopping without the right staff; auto_shop_enabled server column). 0149af8
- 2026-08-12: Ledger "Recycling ♻" label (was "Furniture refund"). 24539a3
- 2026-08-12: Season-reset stamp ACCOUNT-scoped (silent multi-device wipes dead); all accounts backfilled at gen 8; dunnin's staff re-adopted 16398→16400. 773f317
- 2026-08-11: Beta hardening: 💬 feedback loop, admin event tests, Prep Counter, 🏆 champion plaque, server-side dish reservations. 61b0728
- 2026-08-11: Patches A–D: timer chips + 🔔 feed, greet/bus/stir taps, daily goals + regulars, critic sweep. 363cdc5
- 2026-08-11: Dishware leak audit fixes (6 root causes) + collect_clue exploit hardening. d009d81
- 2026-08-03 and earlier: demand model, cozy-bistro.com migration, wash escalation, clue hunt, OG image, boot watchdog — see git log.
