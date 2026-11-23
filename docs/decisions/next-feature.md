# Next feature: A, B, C or D?

Written 2026-11-23 as prep for the "pick one" item in `STATUS.md`. No game
code was changed for this page.

**How sure this page is.** The four ideas were only ever written down as one
line in `STATUS.md`; the August chats where they came up are gone. What each
idea "is" below is my reading of its name plus what the game has today. If
you meant something else by one of them, say so and I redo that part.
Effort is counted in work sessions (one session = one task from start to a
checked result). None of the four costs money or needs a new service.

| | What the player gets | Effort | Risk | Server change |
|---|---|---|---|---|
| **A** Button grouping | A tidier bar, nothing new to do | Small, 1 session | Low | No |
| **B** Edge-docked layout | Panels live on the screen edges, the restaurant stays uncovered | Large, 3–5 sessions | Medium to high | No |
| **C** Special guest requests | Something new to do during service | Medium, 2–3 sessions | Medium | Yes |
| **D** First seasonal event | A limited-time event for the whole street | Small version 2, full 4–6 sessions | Medium to high, fixed date | Yes |

**Recommendation: C.** Reasons at the end.

## A. Button grouping

- **What it is.** On PC the top bar has 6 big buttons and, under them, about
  12 small ones in one unbroken row (Chat, Players, Social, Trends,
  Analytics, Ledger, Awards, Expand, Settings, Help, Feedback). Grouping
  puts the small ones into three or four named clusters with a gap between
  them, for example People / Numbers / Progress / Game. On the phone the
  same clusters become headings in the button drawer.
- **For a player.** Finding a button gets a little faster, most of all for a
  new player. Nothing new to play with.
- **Effort.** Small. On PC it is one short file (`CommandDock.ts`); the phone
  drawer is three button rows in `Hud.ts`.
- **Risk.** Low. The phone layout is fragile, and I cannot log in on a phone,
  so you would check that part yourself. Undo: easy, it is only the page.
- **Note.** This idea is older than the August top bar, which already split
  the buttons into big and small. And the testers have not yet said what
  they think of that bar (Next "tester feedback"). Grouping now means
  rearranging it before hearing them.

## B. Edge-docked layout

- **What it is.** Today Build, Recipe Menu, Chat and Players open as
  dropdowns under the top bar and can be dragged anywhere. Edge-docked means
  each panel has a fixed home on a screen edge (for example Build on the
  right, Chat bottom left), snaps there, the game view shrinks so a panel
  never covers the restaurant, and the game remembers the arrangement.
- **For a player.** A PC player who keeps panels open all the time gets a
  calmer screen. Phone players get nothing; the phone keeps its own layout.
- **Effort.** Large. It touches every standing panel, the top bar and the
  drag code, and must leave the phone layout exactly as it is.
- **Risk.** Medium to high. The PC layout was rebuilt five times on one day
  in August and the result, "one top bar, nothing floats", is a recorded
  decision in `CLAUDE.md`. This idea reverses part of it before any tester
  has reacted to it. Undo: possible (page only), but the work is lost.

## C. Special guest requests

- **What it is.** Now and then a guest arrives with a wish, shown as a small
  bubble: "I'm in a hurry", "It's my birthday", "Something special, please".
  The player answers it in time, by a tap or by serving fast, and gets a
  bigger tip, a rating nudge and, for a regular, a loyalty heart. Ignoring
  it costs nothing, the same rule as the critic visit.
- **For a player.** A new thing to do while the restaurant runs, and a reason
  to watch the guests instead of the menus. It is the only one of the four
  that adds play today.
- **Effort.** Medium. It builds on what is already there: the 8 guest types
  (VIP and critic included), named regulars, the greet / clear / stir tap
  badges and the bell. New: the wish itself on the server, its reward, the
  bubble, a help-guide entry, and tests because it pays money.
- **Risk.** Medium. It changes the server and pays out, so it needs
  automated tests and a publish to both databases (your OK at that point).
  It must not become free money (one wish at a time, a pause between
  wishes) and must respect the staffing rules (no wish when nobody can
  serve). Undo: it can be switched off; the new database fields stay.
- **To settle at the start.** Which two or three wishes go in the first
  version, and the reward sizes. I would propose them with a "done when"
  line before writing code.

## D. First seasonal event

- **What it is.** A themed event that runs for everyone at the same time and
  then ends. With today's date the obvious first one is winter / Christmas,
  about 15 December to 6 January. Small version: a winter look for the
  restaurant, snow more often, and one event goal whose reward is a keepsake
  that stays after the event. Full version adds two or three seasonal dishes
  and a goal the whole street works on together.
- **For a player.** A reason to come back on certain days, and a souvenir to
  show visitors. Strongest of the four when many players are active.
- **Effort.** 2 sessions for the small version, 4–6 for the full one. It
  builds on the street-wide event system (which has one event today, the
  critic visit), the weather (snow exists), the 14 decor themes and the
  daily goals.
- **Risk.** Medium to high. The date does not move: finished late is
  wasted. Everyone restarted from zero on 23 November, so the event must be
  reachable with a first-floor restaurant. The server is in its first weeks
  and still being watched. In the code "season" already means the reset
  cycle, so the event must stay well clear of that. And it has to end
  cleanly without leaving half an event behind. Undo: the event simply
  ends; the keepsakes stay.
- **Note.** You marked this one "saved for later" in August.

## Recommendation

**C, special guest requests.**

1. It is the only one that gives players something new to do, and the
   testers are about to come back to an empty restaurant. A small new
   pleasure in service helps that return more than a tidier bar.
2. It reuses a lot that already works, so the effort is known.
3. A and B rearrange a bar the testers have not judged yet. A is cheap, so
   it fits best as part of the feedback tuning once reactions are in. B
   should wait until the feedback says the layout is the problem.
4. D depends on the calendar. If you want a Christmas event, pick D now and
   take the small version: decide by 1 December, or it cannot be tested in
   time. Otherwise the first event is better aimed at spring, with more
   players and a quieter server.

Whichever you pick, nothing reaches the testers before the server readings
and the Discord post (Next #0 and #1), and a server publish for C or D
needs your OK when it is ready.
