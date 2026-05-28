//! Achievement unlocks. Client calls `unlock_achievement(id)` after
//! detecting the predicate locally; the server records it (idempotent).

use spacetimedb::{reducer, ReducerContext, Table};
use crate::tables::{achievement_unlock, AchievementUnlock};

#[reducer]
pub fn unlock_achievement(ctx: &ReducerContext, achievement_id: String) -> Result<(), String> {
    let trimmed = achievement_id.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("Invalid achievement id".into());
    }
    // Idempotent — skip if already unlocked.
    let already = ctx.db.achievement_unlock().player().filter(ctx.sender)
        .any(|a| a.achievement_id == trimmed);
    if already { return Ok(()); }
    ctx.db.achievement_unlock().insert(AchievementUnlock {
        id: 0, // auto_inc
        player: ctx.sender,
        achievement_id: trimmed.to_string(),
        unlocked_at: ctx.timestamp,
    });
    Ok(())
}
