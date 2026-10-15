//! Generic playback acknowledgement entry point. The current durable implementation
//! remains the compatibility adapter until its storage is owned by the worker.
#[tauri::command]
pub(crate) fn plugin_audio_ack(
    window: tauri::WebviewWindow,
    token: crate::game_sounds::audio_fence::Token,
    status: crate::game_sounds::audio_fence::Status,
) -> Result<(), String> {
    crate::game_sounds::audio_fence::game_audio_ack(window, token, status)
}
