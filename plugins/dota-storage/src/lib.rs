//! Actual Dota SQLite operations, owned by the installable plugin workspace.
//! No Tauri, HTTP, credentials, worker spawning or automatic migration.
pub mod local_runtime {
    pub mod host_execution;
    pub mod transaction_schema;
    pub mod transaction_authorization;
    #[cfg(test)] pub mod transaction_tests;
    pub mod detector;
    pub mod model;
    pub mod gsi;
    pub mod schema;
    pub mod store;
    pub mod sync;
    pub mod summary;
    pub mod transaction_facade;
}
