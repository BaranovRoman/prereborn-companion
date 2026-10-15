// Shared host services. Keep game rules and legacy AppState out of this module.
pub(crate) mod obs_transport;
pub(crate) mod state;
pub(crate) mod plugin_runtime;
pub(crate) mod plugin_manager;
pub(crate) mod plugin_ipc;
pub(crate) mod plugin_audio;
pub(crate) mod plugin_read;
pub(crate) mod plugin_durable;
// Iteration 7 is deliberately executable only against test fixtures, never application data.
#[cfg(test)]
mod plugin_match_transactions;

pub(crate) mod dota_observer;

pub(crate) mod dota_live;
