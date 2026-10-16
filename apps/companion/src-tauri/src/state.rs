//! Host account/connectivity state only. Installed workers own all game state.
use serde::Serialize;
use std::sync::Mutex;
use crate::core::{state::CoreState,obs_transport::ObsConfig};
// Debug builds use the local API; release installers use production HTTPS.
// backend/config/env.ts, тот же паттерн для STEAM_OPENID_REALM) - companion
// не даёт настроить этот URL из UI в этой итерации (см. отчёт по фиче), это
// единственное место, которое нужно поменять для другого окружения/домена.
#[cfg(debug_assertions)]
pub const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:3001/api";
#[cfg(not(debug_assertions))]
pub const DEFAULT_BACKEND_URL: &str = "https://prereborn.ru/api";
// Same environment split as DEFAULT_BACKEND_URL, but for the web dashboard
// (no /api suffix) - used to open the Twitch settings page for re-linking.
#[cfg(debug_assertions)]
pub const DEFAULT_WEB_ORIGIN: &str = "http://127.0.0.1:3000";
#[cfg(not(debug_assertions))]
pub const DEFAULT_WEB_ORIGIN: &str = "https://prereborn.ru";
pub const COMPANION_VERSION: &str = env!("CARGO_PKG_VERSION");


#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Default)]
#[serde(rename_all="camelCase")]
pub enum ConnectionState{#[default] Waiting,Connected,Recovering,Unavailable}
#[derive(Debug,Default)]
pub struct InnerState{pub core:CoreState}
impl std::ops::Deref for InnerState{type Target=CoreState;fn deref(&self)->&CoreState{&self.core}}
impl std::ops::DerefMut for InnerState{fn deref_mut(&mut self)->&mut CoreState{&mut self.core}}
pub struct AppState(pub Mutex<InnerState>);
#[derive(Debug,Clone,Serialize)]
pub struct StatusSnapshot{
 pub log_dir:Option<String>,pub backend_url:String,pub companion_token_configured:bool,
 pub backend_state:ConnectionState,pub backend_last_sent_at:Option<String>,pub backend_last_error:Option<String>,
 pub obs_config:ObsConfig,pub obs_connected:bool,pub obs_state:ConnectionState,pub obs_last_error:Option<String>,
 pub obs_streaming:Option<bool>,pub obs_streaming_confirmed_at:Option<String>,pub companion_version:String,
}
impl AppState{
 pub fn new()->Self{Self(Mutex::new(InnerState::default()))}
 pub fn snapshot(&self)->StatusSnapshot{
  let i=self.0.lock().unwrap();
  let backend_state=if !i.core.backend_attempted{ConnectionState::Waiting}else if i.core.backend_consecutive_failures==0{ConnectionState::Connected}else if i.core.backend_consecutive_failures<crate::backend::MAX_RETRY_ATTEMPT{ConnectionState::Recovering}else{ConnectionState::Unavailable};
  let obs_state=if i.obs_connected{ConnectionState::Connected}else if i.obs_last_error.is_some(){ConnectionState::Recovering}else{ConnectionState::Waiting};
  StatusSnapshot{log_dir:i.core.log_dir.clone(),backend_url:DEFAULT_BACKEND_URL.into(),companion_token_configured:i.core.companion_token.is_some(),backend_state,backend_last_sent_at:i.core.backend_last_sent_at.clone(),backend_last_error:i.core.backend_last_error.clone(),obs_config:i.obs_config.public(),obs_connected:i.obs_connected,obs_state,obs_last_error:i.obs_last_error.clone(),obs_streaming:i.obs_streaming,obs_streaming_confirmed_at:i.obs_streaming_confirmed_at.clone(),companion_version:COMPANION_VERSION.into()}
 }
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn public_snapshot_is_neutral_and_never_exports_credentials_or_saved_extensions(){
  let state=AppState::new();{let mut i=state.0.lock().unwrap();i.core.companion_token=Some("private-account-token".into());i.obs_config.password="private-obs-password".into();i.obs_config.extensions.insert("private-extension".into(),serde_json::json!({"secret":"private-value"}));}
  let value=serde_json::to_value(state.snapshot()).unwrap();let encoded=value.to_string();for secret in ["private-account-token","private-obs-password","private-extension","private-value"]{assert!(!encoded.contains(secret));}for removed in ["dota_found","gsi_state","overlay_visible"]{assert!(value.get(removed).is_none());}
 }
}
