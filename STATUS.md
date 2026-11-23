# STATUS — Cozy Bistro 3D

Updated: 2026-11-23

**Status:** ✅ THE GAME IS BACK since 2026-11-23 06:30 UTC, from zero, on our
own server: SpacetimeDB 2.3.0 on the shared Hetzner box, players' address
`wss://db.cozy-bistro.com`. cozy-bistro.com was redeployed from `main` and
connects (seen in a browser). `dunnin` (the admin) is signed up on LIVE.
Runbook, design and all test results: `ops/backend/README.md`. Testers have
NOT been told yet. Note: `cozybistro.gr` does not exist; the only live
address is cozy-bistro.com.

**In progress / unfinished (Next #0, two things left):**
- (Done 23 Nov: the nightly job's lock fix is on the server. The first
  scheduled run had skipped itself, see README "What was tested". The job
  now runs at 03:32 UTC; run by hand after the install: 2 s of downtime,
  backup made. Check once that the run of 24 Nov 03:32 is in
  `/var/log/cozybistro-nightly.log`. The old scripts are in
  `/root/cozybistro-fix/old` on the box; delete that folder after it.)
- **Backup key: new pair made 23 Nov, restore test PASSED, storing it is
  open.** The first key was deleted before it was stored anywhere (Andreas
  has no password manager), so the backups `cozybistro-20261122-215020` and
  `-20261123-063649` cannot be opened; they rotate out by themselves (7
  kept). New public half is on the box (old one: `/opt/cozybistro-backup.pub.old`).
  Backup `-20261123-065155` was restored on the PC: `dunnin`, restaurant 1,
  same signing keys. The private half is in ONE place:
  `C:\Users\andre\cozybistro-backup-key.txt` (one line, outside every repo).
  Andreas chose a password manager and still has to set one up and paste
  the key in. Do NOT delete the file until his stored copy has been
  compared with it (he pastes it back into an empty file; compare, then
  delete both).
- **Staging.** `dunnin-staging` is published but has NO `dunnin` account,
  and the `staging` branch is not pushed: /staging/ still points at the dead
  old server. Order: Andreas signs up `dunnin` on staging (local build with
  `?env=staging`), then `git push origin main:staging`.

Leftover from the OneDrive move: the old folder
`C:\Users\andre\OneDrive\Documents\Restaurant Game` is EMPTY but was locked.
Its deletion is approved: a later session removes it (only if still empty)
and drops its old lines from `~/.claude/skills/start/groups.txt` and
`~/.codex/config.toml`.

**Disk growth (watch for a few days before telling testers):**
- 22 Nov 21:36 UTC: 13 MB used of 7.8 GB (fresh, two empty databases).
- 23 Nov 06:29 UTC: 26 MB used. The live database's log grew 12 MB in 8.8 h
  with one idle restaurant: about 33 MB a day, the same as in the lab (36).
- Next reading: `df -m /opt/cozy-bistro/data` and
  `du -sm /opt/cozy-bistro/data/replicas/*/clog` on the box. Pruning starts
  only after the log passes 64 MB twice (about day 4 when idle); check then
  that `/var/log/cozybistro-nightly.log` says "removed N old log piece(s)".

**Next:**
0. [you: store the backup key in a password manager, sign up on staging] Finish the install:
   the two things under "In progress".
   Done when: the scheduled nightly run of 24 Nov made a backup,
   the backup key is stored and checked (the restore test passed 23 Nov), `dunnin` exists on staging and
   /staging/ connects, and a second growth reading is written above.
1. [you: post in Discord] (after #0, and after a few days of growth
   readings) Tell the testers the game is back and starts from zero, then
   post Patch 12 notes (`docs/patch-notes-12.md`, bump the date). Done when:
   posted with @Tester ping.
2. [you: tester feedback] (after #1) Collect tester reactions to the new command bar + manual litter + staffing
   gates (the in-game 💬 Feedback button feeds the admin inbox: Dev tools →
   💬 FEEDBACK INBOX). Tune tile sizes/order per feedback — one-liners in
   `v2/src/ui/CommandDock.ts`.
3. [you: pick one] Parked ideas, in rough order: sidebar button grouping (#3 of GUI ideas),
   edge-docked layout long-term (#4), special guest requests (Patch D
   leftover), first seasonal event (explicitly saved for later).

**Waiting on Andreas:**
- Set up a password manager and store the backup key from
  `C:\Users\andre\cozybistro-backup-key.txt`, then paste it back once so the
  copy can be checked.
- Sign up `dunnin` on staging.
- Other projects, his call: (a) the live `/opt/offsite-push.sh` is newer than
  its copies in the TakeaSeat repo (`server/offsite-push.sh`) and the
  education repo (`ops/offsite-push.sh`); neither copy has the webstudio and
  cozybistro lines, so installing a repo copy would drop them. (b) The
  education repo has two unpushed commits from the install (`fd35a37`
  Caddyfile + compose network, `b6d55e4` BOX.md); the live files already
  match them.
- Still open from earlier: the friend's iPhone black screen — next failed boot
  shows a real error screen; ask him to retry and screenshot it.

**Known problems:**
- Not tested: the owner mails of the nightly job and the uptime check (no
  incident so far), and growth with real players.
- A skipped nightly run sends no mail. After the lock fix that only happens
  when two runs really overlap, but nothing warns if backups stop for
  another reason. Idea: a "newest backup is older than 36 h" alert.
- The compensation grant for the two bug-eaten restaurants is moot: everyone
  starts from zero.
- Tester-facing: litter no longer pays passively and unstaffed restaurants
  earn/spend nothing — intentional, but expect "is this a bug?" feedback.
- Minor, by design: greet/stir/bus badges hide while visiting; critic sweep
  averages ~1/hour so it's rarely seen live (admin 🧪 EVENT TESTS can force it).
- The browser-pane verification trick can't log in on the live site, so
  in-game flows there are verified by Andreas, not me.

## History
- 2026-11-23: Backend INSTALLED on the shared Hetzner box and the site switched to it (`main` pushed 06:29 UTC, seen connecting in a browser). Image shipped, 8 GB capped data space (cap proven with a 64 MB test image), age backup key, Caddy block with four paths, both databases published, cron jobs, off-site line; the 12 other addresses on the box answered as before; security review found nothing. Found next morning: the scheduled nightly run lost its lock to the uptime check and skipped (fix f301d63, installed the same morning). 90b543b
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
