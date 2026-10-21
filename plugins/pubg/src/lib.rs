//! PUBG match history plugin (WK-183). The host performs every network call;
//! this process only plans one bounded backend read at a time, keeps the
//! history and serves the optional OBS widget on loopback.
pub mod files;
pub mod history;
pub mod overlay;
pub mod settings;
pub mod worker;

pub const PLUGIN_ID: &str = "pubg";
