// Shared host services. Keep game rules and legacy AppState out of this module.
pub(crate) mod obs_transport;
pub(crate) mod state;
pub(crate) mod plugin_runtime;
pub(crate) mod plugin_manager;
pub(crate) mod plugin_ipc;
pub(crate) mod plugin_read;
pub(crate) mod plugin_durable;
