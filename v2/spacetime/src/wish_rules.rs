//! Special guest requests ("wishes") — THE RULES, with no database in them.
//!
//! Plan: docs/decisions/guest-requests.md (approved 2026-11-23).
//!
//! Two wishes:
//!   ⚡ hurry    — offered when a guest sits down. The owner taps the badge
//!                (a promise), then the first plate must land within
//!                HURRY_WINDOW. Pays HURRY_REWARD when the plate lands in
//!                time. A broken promise costs nothing.
//!   🎂 birthday — offered while a guest is eating. The owner taps within
//!                TAP_WINDOW. Pays BIRTHDAY_REWARD at once.
//!
//! Everything in this file is a pure function of plain values (no
//! ReducerContext, no tables, no clock): the callers in restaurant_sim.rs
//! read the rows, ask these functions what to do, and write the answer
//! back. That is what lets `cargo test` check the money rules on a PC
//! without a server. KEEP IT THAT WAY: no `spacetimedb` import here.
//!
//! The ceiling ("no more than $60 a game day") comes from ONE rule: every
//! payment stamps the restaurant's last-wish time, and no wish is offered
//! until PAUSE_MIN after that stamp. So two payments are always at least
//! PAUSE_MIN apart: 720 s / 120 s = at most 6 payments a game day, and the
//! biggest payment is $10.

// ── Numbers (all the tuning lives here) ─────────────────────────────────

/// `active_guest.wish_kind`
pub const KIND_NONE: u8 = 0;
pub const KIND_HURRY: u8 = 1;
pub const KIND_BIRTHDAY: u8 = 2;

/// `active_guest.wish_state`
pub const STATE_NONE: u8 = 0;
/// Badge is showing; waiting for the owner's tap.
pub const STATE_OFFERED: u8 = 1;
/// Hurry only: the owner promised; waiting for the first plate.
pub const STATE_PROMISED: u8 = 2;
/// Reward paid.
pub const STATE_GRANTED: u8 = 3;
/// Not answered in time, plate too late, or the guest left.
pub const STATE_MISSED: u8 = 4;

const SECOND: i64 = 1_000_000; // micros

/// How long a badge waits for the tap.
pub const TAP_WINDOW_MICROS: i64 = 20 * SECOND;
/// Hurry: tap → first plate on the table. 45 s is the plan's starting
/// guess; the build measures a normal kitchen on a local server.
pub const HURRY_WINDOW_MICROS: i64 = 45 * SECOND;
/// Pause after every wish (offered, answered, missed), 2 to 4 minutes.
pub const PAUSE_MIN_MICROS: i64 = 120 * SECOND;
pub const PAUSE_MAX_MICROS: i64 = 240 * SECOND;

pub const HURRY_REWARD_CENTS: i64 = 1_000; // $10
pub const BIRTHDAY_REWARD_CENTS: i64 = 600; // $6
/// Added to the guest's total_satisfaction_x100 when a wish is granted
/// (≈ a quarter of a star on a two-course visit).
pub const SATISFACTION_BONUS_X100: i32 = 500;

/// A wish is offered only to a guest who JUST sat down / JUST started
/// eating (state clock at most this). Eating lasts 30 s, so a birthday
/// offered this early always leaves the full tap window.
pub const OFFER_FRESH_MS: i64 = 5_000;
/// Of the guests who qualify, this share gets the wish (hash roll per
/// guest, so the same guest always rolls the same).
pub const OFFER_CHANCE_PCT: u64 = 50;

/// One game day, for the ceiling maths and the tests.
pub const GAME_DAY_MICROS: i64 = 720 * SECOND;

// ── What the rules need to know ─────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Seated,
    Ordering,
    WaitingForFood,
    Eating,
    /// On the way out (any leaving variant).
    Leaving,
    /// Walking in, overflow chair, bathroom trip, unknown.
    Other,
}

pub fn phase_of(state: &str) -> Phase {
    match state {
        "seated" => Phase::Seated,
        "ordering" => Phase::Ordering,
        "waitingForFood" => Phase::WaitingForFood,
        "eating" => Phase::Eating,
        "leaving" | "done" | "walkingToDoor" | "exitingDoor" | "walkingOut" => Phase::Leaving,
        _ => Phase::Other,
    }
}

/// One guest, as the wish rules see it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct GuestView {
    pub id: u64,
    pub phase: Phase,
    pub state_clock_ms: i64,
    pub is_critic: bool,
    pub at_bar: bool,
    /// Still on the first course (order_index == 0).
    pub first_course: bool,
    /// Will still leave the seat for the toilet / sink before ordering.
    pub wc_trip_pending: bool,
    /// A plate for this guest is on the table ("delivered" ticket).
    pub plate_landed: bool,
    pub wish_kind: u8,
    pub wish_state: u8,
    pub wish_deadline_micros: i64,
}

/// The restaurant, as the wish rules see it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct HouseView {
    pub restaurant_id: u64,
    /// Owner seen in the last 30 s.
    pub owner_online: bool,
    pub open: bool,
    pub has_waiter: bool,
    pub has_chef: bool,
    pub has_barman: bool,
    /// Time of the last wish event (offer, payment, miss). 0 = never.
    pub last_wish_micros: i64,
}

/// New values for a guest's three wish columns.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct WishWrite {
    pub guest_id: u64,
    pub kind: u8,
    pub state: u8,
    pub deadline_micros: i64,
}

/// A granted wish: money for the restaurant, a nicer rating and (for a
/// regular) one loyalty heart for the guest.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Grant {
    pub guest_id: u64,
    pub reward_cents: i64,
}

/// What one sim tick must write.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct TickPlan {
    pub writes: Vec<WishWrite>,
    pub grants: Vec<Grant>,
    /// Some(t) = stamp the restaurant's last_wish_micros with t.
    pub stamp_micros: Option<i64>,
}

/// What the owner's tap must write.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tap {
    /// Only the owner's tap counts.
    NotOwner,
    /// Stale: no open wish, second tap, too late, guest not in the right
    /// place any more. Pays nothing, writes nothing.
    Ignore,
    /// Hurry accepted: the clock for the first plate starts.
    Promise(WishWrite),
    /// Birthday granted: pay at once.
    Pay(WishWrite, Grant),
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// splitmix64 finalizer — the same mixer the spawner uses. No rng: the
/// result depends only on the input, so a re-run gives the same answer.
fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The pause after the wish event stamped at `last_wish_micros`: a whole
/// number of seconds from PAUSE_MIN to PAUSE_MAX, fixed for that stamp.
pub fn pause_micros(restaurant_id: u64, last_wish_micros: i64) -> i64 {
    let span_s = ((PAUSE_MAX_MICROS - PAUSE_MIN_MICROS) / SECOND) as u64 + 1;
    let h = mix(restaurant_id ^ (last_wish_micros as u64).rotate_left(17));
    PAUSE_MIN_MICROS + (h % span_s) as i64 * SECOND
}

/// The per-guest roll, 0..=99.
pub fn offer_roll(guest_id: u64, kind: u8) -> u64 {
    mix(guest_id.wrapping_mul(31).wrapping_add(kind as u64)) % 100
}

fn is_open(state: u8) -> bool {
    state == STATE_OFFERED || state == STATE_PROMISED
}

/// Staffing rule: somebody must be able to serve this guest. An active
/// waiter AND an active chef, or an active barman for a guest at the bar.
pub fn can_be_served(house: &HouseView, at_bar: bool) -> bool {
    if at_bar { house.has_barman } else { house.has_waiter && house.has_chef }
}

fn pause_over(house: &HouseView, now: i64) -> bool {
    house.last_wish_micros == 0
        || now - house.last_wish_micros >= pause_micros(house.restaurant_id, house.last_wish_micros)
}

/// Which wish this guest could get right now, judged by where the guest
/// is in the visit. `fresh_only` = the normal rule (just sat down / just
/// started eating); the admin test trigger passes false.
fn kind_for(g: &GuestView, fresh_only: bool) -> u8 {
    let fresh = !fresh_only || g.state_clock_ms <= OFFER_FRESH_MS;
    match g.phase {
        Phase::Seated if g.first_course && !g.wc_trip_pending && !g.plate_landed && fresh => KIND_HURRY,
        Phase::Ordering | Phase::WaitingForFood
            if !fresh_only && g.first_course && !g.plate_landed => KIND_HURRY,
        Phase::Eating if fresh => KIND_BIRTHDAY,
        _ => KIND_NONE,
    }
}

// ── The three decisions ─────────────────────────────────────────────────

/// Does THIS guest get a wish now? `wish_open` = some guest in the
/// restaurant already has an open wish.
pub fn offer(house: &HouseView, wish_open: bool, g: &GuestView, now: i64) -> Option<WishWrite> {
    if !house.owner_online || !house.open || wish_open || !pause_over(house, now) {
        return None;
    }
    if g.is_critic || g.wish_kind != KIND_NONE || !can_be_served(house, g.at_bar) {
        return None;
    }
    let kind = kind_for(g, true);
    if kind == KIND_NONE || offer_roll(g.id, kind) >= OFFER_CHANCE_PCT {
        return None;
    }
    Some(WishWrite { guest_id: g.id, kind, state: STATE_OFFERED, deadline_micros: now + TAP_WINDOW_MICROS })
}

/// Admin test trigger: the same safety rules (one wish at a time, one per
/// guest, never the critic, staff present, right place in the visit) but
/// no pause, no roll, no "just sat down" window.
pub fn force_offer(house: &HouseView, wish_open: bool, g: &GuestView, kind: u8, now: i64) -> Option<WishWrite> {
    if wish_open || g.is_critic || g.wish_kind != KIND_NONE || !can_be_served(house, g.at_bar) {
        return None;
    }
    if kind == KIND_NONE || kind_for(g, false) != kind {
        return None;
    }
    Some(WishWrite { guest_id: g.id, kind, state: STATE_OFFERED, deadline_micros: now + TAP_WINDOW_MICROS })
}

/// One open wish, one tick later: keep waiting, close it, or pay.
fn step(g: &GuestView, now: i64) -> (Option<WishWrite>, Option<Grant>) {
    let close = WishWrite { guest_id: g.id, kind: g.wish_kind, state: STATE_MISSED, deadline_micros: 0 };
    let keep = (None, None);
    let missed = (Some(close), None);
    let late = now > g.wish_deadline_micros;
    match (g.wish_state, g.wish_kind) {
        (STATE_OFFERED, KIND_BIRTHDAY) => {
            if late || g.phase != Phase::Eating { missed } else { keep }
        }
        (STATE_OFFERED, KIND_HURRY) => {
            // Still before the first plate? Otherwise there is nothing
            // left to promise.
            let before_food = matches!(g.phase, Phase::Seated | Phase::Ordering | Phase::WaitingForFood)
                && g.first_course && !g.plate_landed;
            if late || !before_food { missed } else { keep }
        }
        (STATE_PROMISED, KIND_HURRY) => {
            let landed = g.plate_landed || g.phase == Phase::Eating;
            if landed && !late {
                let done = WishWrite { state: STATE_GRANTED, ..close };
                (Some(done), Some(Grant { guest_id: g.id, reward_cents: HURRY_REWARD_CENTS }))
            } else if late || landed
                || !matches!(g.phase, Phase::Seated | Phase::Ordering | Phase::WaitingForFood) {
                missed
            } else {
                keep
            }
        }
        // An open state with a kind that cannot have it: clean it up.
        _ => missed,
    }
}

/// Everything one sim tick does about wishes in one restaurant: settle
/// the open wish (if any), else maybe offer a new one. Guests are looked
/// at in the order given; the caller passes them sorted by id.
pub fn plan_tick(house: &HouseView, guests: &[GuestView], now: i64) -> TickPlan {
    let mut plan = TickPlan::default();
    let mut still_open = false;
    for g in guests.iter().filter(|g| is_open(g.wish_state)) {
        let (write, grant) = step(g, now);
        match write {
            None => still_open = true,
            Some(w) => {
                plan.writes.push(w);
                plan.stamp_micros = Some(now);
            }
        }
        if let Some(gr) = grant {
            plan.grants.push(gr);
        }
    }
    if still_open || plan.stamp_micros.is_some() {
        // A wish is open, or one just ended (its pause starts now).
        return plan;
    }
    for g in guests {
        if let Some(w) = offer(house, false, g, now) {
            plan.writes.push(w);
            plan.stamp_micros = Some(now);
            break;
        }
    }
    plan
}

/// The owner tapped this guest's badge.
pub fn tap(is_owner: bool, g: &GuestView, now: i64) -> Tap {
    if !is_owner {
        return Tap::NotOwner;
    }
    if g.wish_state != STATE_OFFERED || now > g.wish_deadline_micros {
        return Tap::Ignore;
    }
    match g.wish_kind {
        KIND_BIRTHDAY if g.phase == Phase::Eating => Tap::Pay(
            WishWrite { guest_id: g.id, kind: KIND_BIRTHDAY, state: STATE_GRANTED, deadline_micros: 0 },
            Grant { guest_id: g.id, reward_cents: BIRTHDAY_REWARD_CENTS },
        ),
        KIND_HURRY
            if matches!(g.phase, Phase::Seated | Phase::Ordering | Phase::WaitingForFood)
                && g.first_course && !g.plate_landed =>
        {
            Tap::Promise(WishWrite {
                guest_id: g.id,
                kind: KIND_HURRY,
                state: STATE_PROMISED,
                deadline_micros: now + HURRY_WINDOW_MICROS,
            })
        }
        _ => Tap::Ignore,
    }
}

// The tests: src/wish_rules_tests.rs, run by the rules-tests crate
// (`npm run test:server` in v2/). The explicit path keeps the file in
// the same place for both crates that compile this module.
#[cfg(test)]
#[path = "wish_rules_tests.rs"]
mod tests;
