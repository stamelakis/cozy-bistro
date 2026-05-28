//! Friend requests + friendship management + co-ownership.

use spacetimedb::{reducer, ReducerContext, Identity, Timestamp, Table};
use crate::tables::{
    friend_request, friendship, co_owner, restaurant, player,
    FriendRequest, Friendship, CoOwner,
};

/// Send a friend request to another Identity. Refuses self, dupes, and
/// already-friends.
#[reducer]
pub fn send_friend_request(ctx: &ReducerContext, target: Identity) -> Result<(), String> {
    if target == ctx.sender {
        return Err("Can't friend yourself".into());
    }
    if ctx.db.player().identity().find(target).is_none() {
        return Err("Target player not found".into());
    }
    if are_friends(ctx, ctx.sender, target) {
        return Err("Already friends".into());
    }
    // Any pending request either direction blocks duplicates.
    let existing = ctx.db.friend_request().from_player().filter(ctx.sender)
        .any(|r| r.to_player == target && r.status == "pending")
      || ctx.db.friend_request().from_player().filter(target)
        .any(|r| r.to_player == ctx.sender && r.status == "pending");
    if existing { return Err("Request already pending".into()); }
    ctx.db.friend_request().insert(FriendRequest {
        id: 0, // auto_inc
        from_player: ctx.sender,
        to_player: target,
        status: "pending".into(),
        created_at: ctx.timestamp,
        resolved_at: None,
    });
    Ok(())
}

/// Accept or decline a pending friend request. Only the recipient can.
#[reducer]
pub fn respond_friend_request(ctx: &ReducerContext, request_id: u64, accept: bool) -> Result<(), String> {
    let req = ctx.db.friend_request().id().find(request_id)
        .ok_or_else(|| "Request not found".to_string())?;
    if req.to_player != ctx.sender {
        return Err("Only the recipient can respond".into());
    }
    if req.status != "pending" {
        return Err("Request already resolved".into());
    }
    let new_status = if accept { "accepted" } else { "declined" };
    ctx.db.friend_request().id().update(FriendRequest {
        status: new_status.into(),
        resolved_at: Some(ctx.timestamp),
        ..req.clone()
    });
    if accept {
        let (a, b) = canonical_pair(req.from_player, req.to_player);
        ctx.db.friendship().insert(Friendship {
            id: 0, // auto_inc
            player_a: a,
            player_b: b,
            since: ctx.timestamp,
        });
    }
    Ok(())
}

/// Remove a friendship (caller can be either side).
#[reducer]
pub fn unfriend(ctx: &ReducerContext, other: Identity) -> Result<(), String> {
    let (a, b) = canonical_pair(ctx.sender, other);
    let row = ctx.db.friendship().player_a().filter(a)
        .find(|f| f.player_b == b);
    let row = row.ok_or_else(|| "Not friends".to_string())?;
    ctx.db.friendship().id().delete(row.id);
    Ok(())
}

/// Add a co-owner to a restaurant. Only the primary owner can invite.
/// The invitee must already be a friend.
#[reducer]
pub fn invite_co_owner(ctx: &ReducerContext, restaurant_id: u64, friend: Identity) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| "Restaurant not found".to_string())?;
    if r.owner != ctx.sender {
        return Err("Only the owner can invite co-owners".into());
    }
    if !are_friends(ctx, ctx.sender, friend) {
        return Err("Can only invite friends".into());
    }
    // Idempotent.
    let already = ctx.db.co_owner().restaurant_id().filter(restaurant_id)
        .any(|c| c.player == friend);
    if already { return Ok(()); }
    ctx.db.co_owner().insert(CoOwner {
        id: 0, // auto_inc
        restaurant_id,
        player: friend,
        invited_at: ctx.timestamp,
    });
    Ok(())
}

/// Remove a co-owner. Either the primary owner OR the co-owner themselves
/// can do this.
#[reducer]
pub fn remove_co_owner(ctx: &ReducerContext, restaurant_id: u64, player_to_remove: Identity) -> Result<(), String> {
    let r = ctx.db.restaurant().id().find(restaurant_id)
        .ok_or_else(|| "Restaurant not found".to_string())?;
    let allowed = r.owner == ctx.sender || player_to_remove == ctx.sender;
    if !allowed {
        return Err("Only the owner or the co-owner themselves can remove".into());
    }
    let row = ctx.db.co_owner().restaurant_id().filter(restaurant_id)
        .find(|c| c.player == player_to_remove);
    let row = row.ok_or_else(|| "Co-owner not found".to_string())?;
    ctx.db.co_owner().id().delete(row.id);
    Ok(())
}

// === Helpers ===

fn canonical_pair(a: Identity, b: Identity) -> (Identity, Identity) {
    // Lexicographic on raw bytes so each pair has exactly one ordering.
    if a.to_byte_array() < b.to_byte_array() { (a, b) } else { (b, a) }
}

fn are_friends(ctx: &ReducerContext, a: Identity, b: Identity) -> bool {
    let (pa, pb) = canonical_pair(a, b);
    ctx.db.friendship().player_a().filter(pa).any(|f| f.player_b == pb)
}

// Silence the unused-Timestamp import warning if we end up never using it
// directly here.
const _: Option<Timestamp> = None;
