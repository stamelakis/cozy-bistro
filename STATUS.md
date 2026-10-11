# STATUS — Cozy Bistro 3D

Updated: 2026-08-12

**Status:** Soft beta, live at https://cozy-bistro.com (backend `dunnin`).
Everything from this session is deployed to BOTH prod and staging and the
working tree is clean. Nothing is broken.

**In progress / unfinished:** nothing half-done. The last change (daily-goals
click fix, commit 53850ce) is live but hasn't been felt in-game by Andreas yet.

**Next:**
1. Post Patch 12 notes to Discord — ready to paste in `docs/patch-notes-12.md`
   (bump the date if posting late). Done when: posted with @Tester ping.
2. Collect tester reactions to the new command bar + manual litter + staffing
   gates (the in-game 💬 Feedback button now feeds the admin inbox: Dev tools →
   💬 FEEDBACK INBOX). Tune tile sizes/order per feedback — one-liners in
   `v2/src/ui/CommandDock.ts`.
3. Decide the compensation grant (~$10k) for the two bug-eaten restaurants
   (Aug 9 silent reset + overnight bleed-out). One admin money call once
   Andreas says yes.
4. Parked ideas, in rough order: sidebar button grouping (#3 of GUI ideas),
   edge-docked layout long-term (#4), special guest requests (Patch D
   leftover), first seasonal event (explicitly saved for later).

**Waiting on Andreas:**
- Post the patch notes (see Next 1): open `docs/patch-notes-12.md`, copy the
  code block, paste in Discord. → Reply "posted" or adjust first.
- In-game sanity pass (5 min): claim a daily goal (should work first click),
  open/close Build·Recipes·Chat·Players from the top bar, place a Prep
  Counter, tap some litter ♻. → Report anything that feels off via the game's
  Feedback button or next session.
- Say yes/no to the ~$10k refund (Next 3).
- Still open from earlier: the friend's iPhone black screen — next failed boot
  shows a real error screen; ask him to retry and screenshot it.

**Known problems:**
- Tester-facing: litter no longer pays passively and unstaffed restaurants
  earn/spend nothing — intentional, but expect "is this a bug?" feedback.
- Minor, by design: greet/stir/bus badges hide while visiting; critic sweep
  averages ~1/hour so it's rarely seen live (admin 🧪 EVENT TESTS can force it).
- The browser-pane verification trick can't log in, so in-game flows are
  verified by Andreas, not me.

## History
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
