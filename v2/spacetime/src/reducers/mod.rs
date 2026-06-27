//! Reducers — the only way clients can mutate the database.
//!
//! Each `#[reducer]` becomes an RPC the TypeScript client can call.
//! The macros also generate type-safe call helpers in the bindings.

mod lifecycle;
mod auth;
mod buildings;
mod restaurants;
mod achievements;
mod leaderboard;
mod friends;
mod pedestrians;
mod chat;
mod weather;
mod restaurant_sim;
// Pass 1 (additive): server-side nav-grid + A* pathfinder port. Self-
// contained and unwired — exposes no reducers, so it's a plain `mod`
// (no glob re-export). Pass 3 will call into it via
// `crate::reducers::pathfinding::*`.
mod pathfinding;

pub use lifecycle::*;
pub use auth::*;
pub use buildings::*;
pub use restaurants::*;
pub use achievements::*;
pub use leaderboard::*;
pub use friends::*;
pub use pedestrians::*;
pub use chat::*;
pub use weather::*;
pub use restaurant_sim::*;
