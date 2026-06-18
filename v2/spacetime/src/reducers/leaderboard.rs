//! Leaderboard submissions. Called at end-of-day with the day's score.
//! Reads happen through the client subscription (top-N by category).

use spacetimedb::{reducer, ReducerContext, Table};
use crate::tables::{restaurant, leaderboard_entry, LeaderboardEntry};

const ALLOWED_CATEGORIES: &[&str] = &[
    "daily_revenue",
    "daily_served",
    "lifetime_served",
    "best_rating_day",
    "fastest_max_tier",
    "biggest_tip_meal",
];

#[reducer]
pub fn submit_leaderboard(
    ctx: &ReducerContext,
    restaurant_id: u64,
    category: String,
    score: i64,
    day_number: u32,
) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| format!("Restaurant {restaurant_id} not found"))?;
    if r.owner != ctx.sender {
        return Err("Only the owner can submit scores for this restaurant".into());
    }
    if !r.public {
        return Err("Restaurant must be public to publish leaderboard scores".into());
    }
    if !ALLOWED_CATEGORIES.contains(&category.as_str()) {
        return Err(format!("Unknown category: {category}"));
    }
    if score < 0 {
        return Err("Score must be non-negative".into());
    }
    // Anti-cheat — reject implausible scores so a modded client can't pin a
    // leaderboard with i64::MAX. These caps sit far above any legitimate day,
    // so real submissions are never rejected; they just kill the "submit a
    // huge number" exploit. (A tighter per-day clamp against the server's own
    // cloud_daily_* counters is possible if finer validation is ever wanted.
    // fastest_max_tier is a TIME — lower is better — so it has no upper cap.)
    let max_score: i64 = match category.as_str() {
        "daily_revenue" => 1_000_000_000,    // $10,000,000/day in cents
        "daily_served" => 100_000,           // servings in a single day
        "lifetime_served" => 1_000_000_000,  // lifetime servings
        "best_rating_day" => 1_000,          // rating ×100 (5.00 is the real max)
        "biggest_tip_meal" => 100_000_000,   // $1,000,000 tip in cents
        _ => i64::MAX,
    };
    if score > max_score {
        return Err(format!("Score {score} is implausibly high for {category}"));
    }
    ctx.db.leaderboard_entry().insert(LeaderboardEntry {
        id: 0, // auto_inc
        player: ctx.sender,
        restaurant_id,
        category,
        score,
        day_number,
        submitted_at: ctx.timestamp,
    });
    Ok(())
}
