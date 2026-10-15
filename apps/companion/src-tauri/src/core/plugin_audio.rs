//! Native managed-audio entry points. Legacy ACK routing is removed with BuiltIn.
pub(crate) mod store;
pub(crate) mod host;
pub(crate) use host::HostAudio;
use companion_plugin_protocol::audio::{Token,Status,Fence};
use tauri::Manager;
#[tauri::command]
pub(crate) fn plugin_audio_fence_ack(window:tauri::WebviewWindow,request:Fence,stopped:bool)->Result<(),String>{
 if window.label()!="main"{return Err("plugin_audio_window_denied".into());}
 window.try_state::<HostAudio>().ok_or("plugin_audio_unavailable")?.confirm(&request,stopped)
}

#[tauri::command]
pub(crate) fn plugin_audio_ack(
    window: tauri::WebviewWindow,
    token: Token,
    status: Status,
) -> Result<(), String> {
    if window.label()!="main"{return Err("plugin_audio_window_denied".into());}
    if let Some(audio)=window.try_state::<HostAudio>().filter(|a|a.owns(&token)){return audio.ack(token,status);}
    crate::game_sounds::audio_fence::game_audio_ack(window, token, status)
}
