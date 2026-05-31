//! Authentication reducers — sign up, log in, and password-reset
//! support flow. Wraps the existing per-Identity Player row with a
//! username + password layer so a player can move between browsers
//! while keeping their account.
//!
//! Stored in a SEPARATE `auth_record` table keyed by username, with
//! a `identity` field pointing to the Player that currently "owns"
//! the account on this server. Logging in from a new browser
//! updates `auth_record.identity` to the new sender; the old
//! Identity loses its claim.
//!
//! Password hashing: per-user 16-byte salt → SHA-256 of (salt ||
//! password) → stored as "{salt_hex}${hash_hex}". Verification
//! uses constant-time comparison via `subtle`.
//!
//! Admin bootstrap: the FIRST player to sign up with username
//! "Dunnin" (case-insensitive) is marked `is_admin = true`.
//! Subsequent attempts to take that username fail.

use spacetimedb::{reducer, ReducerContext, Table};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use rand::RngCore;
use crate::tables::{
    auth_record, ban_record, building, password_reset_request, player_save,
    restaurant, save_snapshot, co_owner, leaderboard_entry, achievement_unlock,
    AuthRecord, BanRecord, PasswordResetRequest,
};

const ADMIN_USERNAME: &str = "dunnin"; // lowercased — usernames are stored lowercased

const USERNAME_MIN_LEN: usize = 3;
const USERNAME_MAX_LEN: usize = 20;
const PASSWORD_MIN_LEN: usize = 6;
const PASSWORD_MAX_LEN: usize = 64;
const RESET_MESSAGE_MAX_LEN: usize = 500;

/// Sign up a new account. Validates inputs, ensures the username is
/// unique (case-insensitive), hashes the password, and creates an
/// `auth_record` row pointing at the current sender Identity.
///
/// Rejects when the sender's identity is already linked to a
/// different account (call logout/re-login flow instead).
///
/// First-account admin bootstrap: the first successful sign_up
/// with username "Dunnin" gets `is_admin = true`.
#[reducer]
pub fn sign_up(ctx: &ReducerContext, username: String, password: String) -> Result<(), String> {
    let identity = ctx.sender;
    let username_lc = validate_username(&username)?;
    validate_password(&password)?;

    if ctx.db.auth_record().username().find(&username_lc).is_some() {
        return Err("Username already taken".into());
    }

    // Don't let an identity claim multiple accounts.
    for existing in ctx.db.auth_record().identity().filter(identity) {
        return Err(format!("This session is already signed in as '{}' — log out first", existing.display_name));
    }

    let hash = hash_password(ctx, &password);
    let is_admin = username_lc == ADMIN_USERNAME;

    ctx.db.auth_record().insert(AuthRecord {
        username: username_lc.clone(),
        identity,
        display_name: username.trim().to_string(),
        password_hash: hash,
        is_admin,
        created_at: ctx.timestamp,
    });
    if is_admin {
        log::info!("Admin account bootstrapped: {}", username.trim());
    } else {
        log::info!("Sign up: {}", username.trim());
    }
    Ok(())
}

/// Log in with username + password. On success, the auth_record's
/// `identity` is updated to the current sender — transferring the
/// account to whatever browser the player is using now.
#[reducer]
pub fn login(ctx: &ReducerContext, username: String, password: String) -> Result<(), String> {
    let identity = ctx.sender;
    let username_lc = validate_username(&username)?;
    validate_password(&password)?;

    let account = ctx.db.auth_record().username().find(&username_lc)
        .ok_or_else(|| "No account with that username".to_string())?;
    if !verify_password(&password, &account.password_hash) {
        return Err("Wrong password".into());
    }

    // Banned-account check — same shape as the password verify path
    // (clear error string, no side effects) so a banned player gets
    // told once and the auth_record.identity is NOT moved over. Reason
    // is included if the admin left one so the player has something
    // concrete to ask about when they email the admin.
    if let Some(ban) = ctx.db.ban_record().username().find(&username_lc) {
        let reason_part = if ban.reason.is_empty() { String::new() }
            else { format!(" — reason: {}", ban.reason) };
        return Err(format!("This account has been banned{reason_part}"));
    }

    // Already logged in as the SAME account on this identity → no-op.
    if account.identity == identity {
        return Ok(());
    }

    // If our current identity is already signed in as a DIFFERENT
    // account, refuse — explicit logout required to avoid orphaning.
    for existing in ctx.db.auth_record().identity().filter(identity) {
        if existing.username != username_lc {
            return Err(format!("This session is already signed in as '{}' — log out first", existing.display_name));
        }
    }

    // Move the identity claim onto the new sender.
    ctx.db.auth_record().username().update(AuthRecord {
        identity,
        ..account
    });
    Ok(())
}

/// Log out — releases the current identity's claim by setting the
/// auth_record back to a sentinel "unowned" identity. The account
/// row itself is preserved; the player can log in again later.
#[reducer]
pub fn logout(ctx: &ReducerContext) -> Result<(), String> {
    let identity = ctx.sender;
    // Use the first non-zero auth_record this identity owns.
    let owned = ctx.db.auth_record().identity().filter(identity).next()
        .ok_or_else(|| "Not signed in on this session".to_string())?;
    // Set the account's identity field to the zero Identity. Future
    // logins will pick it up again with a valid password.
    let zero_identity = spacetimedb::Identity::__dummy();
    ctx.db.auth_record().username().update(AuthRecord {
        identity: zero_identity,
        ..owned
    });
    Ok(())
}

/// Create a password-reset request for the admin (Dunnin) to action.
/// Anyone can call this, authenticated or not — typical flow is a
/// "forgot password" link from the login modal.
#[reducer]
pub fn request_password_reset(ctx: &ReducerContext, username: String, message: String) -> Result<(), String> {
    let username_lc = username.trim().to_lowercase();
    if username_lc.is_empty() || username_lc.len() > USERNAME_MAX_LEN {
        return Err(format!("Username must be 1-{} characters", USERNAME_MAX_LEN));
    }
    let msg_trimmed = message.trim();
    let truncated_msg = if msg_trimmed.len() > RESET_MESSAGE_MAX_LEN {
        msg_trimmed[..RESET_MESSAGE_MAX_LEN].to_string()
    } else {
        msg_trimmed.to_string()
    };

    ctx.db.password_reset_request().insert(PasswordResetRequest {
        id: 0,
        username: username_lc,
        message: truncated_msg,
        status: "pending".to_string(),
        created_at: ctx.timestamp,
        resolved_at: None,
    });
    log::info!("Password reset requested for: {}", username.trim());
    Ok(())
}

/// Admin-only — sets a new password hash for a target account. Used
/// by Dunnin to resolve a forgot-password ticket: pick a temporary
/// password, set it via this reducer, then DM it to the player.
#[reducer]
pub fn admin_reset_password(ctx: &ReducerContext, target_username: String, new_password: String, request_id: u64) -> Result<(), String> {
    let caller_is_admin = ctx.db.auth_record().identity().filter(ctx.sender)
        .any(|a| a.is_admin);
    if !caller_is_admin {
        return Err("Admin only".into());
    }
    let username_lc = target_username.trim().to_lowercase();
    if username_lc.is_empty() {
        return Err("Target username required".into());
    }
    validate_password(&new_password)?;

    let account = ctx.db.auth_record().username().find(&username_lc)
        .ok_or_else(|| "No account with that username".to_string())?;
    let new_hash = hash_password(ctx, &new_password);
    ctx.db.auth_record().username().update(AuthRecord {
        password_hash: new_hash,
        ..account
    });

    // Mark the reset request resolved (no-op if request_id = 0 or
    // not found — caller can pass 0 for ad-hoc resets).
    if request_id > 0 {
        if let Some(req) = ctx.db.password_reset_request().id().find(request_id) {
            ctx.db.password_reset_request().id().update(PasswordResetRequest {
                status: "resolved".to_string(),
                resolved_at: Some(ctx.timestamp),
                ..req
            });
        }
    }
    log::info!("Admin reset password for: {}", target_username.trim());
    Ok(())
}

// ============================================================================
//                              ADMIN ACTIONS
// ============================================================================

/// Admin-only — ban a player by username. Inserts a `ban_record` row;
/// `login` consults this table and rejects banned accounts with a
/// reason-bearing error. Also drops the banned account's claim on
/// any building (so the plot returns to the unowned pool and another
/// player can take it) — that's safer than leaving a "haunted" plot
/// behind that nobody can use.
///
/// Does NOT delete the auth_record (so unban is non-destructive) and
/// does NOT delete the player_save (so the admin can review what was
/// there before deciding to wipe via `admin_delete_restaurant`).
///
/// `reason` is shown to the player on login + listed in the admin
/// panel. Empty string is fine; the login message just omits the
/// " — reason: ..." tail.
#[reducer]
pub fn admin_ban_player(ctx: &ReducerContext, target_username: String, reason: String) -> Result<(), String> {
    let caller_is_admin = ctx.db.auth_record().identity().filter(ctx.sender)
        .any(|a| a.is_admin);
    if !caller_is_admin {
        return Err("Admin only".into());
    }
    let username_lc = target_username.trim().to_lowercase();
    if username_lc.is_empty() {
        return Err("Target username required".into());
    }
    let account = ctx.db.auth_record().username().find(&username_lc)
        .ok_or_else(|| "No account with that username".to_string())?;
    if account.is_admin {
        return Err("Cannot ban an admin account".into());
    }
    let trimmed_reason = reason.trim();
    let reason_str = if trimmed_reason.len() > 500 {
        trimmed_reason[..500].to_string()
    } else {
        trimmed_reason.to_string()
    };

    // Upsert — banning a second time updates the reason.
    if let Some(existing) = ctx.db.ban_record().username().find(&username_lc) {
        ctx.db.ban_record().username().update(BanRecord {
            reason: reason_str,
            banned_at: ctx.timestamp,
            banned_by: ctx.sender,
            ..existing
        });
    } else {
        ctx.db.ban_record().insert(BanRecord {
            username: username_lc.clone(),
            reason: reason_str,
            banned_at: ctx.timestamp,
            banned_by: ctx.sender,
        });
    }

    // Release any building the banned player owned so the plot goes
    // back to the unowned pool. We can't easily evict their current
    // session (SpacetimeDB doesn't expose a force-disconnect), but
    // by clearing the building claim we ensure they can't continue
    // playing on their plot — and the next login attempt will be
    // rejected by the ban_record check anyway.
    let owner_id = account.identity;
    let zero = spacetimedb::Identity::__dummy();
    if owner_id != zero {
        for b in ctx.db.building().owner_identity().filter(owner_id) {
            ctx.db.building().id().update(crate::tables::Building {
                owner_identity: zero,
                claimed_at: None,
                ..b
            });
        }
    }

    log::info!("Admin banned: {} (reason: {})", target_username.trim(),
        if reason.trim().is_empty() { "<none>" } else { reason.trim() });
    Ok(())
}

/// Admin-only — lift a ban by deleting the ban_record row. The
/// player's auth_record + saved data is untouched, so they can log
/// back in with their old password. Their building is NOT
/// auto-reclaimed (it was released into the pool when they were
/// banned and may have been taken by someone else in the meantime);
/// they'll go through the building picker on next login.
#[reducer]
pub fn admin_unban_player(ctx: &ReducerContext, target_username: String) -> Result<(), String> {
    let caller_is_admin = ctx.db.auth_record().identity().filter(ctx.sender)
        .any(|a| a.is_admin);
    if !caller_is_admin {
        return Err("Admin only".into());
    }
    let username_lc = target_username.trim().to_lowercase();
    if ctx.db.ban_record().username().find(&username_lc).is_none() {
        return Err("Account is not banned".into());
    }
    ctx.db.ban_record().username().delete(&username_lc);
    log::info!("Admin unbanned: {}", target_username.trim());
    Ok(())
}

/// Admin-only — wipe a player's restaurant save and release their
/// building back to the unowned pool. Leaves the auth_record intact
/// so the player can log in again and re-pick a plot (start fresh)
/// — that's the difference between this and admin_ban_player.
///
/// Cascades: deletes the player_save row, releases any owned
/// building, and clears achievement_unlock + leaderboard_entry rows
/// for the player (so a wiped account doesn't keep ghost scores).
/// The friend_request / friendship rows are LEFT — friendships are
/// a social signal that should survive a restaurant reset.
#[reducer]
pub fn admin_delete_restaurant(ctx: &ReducerContext, target_username: String) -> Result<(), String> {
    let caller_is_admin = ctx.db.auth_record().identity().filter(ctx.sender)
        .any(|a| a.is_admin);
    if !caller_is_admin {
        return Err("Admin only".into());
    }
    let username_lc = target_username.trim().to_lowercase();
    let account = ctx.db.auth_record().username().find(&username_lc)
        .ok_or_else(|| "No account with that username".to_string())?;
    let owner_id = account.identity;
    let zero = spacetimedb::Identity::__dummy();
    if owner_id == zero {
        return Err("Account is not currently linked to an identity (nothing to delete)".into());
    }

    // Release any building they own.
    for b in ctx.db.building().owner_identity().filter(owner_id) {
        ctx.db.building().id().update(crate::tables::Building {
            owner_identity: zero,
            claimed_at: None,
            ..b
        });
    }
    // Wipe their player_save.
    if ctx.db.player_save().identity().find(owner_id).is_some() {
        ctx.db.player_save().identity().delete(owner_id);
    }
    // Cascade legacy restaurant rows (table predates player_save).
    let owned_restaurants: Vec<u64> = ctx.db.restaurant().owner().filter(owner_id)
        .map(|r| r.id).collect();
    for rid in &owned_restaurants {
        if ctx.db.save_snapshot().restaurant_id().find(*rid).is_some() {
            ctx.db.save_snapshot().restaurant_id().delete(*rid);
        }
        for c in ctx.db.co_owner().restaurant_id().filter(*rid) {
            ctx.db.co_owner().id().delete(c.id);
        }
        ctx.db.restaurant().id().delete(*rid);
    }
    // Clear leaderboard + achievement rows so the wiped account
    // doesn't keep ghost scores.
    let stale_lb: Vec<u64> = ctx.db.leaderboard_entry().player().filter(owner_id)
        .map(|e| e.id).collect();
    for id in stale_lb { ctx.db.leaderboard_entry().id().delete(id); }
    let stale_ach: Vec<u64> = ctx.db.achievement_unlock().player().filter(owner_id)
        .map(|a| a.id).collect();
    for id in stale_ach { ctx.db.achievement_unlock().id().delete(id); }

    log::info!("Admin deleted restaurant for: {} (released {} buildings, {} restaurants)",
        target_username.trim(), 0, owned_restaurants.len());
    Ok(())
}

/// Self-service character wipe — releases the caller's building,
/// nukes their player_save, and clears their leaderboard /
/// achievement rows. Same cascade as admin_delete_restaurant but
/// keyed to ctx.sender so any player can wipe their OWN account
/// without admin privileges. Surfaced in the HUD's "Reset save"
/// button (visible to all players). Auth_record is preserved so
/// the player can keep their username + password after the wipe;
/// they just go back through the plot picker fresh.
#[reducer]
pub fn wipe_my_restaurant(ctx: &ReducerContext) -> Result<(), String> {
    let owner_id = ctx.sender;
    let zero = spacetimedb::Identity::__dummy();
    if owner_id == zero {
        return Err("No identity to wipe".into());
    }
    // Release any building they own.
    for b in ctx.db.building().owner_identity().filter(owner_id) {
        ctx.db.building().id().update(crate::tables::Building {
            owner_identity: zero,
            claimed_at: None,
            ..b
        });
    }
    // Wipe their player_save.
    if ctx.db.player_save().identity().find(owner_id).is_some() {
        ctx.db.player_save().identity().delete(owner_id);
    }
    // Cascade legacy restaurant rows.
    let owned_restaurants: Vec<u64> = ctx.db.restaurant().owner().filter(owner_id)
        .map(|r| r.id).collect();
    for rid in &owned_restaurants {
        if ctx.db.save_snapshot().restaurant_id().find(*rid).is_some() {
            ctx.db.save_snapshot().restaurant_id().delete(*rid);
        }
        for c in ctx.db.co_owner().restaurant_id().filter(*rid) {
            ctx.db.co_owner().id().delete(c.id);
        }
        ctx.db.restaurant().id().delete(*rid);
    }
    // Clear leaderboard + achievement rows.
    let stale_lb: Vec<u64> = ctx.db.leaderboard_entry().player().filter(owner_id)
        .map(|e| e.id).collect();
    for id in stale_lb { ctx.db.leaderboard_entry().id().delete(id); }
    let stale_ach: Vec<u64> = ctx.db.achievement_unlock().player().filter(owner_id)
        .map(|a| a.id).collect();
    for id in stale_ach { ctx.db.achievement_unlock().id().delete(id); }
    log::info!("Self-wipe by identity {}: released {} restaurants", owner_id, owned_restaurants.len());
    Ok(())
}

// ============================================================================
//                                HELPERS
// ============================================================================

fn validate_username(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.len() < USERNAME_MIN_LEN || trimmed.len() > USERNAME_MAX_LEN {
        return Err(format!("Username must be {}-{} characters", USERNAME_MIN_LEN, USERNAME_MAX_LEN));
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Username can only contain letters, numbers, _ and -".into());
    }
    Ok(trimmed.to_lowercase())
}

fn validate_password(raw: &str) -> Result<(), String> {
    if raw.len() < PASSWORD_MIN_LEN || raw.len() > PASSWORD_MAX_LEN {
        return Err(format!("Password must be {}-{} characters", PASSWORD_MIN_LEN, PASSWORD_MAX_LEN));
    }
    Ok(())
}

fn hash_password(ctx: &ReducerContext, password: &str) -> String {
    let mut salt = [0u8; 16];
    ctx.rng().fill_bytes(&mut salt);
    let mut hasher = Sha256::new();
    hasher.update(&salt);
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();
    format!("{}${}", hex::encode(salt), hex::encode(digest))
}

fn verify_password(password: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    let salt_hex = match parts.next() { Some(s) => s, None => return false };
    let expected_hex = match parts.next() { Some(s) => s, None => return false };
    if parts.next().is_some() { return false; }
    let salt = match hex::decode(salt_hex) { Ok(b) => b, Err(_) => return false };
    let mut hasher = Sha256::new();
    hasher.update(&salt);
    hasher.update(password.as_bytes());
    let computed_hex = hex::encode(hasher.finalize());
    // Constant-time compare so a timing attack can't extract the
    // expected hash character-by-character.
    computed_hex.as_bytes().ct_eq(expected_hex.as_bytes()).into()
}
