# Discord: "the game is back" (draft for the "post in Discord" item)

Status: DRAFT, not posted. Andreas posts it himself, after the readings on
the server (Next #0 in `STATUS.md`) and a few days of disk-growth readings. Question in `STATUS.md`: "Post this text?
yes / change X".

## The text (paste into Discord, replace DD-MM-2026 with the posting day)

About 1,400 characters; Discord allows 2,000 per message.

```
📢 Cozy Bistro is back  DD-MM-2026
@Tester

The game is online again at https://cozy-bistro.com. I owe you an explanation, because everyone starts from zero.

💥 What happened
The game's database kept growing quietly in the background until it filled the disk of its old server, and the database was deleted. There was no backup. Every restaurant, every account and every leaderboard entry is gone, mine included. That one is on me: I should have had backups from day one, and I'm sorry.

🏠 What's different now
• The game runs on my own server.
• A backup is made every night and a copy is kept in a second place. I restored one to make sure it really works.
• The database is trimmed automatically every night so it stays small, and an automatic check watches the server every few minutes.
Worst case from now on: we lose a day, not everything.

🔑 What you need to do
• Open https://cozy-bistro.com and sign up again (username + password). Your old login no longer exists.
• All usernames are free again, so grab yours before someone else does.
• You start with a brand-new restaurant. So does everybody else, so the leaderboards are a fresh race.

🙏 Thank you for sticking around. It's still a beta and things can break, but not like this again. If anything looks off, use the 💬 Feedback button in the game or ping me here.

Patch 12 notes are right below: a lot changed while the game was away.
```

## Choices made in this text (each is easy to change)

1. **How much it says about the cause.** It says plainly that the disk
   filled, the database was deleted and there was no backup. It does not
   name the old host or say who pressed delete. Softer alternative: "a
   server problem wiped the database". Recommended: keep the plain
   version. Testers lost real hours; a vague reason reads as hiding
   something, and a clear one makes the "what's different now" part
   believable.
2. **The apology.** One sentence that takes the blame. Alternative: drop
   it and only state facts. Recommended: keep it. It is short and it is
   what people want to hear first.
3. **The promise "we lose a day, not everything".** True by design
   (nightly backup plus a copy off the server), but it is a promise in
   public. Alternative: delete that one line. Recommended: keep it only
   if the three checks below are green on posting day.
4. **No welcome-back gift.** The text promises no starting bonus. A gift
   would be a game change (new code, a balance decision), so it is not in
   this draft. If Andreas wants one, that is a separate item before
   posting.

## Check before posting (all read-only, part of Next #0 and the readings)

The text makes three claims that are built but not yet seen working on
the live server by themselves:

- "A backup is made every night": the scheduled 03:32 UTC run must appear
  in `/var/log/cozybistro-nightly.log` with a backup (Next #0). So far
  only a run started by hand has made one.
- "a copy is kept in a second place": the off-site push (03:40 UTC) must
  have carried a `cozybistro-*` file at least once.
- "trimmed automatically every night": the log must say "removed N old
  log piece(s)" once. That first happens around day 4 (`STATUS.md`,
  "Disk growth").

If one of them is not green on posting day, remove that claim or wait.

Already true today: own server, a backup restored successfully (23 Nov, on
the PC), the uptime check runs every 5 minutes, sign-up works on a fresh
database, and a saved login from the old server is never sent to the new
one (the saved token is stored per server address, `SpacetimeClient.ts`),
so testers simply land on the login screen.

## Patch 12 notes: two things to fix when posting

`docs/patch-notes-12.md` is posted right after the text above. It is not
changed by this draft. On posting day:

1. **It is too long for one Discord message** (2,649 characters, the limit
   is 2,000). Post it as two messages: the first one ends after the
   "🏆 Champions wear their medal" paragraph (1,517 characters), the
   second one starts at "⚖ Big fairness fixes" (about 1,130 characters).
2. **One line reads wrong after a full restart.** The fairness line says
   "Your restaurant will never silently reset again" and offers a refund
   to the two players whose restaurants the old bug ate. Right after
   "everyone starts from zero" that sounds odd, and the refund no longer
   means anything. Proposed replacement for that bullet:

   ```
   • Switching device or browser can no longer reset your restaurant. The season-reset marker moved from your browser to your ACCOUNT: new device, new browser, cleared cache, new domain, your restaurant follows you. (This bug ate two restaurants during beta.)
   ```

   Also bump the date in its first line (`12-08-2026`) to the posting day.
