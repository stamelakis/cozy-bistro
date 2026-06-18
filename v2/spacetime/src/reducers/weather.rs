//! Server-side global weather. One row in `weather_state` (id=1)
//! that every client reads from. A scheduled `weather_roll` reducer
//! re-rolls the weather every ~8 real minutes; admin can force a
//! specific weather via `admin_set_weather` for previews.
//!
//! Same weighted table as the client's WEATHER_TYPES — kept here
//! verbatim so a player who logs in mid-rotation sees the
//! statistical distribution they'd expect.

use spacetimedb::{rand::Rng, reducer, ReducerContext, ScheduleAt, Table, TimeDuration};
use crate::tables::{auth_record, weather_state, weather_schedule, WeatherState, WeatherSchedule};

/// (kind id, selection weight). Sum is 100. Mirrors the client's
/// WEATHER_TYPES weight column.
const WEATHER_OPTIONS: &[(&str, u32)] = &[
    ("sunny",      35),
    ("cloudy",     25),
    ("rainy",      14),
    ("heavy-rain",  6),
    ("festival",    8),
    ("cold",        6),
    ("snowy",       6),
];

/// Scheduled — fires every ~8 real minutes via the weather_schedule
/// Interval row. Rolls a fresh weighted weather and upserts the
/// single weather_state row.
#[reducer]
pub fn weather_roll(ctx: &ReducerContext, _schedule: WeatherSchedule) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("weather_roll is scheduler-only".into());
    }
    let kind = pick_weighted(ctx);
    upsert_weather(ctx, kind);
    log::info!("weather_roll → {}", kind);
    Ok(())
}

/// Admin-only — force a specific weather kind. Used by AdminModal's
/// weather buttons to preview rain / snow / festival without
/// waiting for the next 8-min tick. Validates that the kind is in
/// our table so a typo doesn't strand the world in an unknown
/// state.
#[reducer]
pub fn admin_set_weather(ctx: &ReducerContext, kind: String) -> Result<(), String> {
    let is_admin = ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin);
    if !is_admin {
        return Err("Admin only".into());
    }
    if !WEATHER_OPTIONS.iter().any(|(id, _)| *id == kind) {
        return Err(format!("Unknown weather kind: {}", kind));
    }
    upsert_weather(ctx, &kind);
    log::info!("admin_set_weather → {}", kind);
    Ok(())
}

/// Public bootstrap — installs the weather_schedule + seeds the
/// first weather_state row if either is missing. Idempotent so it
/// can be called by hand after a deploy that adds the table
/// without re-publishing init.
#[reducer]
pub fn bootstrap_weather(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.weather_schedule().iter().next().is_none() {
        ctx.db.weather_schedule().insert(WeatherSchedule {
            id: 0,
            // 8 real minutes — short enough that the weather feels
            // dynamic during a single play session, long enough that
            // it doesn't feel like a slideshow.
            scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(8 * 60 * 1_000_000)),
        });
        log::info!("weather schedule installed (8 min interval)");
    }
    if ctx.db.weather_state().id().find(1u32).is_none() {
        let kind = pick_weighted(ctx);
        ctx.db.weather_state().insert(WeatherState {
            id: 1,
            kind: kind.to_string(),
            since: ctx.timestamp,
        });
        log::info!("weather_state seeded → {}", kind);
    }
    Ok(())
}

fn upsert_weather(ctx: &ReducerContext, kind: &str) {
    if let Some(existing) = ctx.db.weather_state().id().find(1u32) {
        ctx.db.weather_state().id().update(WeatherState {
            kind: kind.to_string(),
            since: ctx.timestamp,
            ..existing
        });
    } else {
        ctx.db.weather_state().insert(WeatherState {
            id: 1,
            kind: kind.to_string(),
            since: ctx.timestamp,
        });
    }
}

fn pick_weighted(ctx: &ReducerContext) -> &'static str {
    let mut rng = ctx.rng();
    let total: u32 = WEATHER_OPTIONS.iter().map(|(_, w)| *w).sum();
    let mut roll = rng.gen_range(0..total);
    for (id, w) in WEATHER_OPTIONS {
        if roll < *w { return id; }
        roll -= *w;
    }
    "sunny"
}
