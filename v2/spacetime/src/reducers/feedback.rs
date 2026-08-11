//! Beta feedback — the in-game "💬 Report / suggest" pipeline.
//! Players submit short categorized notes; admins read them in the
//! AdminModal inbox and resolve/delete. Rate-limited + size-capped so
//! it can't be spammed into a storage problem.

use spacetimedb::{reducer, ReducerContext, Table};
use crate::tables::{auth_record, feedback, Feedback};

const MAX_MESSAGE_LEN: usize = 500;
const MIN_INTERVAL_MICROS: i64 = 60 * 1_000_000; // one submission per minute
const MAX_OPEN_PER_IDENTITY: usize = 30;

#[reducer]
pub fn submit_feedback(ctx: &ReducerContext, category: String, message: String) -> Result<(), String> {
    let msg = message.trim();
    if msg.len() < 3 {
        return Err("Tell us a little more — a few words at least.".into());
    }
    if msg.len() > MAX_MESSAGE_LEN {
        return Err(format!("Keep it under {MAX_MESSAGE_LEN} characters."));
    }
    let cat = match category.as_str() {
        "bug" | "idea" | "other" => category,
        _ => "other".to_string(),
    };
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let mine: Vec<Feedback> = ctx.db.feedback().identity().filter(ctx.sender).collect();
    if let Some(latest) = mine.iter().map(|f| f.created_at.to_micros_since_unix_epoch()).max() {
        if now - latest < MIN_INTERVAL_MICROS {
            return Err("Easy there — one note per minute.".into());
        }
    }
    if mine.iter().filter(|f| !f.resolved).count() >= MAX_OPEN_PER_IDENTITY {
        return Err("You have a lot of open notes already — thank you! We'll get through them.".into());
    }
    let username = ctx.db.auth_record().identity().filter(ctx.sender)
        .next()
        .map(|a| if a.display_name.is_empty() { a.username } else { a.display_name })
        .unwrap_or_else(|| "anonymous".to_string());
    ctx.db.feedback().insert(Feedback {
        id: 0,
        identity: ctx.sender,
        username,
        category: cat,
        message: msg.to_string(),
        created_at: ctx.timestamp,
        resolved: false,
    });
    Ok(())
}

/// Admin — mark handled (keeps the row for the record) or delete outright.
#[reducer]
pub fn admin_resolve_feedback(ctx: &ReducerContext, id: u64, delete: bool) -> Result<(), String> {
    let is_admin = ctx.db.auth_record().identity().filter(ctx.sender).any(|a| a.is_admin);
    if !is_admin {
        return Err("Admin only".into());
    }
    let Some(f) = ctx.db.feedback().id().find(id) else { return Ok(()); };
    if delete {
        ctx.db.feedback().id().delete(id);
    } else {
        ctx.db.feedback().id().update(Feedback { resolved: true, ..f });
    }
    Ok(())
}
