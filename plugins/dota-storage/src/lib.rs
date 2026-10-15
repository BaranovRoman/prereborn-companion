//! Actual Dota SQLite operations, owned by the installable plugin workspace.
//! No Tauri, HTTP, credentials, worker spawning or automatic migration.
pub mod local_runtime {
    pub mod detector;
    pub mod model;
    pub mod gsi;
    pub mod schema;
    pub mod store;
    pub mod sync;
    pub mod transaction_facade;
}
