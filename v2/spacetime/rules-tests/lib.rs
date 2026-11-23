//! Compiles the module's pure rule files for the PC so `cargo test` can
//! run their tests. See Cargo.toml next to this file.
//!
//! To add another rule file: write it in ../src/ with no `spacetimedb`
//! import, put its tests in ../src/<name>_tests.rs, and add one line here.

#[path = "../src/wish_rules.rs"]
pub mod wish_rules;
