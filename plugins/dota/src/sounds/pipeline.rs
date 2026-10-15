//! Worker-owned GSI → shared detector → actual user binding. No session gating.
//! Produces plans only; the authorized host transport owns playback and its ACK.
use super::{assets,config::{self,GameSoundSettings,ManagedSoundAsset},resolve_playback};
use companion_dota_domain::{contracts::{ReplayContext,ReplayInput,ReplayResult},events::GameSoundEvent,replay::Replay,projection::project};
use std::path::Path;

#[derive(Clone,Debug)]
pub struct SoundPlan {pub event_id:String,pub asset:ManagedSoundAsset,pub volume:u8}
pub struct FrameResult {pub analysis:ReplayResult,pub sounds:Vec<SoundPlan>}
#[derive(Default)]
pub struct Pipeline {replay:Replay}
impl Pipeline {
 pub fn reset(&mut self) {self.replay=Replay::default();}
 pub fn frame(&mut self,raw:&serde_json::Value,sequence:u64,time_ms:u64,context:ReplayContext,settings:&GameSoundSettings,sounds_dir:&Path)->Result<FrameResult,String> {
  let snapshot=project(raw).map_err(str::to_string)?;
  let analysis=self.replay.apply(ReplayInput{sequence,observed_at_ms:time_ms,snapshot,context,match_context:None})?;
  let events:Vec<_>=analysis.sound_signals.iter().map(|s|GameSoundEvent{kind:s.kind,id:s.id.clone()}).collect();
  let mut sounds=Vec::new();
  if settings.enabled {
   for (event_id,asset) in resolve_playback(&events,&settings.bindings,&settings.assets) {
    // A missing/unsafe file is an explicit diagnostic error, never a successful playback.
    assets::read_plugin_file_from(sounds_dir,asset)?;
    sounds.push(SoundPlan{event_id,asset:asset.clone(),volume:config::clamp_volume(settings.master_volume)});
   }
  }
  Ok(FrameResult{analysis,sounds})
 }
}
