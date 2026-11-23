//! Tests for the guest-wish rules (wish_rules.rs).
//! Run: `npm run test:server` in v2/ (see spacetime/rules-tests/Cargo.toml).
//!
//! `World` below is a restaurant in memory: it applies what the rules
//! answer exactly the way restaurant_sim.rs applies it to the database
//! (guest columns, wallet, ledger line, last-wish stamp).

use super::*;

const S: i64 = 1_000_000; // one second, in micros
const T0: i64 = 1_800_000_000 * S; // some moment in 2027

// ── Helpers ─────────────────────────────────────────────────────────────

fn house() -> HouseView {
    HouseView {
        restaurant_id: 7,
        owner_online: true,
        open: true,
        has_waiter: true,
        has_chef: true,
        has_barman: true,
        last_wish_micros: 0,
    }
}

fn guest(id: u64, phase: Phase) -> GuestView {
    GuestView {
        id,
        phase,
        state_clock_ms: 0,
        is_critic: false,
        at_bar: false,
        first_course: true,
        wc_trip_pending: false,
        plate_landed: false,
        wish_kind: KIND_NONE,
        wish_state: STATE_NONE,
        wish_deadline_micros: 0,
    }
}

/// First guest id at or after `from` whose roll wins (`lucky`) or loses.
fn id_with_roll(kind: u8, from: u64, lucky: bool) -> u64 {
    (from..from + 10_000)
        .find(|&id| (offer_roll(id, kind) < OFFER_CHANCE_PCT) == lucky)
        .expect("no such id in range")
}

fn lucky_seated(from: u64) -> GuestView {
    guest(id_with_roll(KIND_HURRY, from, true), Phase::Seated)
}

fn lucky_eating(from: u64) -> GuestView {
    guest(id_with_roll(KIND_BIRTHDAY, from, true), Phase::Eating)
}

struct World {
    house: HouseView,
    guests: Vec<GuestView>,
    wallet_cents: i64,
    /// (time, amount) — the "wish" lines of the Ledger.
    ledger: Vec<(i64, i64)>,
    /// Guests who got the rating nudge + loyalty heart.
    thanked: Vec<u64>,
}

impl World {
    fn new(guests: Vec<GuestView>) -> World {
        World { house: house(), guests, wallet_cents: 0, ledger: Vec::new(), thanked: Vec::new() }
    }

    fn g(&mut self, id: u64) -> &mut GuestView {
        self.guests.iter_mut().find(|g| g.id == id).expect("guest exists")
    }

    fn write(&mut self, w: WishWrite) {
        let g = self.g(w.guest_id);
        g.wish_kind = w.kind;
        g.wish_state = w.state;
        g.wish_deadline_micros = w.deadline_micros;
    }

    fn pay(&mut self, gr: Grant, now: i64) {
        self.wallet_cents += gr.reward_cents;
        self.ledger.push((now, gr.reward_cents));
        self.thanked.push(gr.guest_id);
    }

    /// One sim tick, as restaurant_tick does it.
    fn tick(&mut self, now: i64) {
        self.guests.sort_by_key(|g| g.id);
        let plan = plan_tick(&self.house, &self.guests, now);
        for w in plan.writes {
            self.write(w);
        }
        for gr in plan.grants {
            self.pay(gr, now);
        }
        if let Some(t) = plan.stamp_micros {
            self.house.last_wish_micros = t;
        }
    }

    /// The reducer answer_guest_wish.
    fn tap(&mut self, guest_id: u64, is_owner: bool, now: i64) -> Tap {
        let Some(g) = self.guests.iter().find(|g| g.id == guest_id).copied() else {
            return Tap::Ignore; // guest already gone
        };
        let answer = tap(is_owner, &g, now);
        match answer {
            Tap::NotOwner | Tap::Ignore => {}
            Tap::Promise(w) => self.write(w),
            Tap::Pay(w, gr) => {
                self.write(w);
                self.pay(gr, now);
                self.house.last_wish_micros = now;
            }
        }
        answer
    }

    fn open_wishes(&self) -> usize {
        self.guests
            .iter()
            .filter(|g| g.wish_state == STATE_OFFERED || g.wish_state == STATE_PROMISED)
            .count()
    }
}

/// A world with one birthday badge showing since T0.
fn birthday_offered() -> (World, u64) {
    let g = lucky_eating(100);
    let id = g.id;
    let mut w = World::new(vec![g]);
    w.tick(T0);
    assert_eq!(w.g(id).wish_kind, KIND_BIRTHDAY);
    assert_eq!(w.g(id).wish_state, STATE_OFFERED);
    (w, id)
}

/// A world with one hurry badge showing since T0.
fn hurry_offered() -> (World, u64) {
    let g = lucky_seated(100);
    let id = g.id;
    let mut w = World::new(vec![g]);
    w.tick(T0);
    assert_eq!(w.g(id).wish_kind, KIND_HURRY);
    assert_eq!(w.g(id).wish_state, STATE_OFFERED);
    (w, id)
}

// ── Granted ─────────────────────────────────────────────────────────────

#[test]
fn birthday_granted_pays_6_dollars_at_once() {
    let (mut w, id) = birthday_offered();
    assert_eq!(w.g(id).wish_deadline_micros, T0 + 20 * S);
    assert_eq!(w.house.last_wish_micros, T0, "the offer starts the pause");

    let answer = w.tap(id, true, T0 + 3 * S);
    assert!(matches!(answer, Tap::Pay(..)));
    assert_eq!(w.wallet_cents, 600);
    assert_eq!(w.ledger, vec![(T0 + 3 * S, 600)]);
    assert_eq!(w.thanked, vec![id], "rating nudge + loyalty heart");
    assert_eq!(w.g(id).wish_state, STATE_GRANTED);
    assert_eq!(w.house.last_wish_micros, T0 + 3 * S, "the payment restarts the pause");
}

#[test]
fn hurry_granted_pays_10_dollars_when_the_plate_lands_in_time() {
    let (mut w, id) = hurry_offered();

    // The tap is only a promise: no money yet.
    let answer = w.tap(id, true, T0 + 5 * S);
    assert!(matches!(answer, Tap::Promise(..)));
    assert_eq!(w.wallet_cents, 0);
    assert_eq!(w.g(id).wish_state, STATE_PROMISED);
    assert_eq!(w.g(id).wish_deadline_micros, T0 + 5 * S + 45 * S);

    // The guest orders and waits; nothing happens to the wish.
    w.g(id).phase = Phase::Ordering;
    w.tick(T0 + 10 * S);
    w.g(id).phase = Phase::WaitingForFood;
    w.tick(T0 + 30 * S);
    assert_eq!(w.g(id).wish_state, STATE_PROMISED);
    assert_eq!(w.wallet_cents, 0);

    // The plate lands 40 s after the tap.
    w.g(id).plate_landed = true;
    w.tick(T0 + 45 * S);
    assert_eq!(w.wallet_cents, 1_000);
    assert_eq!(w.ledger, vec![(T0 + 45 * S, 1_000)]);
    assert_eq!(w.thanked, vec![id]);
    assert_eq!(w.g(id).wish_state, STATE_GRANTED);
    assert_eq!(w.house.last_wish_micros, T0 + 45 * S);

    // Further ticks pay nothing more.
    w.g(id).phase = Phase::Eating;
    w.tick(T0 + 46 * S);
    w.tick(T0 + 47 * S);
    assert_eq!(w.wallet_cents, 1_000);
}

#[test]
fn hurry_is_granted_exactly_at_the_deadline() {
    let (mut w, id) = hurry_offered();
    w.tap(id, true, T0);
    w.g(id).phase = Phase::Eating; // the plate landed and the guest started
    w.tick(T0 + 45 * S);
    assert_eq!(w.wallet_cents, 1_000);
}

// ── Second tap, late tap ────────────────────────────────────────────────

#[test]
fn second_tap_pays_nothing() {
    let (mut w, id) = birthday_offered();
    w.tap(id, true, T0 + S);
    assert_eq!(w.tap(id, true, T0 + S), Tap::Ignore);
    assert_eq!(w.tap(id, true, T0 + 2 * S), Tap::Ignore);
    assert_eq!(w.wallet_cents, 600);
    assert_eq!(w.ledger.len(), 1);

    let (mut w, id) = hurry_offered();
    w.tap(id, true, T0 + S);
    // A second tap on a promise changes nothing, not even the deadline.
    assert_eq!(w.tap(id, true, T0 + 10 * S), Tap::Ignore);
    assert_eq!(w.g(id).wish_deadline_micros, T0 + S + 45 * S);
    w.g(id).plate_landed = true;
    w.tick(T0 + 20 * S);
    assert_eq!(w.tap(id, true, T0 + 21 * S), Tap::Ignore);
    assert_eq!(w.wallet_cents, 1_000);
    assert_eq!(w.ledger.len(), 1);
}

#[test]
fn late_tap_pays_nothing() {
    // Exactly at 20 s still counts...
    let (mut w, id) = birthday_offered();
    assert!(matches!(w.tap(id, true, T0 + 20 * S), Tap::Pay(..)));

    // ...one tick later does not, whether the sim noticed already or not.
    let (mut w, id) = birthday_offered();
    assert_eq!(w.tap(id, true, T0 + 20 * S + 1), Tap::Ignore);
    w.tick(T0 + 20 * S + S / 2);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    assert_eq!(w.tap(id, true, T0 + 21 * S), Tap::Ignore);
    assert_eq!(w.wallet_cents, 0);
    assert!(w.ledger.is_empty());

    let (mut w, id) = hurry_offered();
    assert_eq!(w.tap(id, true, T0 + 20 * S + 1), Tap::Ignore);
    w.tick(T0 + 21 * S);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    // The plate arriving later pays nothing: there was no promise.
    w.g(id).plate_landed = true;
    w.tick(T0 + 30 * S);
    assert_eq!(w.wallet_cents, 0);
}

#[test]
fn hurry_plate_too_late_pays_nothing_and_costs_nothing() {
    let (mut w, id) = hurry_offered();
    w.wallet_cents = 5_000;
    w.tap(id, true, T0);
    w.g(id).phase = Phase::WaitingForFood;
    w.tick(T0 + 44 * S);
    assert_eq!(w.g(id).wish_state, STATE_PROMISED);

    // 45.5 s: the promise is broken the moment the time is up.
    w.tick(T0 + 45 * S + S / 2);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);

    // The plate lands afterwards: still nothing.
    w.g(id).plate_landed = true;
    w.g(id).phase = Phase::Eating;
    w.tick(T0 + 50 * S);
    assert_eq!(w.wallet_cents, 5_000, "no reward and no penalty");
    assert!(w.ledger.is_empty());
    assert!(w.thanked.is_empty());
}

#[test]
fn hurry_plate_landing_in_the_same_tick_the_time_runs_out_is_too_late() {
    let (mut w, id) = hurry_offered();
    w.tap(id, true, T0);
    w.g(id).plate_landed = true;
    w.tick(T0 + 45 * S + 1);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    assert_eq!(w.wallet_cents, 0);
}

#[test]
fn hurry_badge_goes_away_if_the_plate_lands_before_the_tap() {
    let (mut w, id) = hurry_offered();
    w.g(id).plate_landed = true;
    assert_eq!(w.tap(id, true, T0 + 2 * S), Tap::Ignore, "nothing left to promise");
    w.tick(T0 + 3 * S);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    assert_eq!(w.wallet_cents, 0);
}

// ── A guest who leaves ──────────────────────────────────────────────────

#[test]
fn guest_who_leaves_takes_the_wish_along() {
    // Birthday badge, guest finishes and walks out before the tap.
    let (mut w, id) = birthday_offered();
    w.g(id).phase = Phase::Leaving;
    assert_eq!(w.tap(id, true, T0 + 2 * S), Tap::Ignore);
    w.tick(T0 + 3 * S);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    assert_eq!(w.house.last_wish_micros, T0 + 3 * S);
    assert_eq!(w.wallet_cents, 0);

    // Birthday badge, guest moves on to the next course before the tap.
    let (mut w, id) = birthday_offered();
    w.g(id).phase = Phase::WaitingForFood;
    assert_eq!(w.tap(id, true, T0 + 2 * S), Tap::Ignore);
    w.tick(T0 + 3 * S);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);

    // Hurry promised, guest loses patience and leaves.
    let (mut w, id) = hurry_offered();
    w.tap(id, true, T0 + S);
    w.g(id).phase = Phase::Leaving;
    w.tick(T0 + 10 * S);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    assert_eq!(w.wallet_cents, 0);

    // Hurry promised, the guest's row is already deleted: nothing to pay,
    // the tap finds nobody, and the pause still runs from the offer.
    let (mut w, id) = hurry_offered();
    w.tap(id, true, T0 + S);
    w.guests.clear();
    w.tick(T0 + 10 * S);
    assert_eq!(w.tap(id, true, T0 + 11 * S), Tap::Ignore);
    assert_eq!(w.wallet_cents, 0);
    let next = lucky_seated(500);
    let next_id = next.id;
    w.guests.push(next);
    w.tick(T0 + 119 * S);
    assert_eq!(w.g(next_id).wish_state, STATE_NONE, "still in the pause");
}

#[test]
fn owner_back_after_hours_gets_nothing_for_an_old_wish() {
    // The sim freezes while the owner is away; the wish is still "open"
    // in the database when they return.
    let (mut w, id) = hurry_offered();
    w.tap(id, true, T0 + S);
    w.g(id).plate_landed = true; // would have counted, 3 hours ago
    w.tick(T0 + 3 * 3600 * S);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    assert_eq!(w.wallet_cents, 0);
}

// ── One at a time, pause ────────────────────────────────────────────────

#[test]
fn no_second_wish_while_one_is_open() {
    let a = lucky_seated(100);
    let b = lucky_seated(a.id + 1);
    let c = lucky_eating(b.id + 1);
    let (a_id, b_id, c_id) = (a.id, b.id, c.id);
    let mut w = World::new(vec![c, b, a]);

    w.tick(T0);
    assert_eq!(w.open_wishes(), 1);
    assert_eq!(w.g(a_id).wish_state, STATE_OFFERED, "lowest id first");

    // Offered, then promised: the others never get one meanwhile.
    for step in 1..=10 {
        w.tick(T0 + step * S / 2);
        assert_eq!(w.open_wishes(), 1);
    }
    w.tap(a_id, true, T0 + 6 * S);
    for step in 13..=40 {
        w.tick(T0 + step * S / 2);
        assert_eq!(w.open_wishes(), 1);
    }
    assert_eq!(w.g(b_id).wish_kind, KIND_NONE);
    assert_eq!(w.g(c_id).wish_kind, KIND_NONE);
}

#[test]
fn no_wish_during_the_pause_and_one_right_after() {
    // The pause runs from the moment the last wish ended, however it ended.
    for ending in ["paid", "missed"] {
        let (mut w, id) = birthday_offered();
        let ended = T0 + 9 * S;
        match ending {
            "paid" => {
                w.tap(id, true, ended);
            }
            _ => {
                w.g(id).phase = Phase::Leaving;
                w.tick(ended);
            }
        }
        assert_eq!(w.house.last_wish_micros, ended, "{ending}");
        let pause = pause_micros(w.house.restaurant_id, ended);

        // A fresh, lucky guest every half second: none gets a wish...
        let mut next_id = 1_000;
        let mut t = ended + S / 2;
        while t < ended + pause {
            let g = lucky_seated(next_id);
            next_id = g.id + 1;
            w.guests = vec![g];
            w.tick(t);
            assert_eq!(w.open_wishes(), 0, "{ending}: wish {}s into the pause", (t - ended) / S);
            t += S / 2;
        }
        // ...until the pause is over.
        let g = lucky_seated(next_id);
        w.guests = vec![g];
        w.tick(ended + pause);
        assert_eq!(w.open_wishes(), 1, "{ending}: wish after the pause");
    }
}

#[test]
fn pause_is_between_2_and_4_minutes() {
    let mut seen = std::collections::BTreeSet::new();
    for rid in 1..=40u64 {
        for k in 0..200i64 {
            let p = pause_micros(rid, T0 + k * 7_919 * S + k);
            assert!((120 * S..=240 * S).contains(&p), "pause {p}");
            assert_eq!(p % S, 0, "whole seconds");
            seen.insert(p);
        }
    }
    assert!(seen.len() > 100, "pauses vary ({} different)", seen.len());
    assert!(*seen.iter().next().unwrap() < 130 * S);
    assert!(*seen.iter().last().unwrap() > 230 * S);
    // Same stamp, same pause (no rng).
    assert_eq!(pause_micros(7, T0), pause_micros(7, T0));
}

// ── Who can answer, who can get one ─────────────────────────────────────

#[test]
fn tap_by_a_non_owner_pays_nothing() {
    let (mut w, id) = birthday_offered();
    assert_eq!(w.tap(id, false, T0 + S), Tap::NotOwner);
    assert_eq!(w.wallet_cents, 0);
    assert_eq!(w.g(id).wish_state, STATE_OFFERED, "the badge stays for the owner");
    assert!(matches!(w.tap(id, true, T0 + 2 * S), Tap::Pay(..)));
    assert_eq!(w.wallet_cents, 600);

    let (mut w, id) = hurry_offered();
    assert_eq!(w.tap(id, false, T0 + S), Tap::NotOwner);
    assert_eq!(w.g(id).wish_state, STATE_OFFERED);
    // A visitor cannot answer a wish that is not even open, either.
    w.tap(id, true, T0 + 2 * S);
    assert_eq!(w.tap(id, false, T0 + 3 * S), Tap::NotOwner);
}

#[test]
fn no_wish_without_waiter_or_chef() {
    let cases: [(&str, fn(&mut HouseView)); 3] = [
        ("no waiter", |h| h.has_waiter = false),
        ("no chef", |h| h.has_chef = false),
        ("no waiter, no chef (a barman does not serve tables)", |h| {
            h.has_waiter = false;
            h.has_chef = false;
        }),
    ];
    for (name, break_it) in cases {
        for g in [lucky_seated(100), lucky_eating(100)] {
            let mut w = World::new(vec![g]);
            break_it(&mut w.house);
            for step in 0..20 {
                w.tick(T0 + step * S / 2);
            }
            assert_eq!(w.open_wishes(), 0, "{name}");
            assert_eq!(w.house.last_wish_micros, 0, "{name}");
        }
    }
}

#[test]
fn bar_guest_needs_a_barman() {
    let mut g = lucky_seated(100);
    g.at_bar = true;

    let mut w = World::new(vec![g]);
    w.house.has_barman = false;
    w.tick(T0);
    assert_eq!(w.open_wishes(), 0, "waiter + chef do not serve the bar");

    let mut w = World::new(vec![g]);
    w.house.has_waiter = false;
    w.house.has_chef = false;
    w.tick(T0);
    assert_eq!(w.open_wishes(), 1, "a barman alone serves the bar");
}

#[test]
fn no_wish_for_an_absent_owner() {
    let mut w = World::new(vec![lucky_seated(100), lucky_eating(100)]);
    w.house.owner_online = false;
    for step in 0..20 {
        w.tick(T0 + step * S / 2);
    }
    assert_eq!(w.open_wishes(), 0);
    assert_eq!(w.house.last_wish_micros, 0);
}

#[test]
fn no_wish_in_a_closed_restaurant() {
    let mut w = World::new(vec![lucky_seated(100), lucky_eating(100)]);
    w.house.open = false;
    w.tick(T0);
    assert_eq!(w.open_wishes(), 0);
}

#[test]
fn no_wish_for_the_critic() {
    for mut g in [lucky_seated(100), lucky_eating(100)] {
        g.is_critic = true;
        let mut w = World::new(vec![g]);
        for step in 0..20 {
            w.tick(T0 + step * S / 2);
        }
        assert_eq!(w.open_wishes(), 0);
        // Not even with the admin test trigger.
        for kind in [KIND_HURRY, KIND_BIRTHDAY] {
            assert_eq!(force_offer(&w.house, false, &g, kind, T0), None);
        }
    }
}

#[test]
fn one_wish_per_guest() {
    // Missed the hurry badge at the door; much later the same guest eats.
    let (mut w, id) = hurry_offered();
    w.tick(T0 + 21 * S);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    let g = w.g(id);
    g.phase = Phase::Eating;
    g.state_clock_ms = 0;
    for step in 0..10 {
        w.tick(T0 + 600 * S + step * S / 2);
    }
    assert_eq!(w.g(id).wish_kind, KIND_HURRY, "no birthday on top");
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    assert_eq!(force_offer(&w.house, false, &w.guests[0], KIND_BIRTHDAY, T0 + 700 * S), None);
}

#[test]
fn only_a_guest_who_just_sat_down_or_just_started_eating() {
    let fresh = lucky_seated(100);
    let cases: Vec<(&str, GuestView)> = vec![
        ("seated 6 s ago", GuestView { state_clock_ms: 6_000, ..fresh }),
        ("still going to the toilet first", GuestView { wc_trip_pending: true, ..fresh }),
        ("second course", GuestView { first_course: false, ..fresh }),
        ("walking in", GuestView { phase: Phase::Other, ..fresh }),
        ("ordering", GuestView { phase: Phase::Ordering, ..fresh }),
        ("waiting for food", GuestView { phase: Phase::WaitingForFood, ..fresh }),
        ("leaving", GuestView { phase: Phase::Leaving, ..fresh }),
        ("eating for 6 s", GuestView { state_clock_ms: 6_000, ..lucky_eating(100) }),
    ];
    for (name, g) in cases {
        assert_eq!(offer(&house(), false, &g, T0), None, "{name}");
    }
    assert!(offer(&house(), false, &fresh, T0).is_some());
    assert!(offer(&house(), false, &GuestView { state_clock_ms: 5_000, ..fresh }, T0).is_some());
}

#[test]
fn the_roll_gives_a_wish_to_about_half_the_guests() {
    for kind in [KIND_HURRY, KIND_BIRTHDAY] {
        let lucky = (1..=2_000u64).filter(|&id| offer_roll(id, kind) < OFFER_CHANCE_PCT).count();
        assert!((850..=1_150).contains(&lucky), "kind {kind}: {lucky} of 2000");
    }
    // An unlucky guest never gets one, however often the sim asks.
    let unlucky = guest(id_with_roll(KIND_HURRY, 100, false), Phase::Seated);
    let mut w = World::new(vec![unlucky]);
    for step in 0..10 {
        w.tick(T0 + step * S / 2);
    }
    assert_eq!(w.open_wishes(), 0);
}

// ── Admin test trigger ──────────────────────────────────────────────────

#[test]
fn admin_trigger_skips_pause_and_roll_but_not_the_safety_rules() {
    let mut h = house();
    h.last_wish_micros = T0 - S; // deep in the pause
    h.owner_online = false;
    let now = T0;

    // Works for an unlucky guest who sat down a while ago, mid-pause.
    let mut seated = guest(id_with_roll(KIND_HURRY, 100, false), Phase::Seated);
    seated.state_clock_ms = 3_500;
    let w = force_offer(&h, false, &seated, KIND_HURRY, now).expect("forced hurry");
    assert_eq!((w.kind, w.state, w.deadline_micros), (KIND_HURRY, STATE_OFFERED, now + 20 * S));
    let waiting = GuestView { phase: Phase::WaitingForFood, ..seated };
    assert!(force_offer(&h, false, &waiting, KIND_HURRY, now).is_some());
    let eating = guest(id_with_roll(KIND_BIRTHDAY, 100, false), Phase::Eating);
    assert!(force_offer(&h, false, &GuestView { state_clock_ms: 20_000, ..eating }, KIND_BIRTHDAY, now).is_some());

    // Still refused:
    assert_eq!(force_offer(&h, true, &seated, KIND_HURRY, now), None, "a wish is open");
    assert_eq!(force_offer(&h, false, &seated, KIND_BIRTHDAY, now), None, "not eating");
    assert_eq!(force_offer(&h, false, &eating, KIND_HURRY, now), None, "already eating");
    assert_eq!(force_offer(&h, false, &seated, KIND_NONE, now), None);
    assert_eq!(force_offer(&h, false, &seated, 9, now), None, "unknown kind");
    let served = GuestView { plate_landed: true, ..waiting };
    assert_eq!(force_offer(&h, false, &served, KIND_HURRY, now), None, "plate already there");
    let mut no_staff = h;
    no_staff.has_chef = false;
    assert_eq!(force_offer(&no_staff, false, &seated, KIND_HURRY, now), None, "no chef");
}

// ── The ceiling: no more than $60 a game day ────────────────────────────

/// The best case for a cheater: a fresh lucky guest of each kind every
/// half second, every badge tapped the instant it shows, every plate on
/// the table the instant it is promised. Returns the ledger.
fn greedy_days(restaurant_id: u64, start: i64, days: i64, hurry: bool, birthday: bool) -> Vec<(i64, i64)> {
    let mut w = World::new(Vec::new());
    w.house.restaurant_id = restaurant_id;
    let mut next_id = 1u64;
    let mut t = start;
    while t < start + days * GAME_DAY_MICROS {
        // Keep the guest with the open wish; replace everyone else.
        w.guests.retain(|g| g.wish_state == STATE_OFFERED || g.wish_state == STATE_PROMISED);
        if hurry {
            let g = lucky_seated(next_id);
            next_id = g.id + 1;
            w.guests.push(g);
        }
        if birthday {
            let g = lucky_eating(next_id);
            next_id = g.id + 1;
            w.guests.push(g);
        }
        w.tick(t);
        let open: Vec<u64> = w
            .guests
            .iter()
            .filter(|g| g.wish_state == STATE_OFFERED)
            .map(|g| g.id)
            .collect();
        for id in open {
            if let Tap::Promise(_) = w.tap(id, true, t) {
                w.g(id).plate_landed = true;
                w.tick(t); // the very same instant
            }
        }
        t += S / 2;
    }
    assert_eq!(w.wallet_cents, w.ledger.iter().map(|(_, c)| c).sum::<i64>());
    w.ledger
}

#[test]
fn a_simulated_game_day_pays_no_more_than_60_dollars() {
    for rid in 1..=25u64 {
        for (hurry, birthday) in [(true, false), (false, true), (true, true)] {
            let ledger = greedy_days(rid, T0 + rid as i64 * 977 * S, 1, hurry, birthday);
            let total: i64 = ledger.iter().map(|(_, c)| c).sum();
            assert!(total <= 6_000, "restaurant {rid}: ${} in one game day", total / 100);
            assert!(ledger.len() <= 6, "restaurant {rid}: {} wishes in one game day", ledger.len());
            assert!(total >= 1_800, "the greedy player should earn something (got {total})");
        }
    }
}

#[test]
fn no_12_minutes_ever_pay_more_than_60_dollars() {
    // Ten game days in a row; then look at EVERY 12-minute stretch, not
    // only the ones that start at a day boundary.
    for rid in [3u64, 11, 42] {
        let ledger = greedy_days(rid, T0, 10, true, true);
        assert!(ledger.len() >= 30, "enough payments to mean something ({})", ledger.len());
        for pair in ledger.windows(2) {
            let gap = pair[1].0 - pair[0].0;
            assert!(gap >= PAUSE_MIN_MICROS, "two payments only {}s apart", gap / S);
        }
        for (i, (from, _)) in ledger.iter().enumerate() {
            let paid: i64 = ledger[i..]
                .iter()
                .take_while(|(t, _)| *t < from + GAME_DAY_MICROS)
                .map(|(_, c)| c)
                .sum();
            assert!(paid <= 6_000, "${} within 12 minutes", paid / 100);
        }
    }
}

#[test]
fn the_ceiling_follows_from_the_numbers() {
    // Payments are at least PAUSE_MIN apart (checked above with real
    // runs), so a game day holds at most this many of them. If someone
    // changes a reward or the pause, this fails before the plan's
    // "$60 a game day" stops being true.
    let most_payments = (GAME_DAY_MICROS - 1) / PAUSE_MIN_MICROS + 1;
    let biggest = HURRY_REWARD_CENTS.max(BIRTHDAY_REWARD_CENTS);
    assert_eq!(most_payments, 6);
    assert!(most_payments * biggest <= 6_000);
    assert_eq!(HURRY_REWARD_CENTS, 1_000);
    assert_eq!(BIRTHDAY_REWARD_CENTS, 600);
    assert_eq!(TAP_WINDOW_MICROS, 20 * S);
    assert_eq!(GAME_DAY_MICROS, 720 * S);
}

// ── Small things ────────────────────────────────────────────────────────

#[test]
fn guest_states_map_to_phases() {
    assert_eq!(phase_of("seated"), Phase::Seated);
    assert_eq!(phase_of("ordering"), Phase::Ordering);
    assert_eq!(phase_of("waitingForFood"), Phase::WaitingForFood);
    assert_eq!(phase_of("eating"), Phase::Eating);
    for s in ["leaving", "done", "walkingToDoor", "exitingDoor", "walkingOut"] {
        assert_eq!(phase_of(s), Phase::Leaving, "{s}");
    }
    for s in ["walkingIn", "waiting", "waitingForSeat", "wcWalking", "wcSitting", "wcWashing", "", "atToilet"] {
        assert_eq!(phase_of(s), Phase::Other, "{s}");
    }
}

#[test]
fn a_broken_wish_row_is_cleaned_up_without_paying() {
    // "promised birthday" cannot happen; if a row ever looks like that,
    // the tick closes it instead of leaving the restaurant blocked.
    let mut g = lucky_eating(100);
    g.wish_kind = KIND_BIRTHDAY;
    g.wish_state = STATE_PROMISED;
    g.wish_deadline_micros = T0 + 100 * S;
    let id = g.id;
    let mut w = World::new(vec![g]);
    w.tick(T0);
    assert_eq!(w.g(id).wish_state, STATE_MISSED);
    assert_eq!(w.wallet_cents, 0);
}
