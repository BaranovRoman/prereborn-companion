// One process/IPC/supervisor implementation, shared with installed workers.
pub use companion_plugin_protocol::runtime::*;
#[cfg(windows)] pub use companion_plugin_protocol::windows;
