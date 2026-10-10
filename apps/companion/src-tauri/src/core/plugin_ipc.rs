//! Tauri 2.11.5 desktop IPC bootstrap with one early subframe guard.
//! Keep serialization/fallback identical to upstream; review these copies on Tauri upgrades.
pub fn initialization_script() -> String {
    include_str!("plugin_ipc/ipc-protocol.js")
        .replace("__TEMPLATE_invoke_key__", "__INVOKE_KEY__")
        .replace("__RAW_process_ipc_message_fn__", include_str!("plugin_ipc/process-ipc-message-fn.js"))
        .replace("__TEMPLATE_os_name__", &serde_json::to_string(std::env::consts::OS).unwrap())
        .replace("__TEMPLATE_fetch_channel_data_command__", "\"plugin:__TAURI_CHANNEL__|fetch\"")
}
