//! Host-only projections. Never serialize AppState/ObsConfig/LocalMatch wholesale.
use companion_dota_domain::{core_read::*,broadcast_state::BroadcastState as Scene};
use crate::{state::AppState,local_runtime::LocalRuntimeState};
pub fn read(state:&AppState,history:&LocalRuntimeState,grants:&[ReadCapability],query:ReadRequest)->ReadResponse {
 if !grants.contains(&query.capability()) {return ReadResponse::Error{code:ReadError::CapabilityDenied};}
 if !query.validate() {return ReadResponse::Error{code:ReadError::InvalidRequest};}
 let response = if let ReadRequest::History{limit}=query {
  let Ok(guard)=history.try_lock() else {return ReadResponse::Error{code:ReadError::Unavailable};};
  let result=guard.as_ref().ok_or(()).and_then(|conn| {
   // Fixed read-only projection. No schema migrations, caller SQL or raw account/session IDs.
   let mut stmt=conn.prepare("SELECT hero_id,CASE result WHEN 'win' THEN 1 WHEN 'loss' THEN 0 ELSE NULL END,kills,deaths,assists FROM local_matches WHERE state='finalized' ORDER BY rowid DESC LIMIT ?1").map_err(|_|())?;
   let rows=stmt.query_map([limit],|r| {Ok(MatchSummary{hero_id:r.get(0)?,won:r.get(1)?,kills:r.get(2)?,deaths:r.get(3)?,assists:r.get(4)?})}).map_err(|_|())?;
   rows.collect::<Result<Vec<_>,_>>().map_err(|_|())
  });
  match result {Ok(matches)=>ReadResponse::History{matches},Err(_)=>ReadResponse::Error{code:ReadError::Unavailable}}
 } else {
  let Ok(inner)=state.0.lock() else {return ReadResponse::Error{code:ReadError::Unavailable};};
  match query {
   ReadRequest::Obs=>ReadResponse::Obs{connected:inner.dota.obs_connected},
   ReadRequest::Scenes=>{let config=&inner.dota.obs_config;let ids=[(Scene::BetweenMatches,&config.between_matches_scene),(Scene::Draft,&config.draft_scene),(Scene::Gameplay,&config.gameplay_scene),(Scene::PostStream,&config.post_stream_scene)].into_iter().filter(|(_,name)|!name.trim().is_empty()).map(|(id,_)|id).collect();ReadResponse::Scenes{ids}},
   ReadRequest::Stream=>ReadResponse::Stream{streaming:inner.dota.obs_streaming,session_ended:inner.dota.session_ended,twitch_connected:inner.core.twitch_chat.as_ref().and_then(|s|s.get("connected")).and_then(|v|v.as_bool())},
   ReadRequest::Sounds=>{let config=&inner.dota.game_sounds_settings;let events:Vec<_>=config.bindings.iter().filter(|b|companion_dota_domain::catalog::find_item(&b.event_id).is_some()||companion_dota_domain::catalog::find_ability(&b.event_id).is_some()).take(41).map(|b|b.event_id.clone()).collect();let truncated=events.len()>40;ReadResponse::Sounds{enabled:config.enabled,volume:config.master_volume.min(100),configured_events:events.into_iter().take(40).collect(),truncated}},
   ReadRequest::Backend=>ReadResponse::Backend{state:if !inner.core.backend_attempted {Connectivity::Unknown}else if inner.core.backend_consecutive_failures==0 {Connectivity::Connected}else if inner.core.backend_consecutive_failures>=crate::backend::MAX_RETRY_ATTEMPT {Connectivity::Unavailable}else {Connectivity::Recovering}},
   ReadRequest::History{..}=>unreachable!(),
  }
 };
 if serde_json::to_vec(&response).map_or(true,|v|v.len()>8192) {ReadResponse::Error{code:ReadError::ResponseTooLarge}} else {response}
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn denies_caps_limits_and_never_exposes_credentials() {
  let state=AppState::new(); {let mut inner=state.0.lock().unwrap();inner.core.companion_token=Some("SECRET".into());inner.dota.obs_config.password="SECRET".into();inner.dota.obs_config.host="SECRET".into();inner.dota.obs_config.gameplay_scene="SECRET".into();inner.core.backend_last_error=Some("SECRET".into());
   inner.dota.game_sounds_settings.bindings.push(crate::game_sounds::config::SoundBinding{event_id:"item_tango".into(),kind:companion_dota_domain::events::GameSoundEventKind::ItemUsed,asset_id:"SECRET".into()});
   inner.dota.game_sounds_settings.assets.push(crate::game_sounds::config::ManagedSoundAsset{id:"SECRET".into(),file_name:"SECRET".into(),original_name:"SECRET".into(),size_bytes:999});inner.core.twitch_chat=Some(serde_json::json!({"token":"SECRET","connected":true}));}
  let history=LocalRuntimeState::new();
  assert!(matches!(read(&state,&history,&[],ReadRequest::Obs),ReadResponse::Error{code:ReadError::CapabilityDenied}));
  assert!(matches!(read(&state,&history,DOTA_READ_GRANTS,ReadRequest::History{limit:21}),ReadResponse::Error{code:ReadError::InvalidRequest}));
  for query in [ReadRequest::Obs,ReadRequest::Scenes,ReadRequest::Stream,ReadRequest::Sounds,ReadRequest::Backend,ReadRequest::History{limit:20}] {
   assert!(matches!(read(&state,&history,&[],query.clone()),ReadResponse::Error{code:ReadError::CapabilityDenied}));
   let json=serde_json::to_string(&read(&state,&history,DOTA_READ_GRANTS,query)).unwrap();assert!(!json.contains("SECRET"));assert!(json.len()<8192);}
  assert!(serde_json::from_str::<ReadRequest>(r#"{"query":"history","limit":1,"sql":"select 1"}"#).is_err());
 }
 #[test] fn poisoned_history_is_unavailable_without_panicking_the_plugin_host() {
  let history=LocalRuntimeState::new();
  let _=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {let _guard=history.lock();panic!("injected");}));
  assert!(matches!(read(&AppState::new(),&history,DOTA_READ_GRANTS,ReadRequest::History{limit:1}),ReadResponse::Error{code:ReadError::Unavailable}));
 }
 #[test] fn history_reads_bounded_fixed_projection_without_mutation() {
  let history=LocalRuntimeState::new();let conn=rusqlite::Connection::open_in_memory().unwrap();
  conn.execute_batch("CREATE TABLE local_matches(hero_id INTEGER,result TEXT,kills INTEGER,deaths INTEGER,assists INTEGER,state TEXT); INSERT INTO local_matches VALUES(105,'win',2,1,3,'finalized'),(106,'loss',1,2,3,'finalized');").unwrap();*history.lock()=Some(conn);
  assert!(matches!(read(&AppState::new(),&history,DOTA_READ_GRANTS,ReadRequest::History{limit:1}),ReadResponse::History{matches} if matches.len()==1 && matches[0].hero_id==106));
  assert_eq!(history.lock().as_ref().unwrap().query_row("SELECT count(*) FROM local_matches",[],|r|r.get::<_,i64>(0)).unwrap(),2);
 }
}
