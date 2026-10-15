//! Temporary Dota admission adapter around the generic playback registry.
use tauri::{AppHandle,Manager,Emitter};
use companion_dota_domain::ownership::Lease;
use std::time::Duration;
pub(crate) use companion_plugin_protocol::audio::{Scope,Token,Status,Fence};
#[derive(Default)]
pub(crate) struct AudioFence(companion_plugin_protocol::playback::PlaybackRegistry);
impl std::ops::Deref for AudioFence {type Target=companion_plugin_protocol::playback::PlaybackRegistry;fn deref(&self)->&Self::Target{&self.0}}
impl AudioFence {
 pub(crate) fn admit(&self,lease:Option<Lease>,session:Option<&str>)->Result<Token,String> {self.0.admit(lease.map(|l|l.epoch),session)}
 pub(crate) fn fence(&self,app:&AppHandle)->Result<(),String> {let request=self.begin()?;app.emit_to("main","game-audio-fence",request).map_err(|_|"frontend_audio_unavailable")?;self.wait(Duration::from_secs(2))}
}
pub(crate) fn builtin_token<R:tauri::Runtime>(app:&tauri::AppHandle<R>)->Result<Token,String> {
 let lease=app.try_state::<crate::core::dota_live::LiveDota>().and_then(|g|g.lease());
 let session=app.try_state::<crate::local_runtime::LocalRuntimeState>().and_then(|history|history.audio_session());
 app.state::<AudioFence>().admit(lease,session.as_deref())
}
#[tauri::command]
pub(crate) fn game_audio_ack(window:tauri::WebviewWindow,token:Token,status:Status)->Result<(),String> {
 if window.label()!="main"{return Err("game_audio_window_denied".into());}let fence=window.state::<AudioFence>();
 if let Some(key)=fence.durable_key(&token)? {
  // No IPC or frontend wait under history. Durable validation precedes releasing
  // the pending tracker, so a fence cannot erase an uncommitted terminal ACK.
  window.state::<crate::local_runtime::LocalRuntimeState>().with_transaction_adapter(|a,c|a.audio_ack(c,&key,&token,status))?;
  if status==Status::Unknown {let gate=window.state::<crate::core::dota_live::LiveDota>();if let Some(lease)=gate.lease().filter(|l|l.epoch==token.scope.epoch){gate.failed(lease,"effect_result_unknown");}}
 }
 fence.ack(token,status)
}
#[tauri::command]
pub(crate) fn game_audio_fence_ack(window:tauri::WebviewWindow,request:Fence,stopped:bool)->Result<(),String> {
 if window.label()!="main"{return Err("game_audio_window_denied".into());}window.state::<AudioFence>().confirm(&request,stopped)
}
