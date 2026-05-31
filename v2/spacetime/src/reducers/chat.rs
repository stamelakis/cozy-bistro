//! P8 — global + private chat. Two send reducers + a periodic
//! cleanup tick that trims old rows.
//!
//! Rate limit: each sender is capped at 5 messages per 10 seconds.
//! That's friendly enough for active conversation but firewalls a
//! runaway client from flooding the table.
//!
//! Retention: messages older than 24 hours are dropped by the
//! cleanup tick. Global chat is kept at most 500 rows even within
//! the window (drop oldest). Per-pair PM chat is left to age out
//! naturally — most pairs send only a handful of messages each.

use spacetimedb::{reducer, ReducerContext, Identity, ScheduleAt, Table, TimeDuration};
use crate::tables::{
    auth_record, ban_record, chat_message, chat_cleanup_schedule,
    ChatMessage, ChatCleanupSchedule,
};

/// Max chars per message. Anything longer is server-truncated; the
/// client UI also limits the input field to the same number.
const MAX_TEXT_LEN: usize = 500;

/// Rate-limit window. A sender is allowed RATE_LIMIT_COUNT messages
/// in the last RATE_LIMIT_WINDOW_MICROS microseconds.
const RATE_LIMIT_WINDOW_MICROS: i64 = 10_000_000; // 10 s
const RATE_LIMIT_COUNT: usize = 5;

/// Retention: drop messages older than this from any channel.
const RETENTION_MICROS: i64 = 24 * 60 * 60 * 1_000_000; // 24 h

/// Global-channel cap: even within the retention window, keep at
/// most this many global messages — the oldest are deleted to make
/// room. Prevents a burst of activity from filling the table.
const GLOBAL_KEEP: usize = 500;

/// Send a message to the global channel. Rejects banned accounts +
/// rate-limited senders. Channel is hard-coded so a client can't
/// forge an admin announcement or a PM into the global feed.
#[reducer]
pub fn send_chat_global(ctx: &ReducerContext, text: String) -> Result<(), String> {
    let trimmed = validate_text(&text)?;
    enforce_sender_rules(ctx, ctx.sender)?;
    ctx.db.chat_message().insert(ChatMessage {
        id: 0, // auto_inc
        sender: ctx.sender,
        channel: "global".to_string(),
        text: trimmed,
        sent_at: ctx.timestamp,
    });
    Ok(())
}

/// Send a private message to `recipient`. The server computes the
/// canonical channel id from the (sender, recipient) pair so each
/// 1:1 conversation has one stable channel id regardless of who
/// kicked it off. Self-PM is silently ignored (returns Ok so the
/// client doesn't surface a confusing error if the user accidentally
/// targets themselves).
#[reducer]
pub fn send_chat_private(ctx: &ReducerContext, recipient: Identity, text: String) -> Result<(), String> {
    if recipient == ctx.sender {
        return Ok(());
    }
    let zero = Identity::__dummy();
    if recipient == zero {
        return Err("Invalid recipient".into());
    }
    let trimmed = validate_text(&text)?;
    enforce_sender_rules(ctx, ctx.sender)?;
    let channel = pm_channel_for(ctx.sender, recipient);
    ctx.db.chat_message().insert(ChatMessage {
        id: 0, // auto_inc
        sender: ctx.sender,
        channel,
        text: trimmed,
        sent_at: ctx.timestamp,
    });
    Ok(())
}

/// Public bootstrap — install the cleanup schedule row if missing.
/// init runs only once per database lifetime; this exists so the
/// schedule can be added after the initial init has already fired.
#[reducer]
pub fn bootstrap_chat_schedule(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.chat_cleanup_schedule().iter().next().is_some() {
        log::info!("Chat cleanup schedule already installed — skipping");
        return Ok(());
    }
    ctx.db.chat_cleanup_schedule().insert(ChatCleanupSchedule {
        id: 0,
        scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(5 * 60 * 1_000_000)),
    });
    log::info!("Chat cleanup schedule installed via bootstrap (every 5 min)");
    Ok(())
}

/// Periodic cleanup. Drops messages past the retention window, then
/// caps the global channel at GLOBAL_KEEP rows by dropping the
/// oldest. Cheap — runs every 5 minutes via the schedule row.
#[reducer]
pub fn chat_cleanup(ctx: &ReducerContext, _schedule: ChatCleanupSchedule) -> Result<(), String> {
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let cutoff = now_micros - RETENTION_MICROS;

    // Pass 1 — drop anything older than the retention cutoff.
    let stale: Vec<u64> = ctx.db.chat_message().iter()
        .filter(|m| m.sent_at.to_micros_since_unix_epoch() < cutoff)
        .map(|m| m.id)
        .collect();
    for id in stale { ctx.db.chat_message().id().delete(id); }

    // Pass 2 — cap the global channel at GLOBAL_KEEP rows. Sort
    // remaining by sent_at desc, drop the tail.
    let mut globals: Vec<(u64, i64)> = ctx.db.chat_message().iter()
        .filter(|m| m.channel == "global")
        .map(|m| (m.id, m.sent_at.to_micros_since_unix_epoch()))
        .collect();
    if globals.len() > GLOBAL_KEEP {
        globals.sort_by(|a, b| b.1.cmp(&a.1));
        for (id, _) in globals.iter().skip(GLOBAL_KEEP) {
            ctx.db.chat_message().id().delete(*id);
        }
    }
    Ok(())
}

// ============================================================================
//                                 HELPERS
// ============================================================================

fn validate_text(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Message can't be empty".into());
    }
    let truncated: String = if trimmed.chars().count() > MAX_TEXT_LEN {
        trimmed.chars().take(MAX_TEXT_LEN).collect()
    } else {
        trimmed.to_string()
    };
    Ok(truncated)
}

/// Refuse the send if the sender is banned OR has exceeded the
/// rate-limit window. The banned check piggy-backs on the same
/// table that login consults, so a banned player whose tab is
/// still open can't keep spamming.
fn enforce_sender_rules(ctx: &ReducerContext, sender: Identity) -> Result<(), String> {
    // Banned-account check. Walk the sender's auth_record row to
    // find their username, then look up ban_record by that key.
    if let Some(account) = ctx.db.auth_record().identity().filter(sender).next() {
        if ctx.db.ban_record().username().find(&account.username).is_some() {
            return Err("This account has been banned".into());
        }
    }
    // Rate-limit — count this sender's messages in the recent window.
    let cutoff = ctx.timestamp.to_micros_since_unix_epoch() - RATE_LIMIT_WINDOW_MICROS;
    let recent = ctx.db.chat_message().sender().filter(sender)
        .filter(|m| m.sent_at.to_micros_since_unix_epoch() >= cutoff)
        .count();
    if recent >= RATE_LIMIT_COUNT {
        return Err("You're sending too fast — wait a moment".into());
    }
    Ok(())
}

/// Build a canonical "pm:<a>|<b>" channel id from a pair of
/// Identities, where a < b lexicographically on their hex strings.
/// Stable for both directions so a single PM tab maps to one channel
/// regardless of who initiated.
fn pm_channel_for(a: Identity, b: Identity) -> String {
    let ah = a.to_hex().to_string();
    let bh = b.to_hex().to_string();
    let (first, second) = if ah <= bh { (ah, bh) } else { (bh, ah) };
    format!("pm:{}|{}", first, second)
}
