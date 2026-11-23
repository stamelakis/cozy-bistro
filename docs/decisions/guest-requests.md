# Special guest requests: the plan for the first version

**Decided 2026-11-23: Andreas said "yes, as written".** Two wishes, fixed
rewards ($6 and $10), a broken hurry promise costs nothing. Publishing to
staging and live still needs his OK when the build is ready.

Written 2026-11-23 as prep for the build (Next "Build special guest
requests" in `STATUS.md`). No game code was changed for this page. The
numbers come from the code as it is today; where I could not measure
something, the page says so.

**Your answer: "yes" or "change X".** The three choices that are really
yours are at the end, each with what I recommend.

## What the player sees

Every two to four minutes one guest gets a wish, shown as a small round
badge over their head (the same kind as the 👋 greet badge). The player
answers it with a tap. A wish nobody answers simply goes away after 20
seconds: nothing is lost, the same rule as the critic visit.

| | ⚡ "I'm in a hurry" | 🎂 "It's my birthday" |
|---|---|---|
| Appears | When the guest sits down | While the guest is eating |
| The player | Taps the badge (a promise), then gets the first plate to the table within **45 seconds**. Stirring the pot (🥄) is the way to speed it up. | Taps the badge within 20 seconds |
| Reward | **+$10**, paid when the plate lands | **+$6**, paid at once |
| Also | That guest rates about a quarter of a star higher; a named regular gets one extra loyalty heart | The same |
| Missed | Plate too late: no reward, nothing else happens | Badge fades |

The two are different on purpose: the birthday is a quick, friendly tap;
the hurry is a small challenge the player can lose.

## Why these reward sizes

What the game pays today, for comparison:

- A normal tip is a share of the bill: nothing at 1–2★, 5% at 3★, 15% at
  4★, 30% at 5★. On a $50 bill that is $0, $2.50, $7.50 or $15.
- A dish brings only $3 to $7 of profit; the rest of its price is
  ingredients.
- A tip heart pays $5 and comes every 9 to 18 seconds: up to about $200
  in one game day (12 minutes) for a player who catches them all.
- The three daily goals pay $40, $60 and $100.

So $6 is a little more than a tip heart, and $10 is a good 4★ tip, for
something that happens far less often. With at most 6 wishes in a game
day the ceiling is **$60 a game day**, and a typical attentive player
gets about $25: a treat, clearly below tip hearts and daily goals.

## What keeps it from being free money

1. **Only for a player who is there.** A wish appears only while the
   owner is in the game, and only the owner's tap answers it. A closed
   tab earns nothing from wishes.
2. **One wish at a time** in a restaurant, and one per guest.
3. **A pause of 2 to 4 minutes** after every wish, answered or not. That
   pause alone gives the ceiling of 6 a game day.
4. **The server decides everything**: who gets a wish, whether the tap
   was in time, and the amount. The page only sends "I tapped this
   guest". A second tap, a late tap or a tap by a visitor pays nothing.
   This is the pattern the tip heart and the recycling already use.
5. **Real service only.** The birthday pays only for a guest who is
   eating; the hurry only when a plate really reached the table.
6. The Food Critic never has a wish; the critic visit stays its own event.

## The staffing rules

- A wish appears only when someone can serve that guest: an active
  waiter and an active chef, or an active barman for a guest at the bar.
  No staff, no wishes.
- A wish never creates an order, uses ingredients or buys anything. It
  cannot spend the player's money, so it cannot bring back the "empty
  restaurant keeps buying groceries" problem.
- It does not change the order or the dish reservations, the most
  fragile part of the server.

## What is not sure yet

- **The 45 seconds.** I cannot measure how long a first plate really
  takes until the build runs on a local server. The build measures it
  and sets the time so that a normal kitchen makes it about half the
  time without help and most of the time with a stir.
- **The project has no automated tests today.** The build starts by
  setting them up; that is part of its 2 to 3 sessions.

## Your three choices

1. **Two wishes or three?** Recommended: **two**. A third, "Something
   special, please" (the player recommends a dish), means changing the
   guest's order, which touches the dish reservations. About one more
   session and the riskiest part of the feature. Better as the next
   addition once the first two run; adding a wish later is cheap.
2. **Fixed sums or a share of the bill?** Recommended: **fixed** ($6 and
   $10). Easy to understand, easy to test, the ceiling is known. A share
   of the bill would grow with a big restaurant but its ceiling is hard
   to predict. Either way it is one number, changeable later.
3. **Does a broken "hurry" promise cost something?** Recommended:
   **no**. A penalty makes players stop tapping. The alternative is a
   small rating loss for that guest.

Cost: no money, no new service. Undo: wishes can be switched off on the
server; the new database fields stay, unused.

## For the build session

- Server (`restaurant_sim.rs`, `tables.rs`): new fields appended last
  with defaults: on the guest the wish kind, its state and its deadline;
  on the restaurant the time of the last wish. The sim tick offers a
  wish (hash roll, no rng) when a guest enters "seated" (hurry) or
  "eating" (birthday), if: owner seen in the last 30 s, restaurant open,
  no open wish, pause over, `has_active_role` true for the roles above,
  guest type not `critic`. The tick also grants the hurry when the
  guest's first ticket is "delivered" before the deadline.
- One reducer, `answer_guest_wish(guest_id)`, in the claim pattern of
  `CLAUDE.md`: owner gate, silent `Ok(())` on every stale case, effect
  and stamp in one update, `record_money_event` with kind "wish". The
  rating nudge goes through `total_satisfaction_x100` (+500), the way
  `greet_guest` does. The loyalty heart is +1 on the regular's row.
- An admin trigger to force a wish, like `admin_spawn_vip`.
- Page: one more `TapBadges` layer (hidden while visiting), a "+$" pop,
  the "wish" line in the Ledger, a Help entry.

## Done when (the build)

Both wishes can be granted and missed on a local server, and the reward
shows in the wallet and the Ledger. Automated tests pass for: a granted
birthday and a granted hurry; a second tap, a late tap, a guest who
leaves, a second wish while one is open, a wish during the pause; a tap
by a non-owner, no wish without waiter or chef, none for an absent
owner, none for the critic; and a simulated game day that pays no more
than $60. The client builds (`tsc`), the badge works on PC and phone.
Then, with Andreas's OK: published to staging and live, a health check
after, and Andreas has granted one wish of each kind in the live game
(I cannot log in there).
