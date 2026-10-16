//! Native managed-audio entry points. Legacy ACK routing is removed with BuiltIn.
pub(crate) mod store;
pub(crate) mod host;
pub(crate) mod assets;
pub(crate) use host::HostAudio;
use companion_plugin_protocol::audio::{Token,Status,Fence};
use tauri::Manager;
use std::sync::Arc;
#[tauri::command]
pub(crate) fn plugin_audio_fence_ack(window:tauri::WebviewWindow,request:Fence,stopped:bool)->Result<(),String>{
 if window.label()!="main"{return Err("plugin_audio_window_denied".into());}
 window.try_state::<Arc<HostAudio>>().ok_or("plugin_audio_unavailable")?.confirm(&request,stopped)
}

#[tauri::command]
pub(crate) fn plugin_audio_ack(
    window: tauri::WebviewWindow,
    token: Token,
    status: Status,
) -> Result<(), String> {
    if window.label()!="main"{return Err("plugin_audio_window_denied".into());}
    if let Some(audio)=window.try_state::<Arc<HostAudio>>().filter(|a|a.owns(&token)){return audio.ack(token,status);}
    Err("playback_scope_mismatch".into())
}
