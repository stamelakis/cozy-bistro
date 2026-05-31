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
