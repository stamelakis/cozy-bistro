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
