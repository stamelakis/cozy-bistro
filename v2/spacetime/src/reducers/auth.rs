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
use crate::tables::{auth_record, password_reset_request, AuthRecord, PasswordResetRequest};

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
