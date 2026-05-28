//! Cozy Bistro 3D — SpacetimeDB module.
//!
//! Hosts cloud saves, leaderboards, achievement progress, friends, and
//! co-owned restaurants. The TypeScript client at v2/src/cloud/
//! talks to this module over WebSocket (auto-generated bindings).
//!
//! ## Identity model
//!
//! Every player is identified by their SpacetimeDB `Identity` (a stable
//! per-browser key). A row in `player` is created on first connect.
//!
//! ## Restaurants
//!
//! A `restaurant` row has one owner Identity. Co-owners (future phase)
//! are tracked separately. The latest save snapshot is kept in
//! `save_snapshot` — one row per restaurant, updated in place.

mod tables;
mod reducers;

// Re-export everything so SpacetimeDB's macros can find the symbols.
pub use tables::*;
pub use reducers::*;
