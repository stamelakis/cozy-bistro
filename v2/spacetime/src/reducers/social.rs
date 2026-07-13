//! Two-way visits: emoji reactions + a signed guestbook on a restaurant.
//! Left by visitors, read (and moderated) by the owner.

use spacetimedb::{reducer, ReducerContext, Identity, Table};
use crate::tables::{visit_reaction, guestbook_entry, VisitReaction, GuestbookEntry};

/// Allowed reaction emoji. All single code points (no variation selectors) so
/// the client and server literals compare exactly. Keep in sync with the client
/// REACTIONS set in VisitMode.
const ALLOWED_REACTIONS: [&str; 4] = ["👍", "💖", "🔥", "😋"];
const GUESTBOOK_MAX_LEN: usize = 200;
const NAME_MAX_LEN: usize = 32;

/// Toggle / replace the caller's emoji reaction on a restaurant. The same emoji
/// again removes it; a different emoji replaces it. Rejects self-reactions and
/// unknown emoji.
#[reducer]
pub fn react_to_restaurant(ctx: &ReducerContext, target_owner: Identity, emoji: String) -> Result<(), String> {
    if target_owner == ctx.sender {
        return Err("Can't react to your own restaurant".into());
    }
    if !ALLOWED_REACTIONS.contains(&emoji.as_str()) {
        return Err("Unknown reaction".into());
    }
    let existing = ctx.db.visit_reaction().reactor().filter(ctx.sender)
        .find(|r| r.target_owner == target_owner);
    match existing {
        Some(r) if r.emoji == emoji => {
            ctx.db.visit_reaction().id().delete(r.id); // same emoji → toggle off
        }
        Some(r) => {
            ctx.db.visit_reaction().id().update(VisitReaction {
                emoji, created_at: ctx.timestamp, ..r
            });
        }
        None => {
            ctx.db.visit_reaction().insert(VisitReaction {
                id: 0, // auto_inc
                target_owner,
                reactor: ctx.sender,
                emoji,
                created_at: ctx.timestamp,
            });
        }
    }
    Ok(())
}

/// Sign (or re-sign) a restaurant's guestbook. One note per author per
/// restaurant — re-signing updates it; an empty message removes it. Message +
/// name are trimmed and length-capped (char-safe).
#[reducer]
pub fn sign_guestbook(ctx: &ReducerContext, target_owner: Identity, message: String, author_name: String) -> Result<(), String> {
    if target_owner == ctx.sender {
        return Err("Can't sign your own guestbook".into());
    }
    let msg: String = message.trim().chars().take(GUESTBOOK_MAX_LEN).collect();
    let name: String = author_name.trim().chars().take(NAME_MAX_LEN).collect();
    let existing = ctx.db.guestbook_entry().author().filter(ctx.sender)
        .find(|e| e.target_owner == target_owner);
    if msg.is_empty() {
        if let Some(e) = existing { ctx.db.guestbook_entry().id().delete(e.id); }
        return Ok(());
    }
    match existing {
        Some(e) => {
            ctx.db.guestbook_entry().id().update(GuestbookEntry {
                message: msg, author_name: name, created_at: ctx.timestamp, ..e
            });
        }
        None => {
            ctx.db.guestbook_entry().insert(GuestbookEntry {
                id: 0, // auto_inc
                target_owner,
                author: ctx.sender,
                author_name: name,
                message: msg,
                created_at: ctx.timestamp,
            });
        }
    }
    Ok(())
}

/// Delete a guestbook entry. Either the restaurant owner (moderation) OR the
/// note's author can remove it.
#[reducer]
pub fn delete_guestbook_entry(ctx: &ReducerContext, entry_id: u64) -> Result<(), String> {
    let e = ctx.db.guestbook_entry().id().find(entry_id)
        .ok_or_else(|| "Entry not found".to_string())?;
    if e.target_owner != ctx.sender && e.author != ctx.sender {
        return Err("Only the owner or author can delete this note".into());
    }
    ctx.db.guestbook_entry().id().delete(entry_id);
    Ok(())
}
