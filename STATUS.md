# STATUS — Cozy Bistro 3D

Updated: 2026-11-28

**Status:** ✅ THE GAME IS BACK since 2026-11-23 06:30 UTC, from zero, on our
own server: SpacetimeDB 2.3.0 on the shared Hetzner box, players' address
`wss://db.cozy-bistro.com`. cozy-bistro.com was redeployed from `main` and
connects (seen in a browser). Staging connects too since 23 Nov 11:25 UTC.
`dunnin` (the admin) is signed up on LIVE and on STAGING.
**Guest wishes are LIVE since 23 Nov 16:17 UTC** (server on both databases,
page pushed one minute later, commit `98dd26f`, tag `deploy-2026-11-23-1`)
and **checked in the live game by Andreas on 27 Nov**: both wishes paid.
LIVE has a second account with a
restaurant (id 4097, last played 23 Nov 10:01 UTC); who it is, is not known.
Runbook, design and all test results: `ops/backend/README.md`. Testers have
NOT been told yet; the message for them is drafted
(`docs/decisions/discord-back.md`) and waits for Andreas's yes. Note: `cozybistro.gr` does not exist; the only live
address is cozy-bistro.com.

**In progress / unfinished (Next #0: only readings on the box are left):**
- (Done 23 Nov: the nightly job's lock fix is on the server. The first
  scheduled run had skipped itself, see README "What was tested". The job
  now runs at 03:32 UTC; run by hand after the install: 2 s of downtime,
  backup made. Check once that the run of 24 Nov 03:32 is in
  `/var/log/cozybistro-nightly.log`. The old scripts are in
  `/root/cozybistro-fix/old` on the box; delete that folder after it.)
- (Done 23 Nov: backup key. The first key was deleted before it was stored
  anywhere, so `cozybistro-20261122-215020` and `-20261123-063649` cannot
  be opened; they rotate out by themselves. New pair made, backup
  `-20261123-065155` restored on the PC with it (`dunnin`, restaurant 1,
  same signing keys). The private half is in Andreas's Bitwarden, entry
  `Cozy Bistro backup key (age)`; his stored copy was compared with the
  original before the PC file was deleted. Leftover on the box:
  `/opt/cozybistro-backup.pub.old`, delete with the fix folder.)
- (Done 23 Nov: staging. `dunnin` exists on `dunnin-staging` (checked on the
  server), `main` and `staging` are at the same commit, and
  /staging/cozy-bistro-3d/ serves a build for `wss://db.cozy-bistro.com`:
  STAGING badge and "[SpacetimeDB] connected" seen in a browser. The first
  staging push changed nothing for 4 hours: Pages deploys a commit only
  once, see CLAUDE.md "Deploy pipeline" step 5.)

- (Done 27 Nov: guest wishes, all three parts. Published 23 Nov, both
  wishes seen paying on live on 27 Nov. Record:
  `docs/decisions/guest-requests.md`, "Go-live, 23 Nov" and "Checked on
  live, 27 Nov". The code tidy-up after go-live is done too, 28 Nov.)

Leftover from the OneDrive move: the old folder
`C:\Users\andre\OneDrive\Documents\Restaurant Game` is EMPTY but was locked.
Its deletion is approved: a later session removes it (only if still empty)
and drops its old lines from `~/.claude/skills/start/groups.txt` and
`~/.codex/config.toml`.

**Disk growth (watch for a few days before telling testers):**
- 22 Nov 21:36 UTC: 13 MB used of 7.8 GB (fresh, two empty databases).
- 23 Nov 06:29 UTC: 26 MB used. The live database's log grew 12 MB in 8.8 h
  with one idle restaurant: about 33 MB a day, the same as in the lab (36).
- 23 Nov 16:15 UTC: 170 MB used; live log 138 MB in three pieces, staging
  17 MB. That is 144 MB in 9.8 h, about ten times the idle rate. Why was
  not looked into; a connected player alone writes about 7 MB an hour
  (README), and restaurant 4097 was played until 10:01 UTC. The
  by-hand nightly run of 16:15 did its first real prune step (dropped the
  oldest snapshot, "removed 0 old log piece(s)"), database fine after.
  Backups are now 24 MB each (were 2.3 MB).
- Next reading: `df -m /opt/cozy-bistro/data` and
  `du -sm /opt/cozy-bistro/data/replicas/*/clog` on the box. Pruning starts
  only after the log passes 64 MB twice (about day 4 when idle); check then
  that `/var/log/cozybistro-nightly.log` says "removed N old log piece(s)".

**Next:**
0. [you: yes to read-only checks on the box, then to deleting leftovers]
   On or after 24 Nov 04:00 UTC: read `/var/log/cozybistro-nightly.log`
   (did the 03:32 run make a backup?), take the second growth reading
   ("Disk growth"), then with Andreas's OK delete this install's leftovers
   on the box: `/root/cozybistro-fix/`, `/opt/cozybistro-backup.pub.old`,
   `/etc/fstab.bak-20261122-212045`, `/opt/offsite-push.sh.bak-20261122-2153`,
   and in `/opt/edu-admin` (education project's folder) the two files
   `Caddyfile.bak-20261122-2130` and `docker-compose.yml.bak-20261122-2130`.
   Done when: the nightly run of 24 Nov is in the log with a backup, a
   second growth reading is written above, the leftovers are gone.
1. [you: post in Discord] (after #0, and after a few days of growth
   readings) Tell the testers the game is back and starts from zero (text,
   and the three server checks that must be green first:
   `docs/decisions/discord-back.md`), then post Patch 12 notes
   (`docs/patch-notes-12.md`: bump the date, post as two messages, swap the
   "never reset / refund" line as that file proposes), then the guest
   wishes notes (`docs/patch-notes-13.md`, a draft). Done when: posted
   with @Tester ping.
2. [you: tester feedback] (after #1) Collect tester reactions to the new command bar + manual litter + staffing
   gates (the in-game 💬 Feedback button feeds the admin inbox: Dev tools →
   💬 FEEDBACK INBOX). Tune tile sizes/order per feedback — one-liners in
   `v2/src/ui/CommandDock.ts`.
3. [you: pick later] Still parked, compared in
   `docs/decisions/next-feature.md`: A button grouping (cheap; fits the
   feedback tuning in #2), B edge-docked layout, D first seasonal event.

**Waiting on Andreas:**
- **This PC, your call (not this project):** the Claude app's PATH
  carries about 70 old build folders of "Humanity At War 2" and is 9,295
  characters long. Windows' command shell stops finding programs above
  8,191, so `npm run build` failed here with "'tsc' is not recognized"
  until I used a short PATH for my own commands. The PATH saved in
  Windows is short (2,580), so restarting the Claude app may be all it
  needs; if it comes back, that project's tools are adding the folders.
- **Post this text? yes / change X.** The Discord message "the game is
  back, everyone starts from zero and why" is drafted in
  `docs/decisions/discord-back.md`, with the four choices made in it (how
  plainly it names the cause, the apology, the promise "we lose a day, not
  everything", no welcome-back gift) and the three server checks that must
  be green on posting day. Same file, same yes: post Patch 12 as TWO
  messages (it is 2,649 characters, Discord's limit is 2,000) and swap its
  "will never silently reset again / refund" line for the proposed one.
  Nothing is posted until Next #1.
- Other projects, his call: (a) the live `/opt/offsite-push.sh` is newer than
  its copies in the TakeaSeat repo (`server/offsite-push.sh`) and the
  education repo (`ops/offsite-push.sh`); neither copy has the webstudio and
  cozybistro lines, so installing a repo copy would drop them. (b) The
  education repo has three unpushed commits from the install (`fd35a37`
  Caddyfile + compose network, `b6d55e4` and `8c433c6` BOX.md); the live
  files already match them.
- Still open from earlier: the friend's iPhone black screen — next failed boot
  shows a real error screen; ask him to retry and screenshot it.

**Known problems:**
- Staging's furniture price list is empty: a visitor's page tries to fill
  it and the server refuses ("Furniture cost catalog changes are
  admin-only", hundreds of console errors on a first visit). The page
  fills it by itself the next time `dunnin` is logged in on staging while
  it loads (`Engine.ts`, catalog reseed). Until then buying furniture on
  staging may fail. LIVE has the furniture list; a first visit there shows
  4 "Recipe catalog changes are admin-only" errors, not looked into.
- Seen 23 Nov on PC, older than the wishes: the round tap badges (👋, 🥄,
  ♻, now ⚡/🎂) draw over the top bar when the camera puts a guest under
  it. Not fixed.
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
- 2026-11-28: Guest wishes, tidy-up: the page reads the wish fields and the two reducers through the generated types (the "may be missing" types are gone). `tsc`, build and the 29 tests pass; pushed to both branches, both pages serve the new build and connect, no read error. Not seen: a wish in the live game after this change (needs a login). Found on the way: the "file names never match" note of 23 Nov was wrong, the cause was building in Git Bash (CLAUDE.md step 3 corrected again); and the PATH problem under "Waiting on Andreas". 571386c
- 2026-11-27: Guest wishes CHECKED ON LIVE by Andreas (restaurant 1). A ⚡ wish that came by itself: tapped after 8 s, plate 22 s after the wish, +$10, "Guest wish ⚡🎂" in his Ledger screenshot. A 🎂 wish forced from Dev tools: tapped after 5 s, +$6 (server log and ledger table; it came after his screenshot). No error from the wish code in the module log. The feature is done.
- 2026-11-23: Guest wishes PUBLISHED. Backup by the nightly job run by hand (2 s of downtime), server module to `dunnin-staging` then `dunnin` (four fields added with defaults, row counts of 13 tables the same before and after on both), bindings regenerated, page pushed to `main` + `staging` in one command one minute after the live publish, Pages run green. Both pages connect with the new build. Found on the way: the file name of the page built by GitHub does not match a local build's (CLAUDE.md deploy step 3 corrected); LIVE has a second account. Not done: a wish seen in the live game (Andreas). 98dd26f
- 2026-11-23: Guest wishes, the page: ⚡/🎂 badge with a countdown (one more `TapBadges` layer, hidden while visiting), "+$" pop, Ledger line, Help section, two admin buttons to force a wish. Build and 29 rule tests pass; on a local server both wishes paid on PC and phone size and one hurry promise was missed at 60 s. The page reads the new fields as "may be missing", so it is committed without the regenerated bindings. Not published, not pushed.
- 2026-11-23: Prep for the guest-requests build: the plan on one page (`docs/decisions/guest-requests.md`), with wishes, reward sizes taken from today's tip and goal numbers, limits, staffing rules and a "done when" line. No game code changed. Found on the way: the project has no automated tests at all; the hurry time limit could not be measured without a running local server. Andreas approved the plan the same day ("yes, as written").
- 2026-11-23: Prep for the next-feature pick: the four parked ideas compared on one page (`docs/decisions/next-feature.md`), recommendation C. No game code changed. The ideas' original wording was not on file; the page says so. Andreas picked C the same day.
- 2026-11-23: Drafted the Discord message "the game is back, from zero, and why" (`docs/decisions/discord-back.md`), nothing posted. Found on the way: the Patch 12 notes are over Discord's 2,000-character limit (post as two messages) and their "never reset / refund" line needs new wording after the restart.
- 2026-11-23: Staging is on the new server too: `dunnin` signed up there, `main` + `staging` pushed together, /staging/ seen connecting. Found on the way: Pages deploys a commit once, so `main` then `main:staging` at the same commit left staging on the old build (CLAUDE.md deploy step 5). e4d8b7e
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
