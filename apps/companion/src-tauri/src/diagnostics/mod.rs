//! Opt-in core/TTS diagnostics. No game payload capture or game-state analyzer.
pub mod tts_trace;
pub mod redact;
use std::{path::{Path,PathBuf},sync::Mutex,io::{Read,Write}};
use serde::{Deserialize,Serialize};
use tauri::{AppHandle,Manager};
use crate::{storage,state::COMPANION_VERSION};
const SIZE_LIMIT:u64=150*1024*1024;
#[derive(Default)]pub struct DiagnosticsState(pub Mutex<DiagnosticsInner>);
impl DiagnosticsState{pub fn new()->Self{Self::default()}}
#[derive(Default)]pub struct DiagnosticsInner{session:Option<Session>}
#[derive(Clone,Default,Serialize,Deserialize)]#[serde(default)]struct Session{
 session_id:String,started_at:String,finalized:bool,bytes_written:u64,tts_trace_count:u64,
 #[serde(skip)]dir:PathBuf,
}
#[derive(Clone,Default,Serialize)]pub struct DiagnosticsStatusSnapshot{
 pub active:bool,pub has_session:bool,pub session_id:Option<String>,pub started_at:Option<String>,
 pub bytes_written:u64,pub size_limit_bytes:u64,pub size_limit_reached:bool,pub tts_trace_count:u64,
 pub companion_version:String,pub os:String,pub app_log_size_bytes:u64,
}
fn root(app:&AppHandle)->PathBuf{storage::logs_root(app).join("diagnostics")}
/// Replace, never truncate in place: a crash mid-write must not hide the
/// newest session from recovery (and leave its directory orphaned).
fn persist(session:&Session)->Result<(),String>{
 let bytes=serde_json::to_vec(session).map_err(|_|"diagnostics_encoding_failed")?;let tmp=session.dir.join("session-state.json.tmp");
 std::fs::write(&tmp,bytes).and_then(|_|std::fs::rename(&tmp,session.dir.join("session-state.json"))).map_err(|_|"diagnostics_metadata_write_failed".into())
}
fn read_bounded(path:&Path,limit:u64)->Result<Vec<u8>,String>{
 let meta=path.symlink_metadata().map_err(|_|"diagnostics_file_unavailable")?;if !meta.is_file()||meta.file_type().is_symlink()||meta.len()>limit{return Err("diagnostics_file_limit".into());}
 let mut bytes=Vec::new();std::fs::File::open(path).map_err(|_|"diagnostics_file_unavailable")?.take(limit+1).read_to_end(&mut bytes).map_err(|_|"diagnostics_file_unavailable")?;if bytes.len()as u64>limit{return Err("diagnostics_file_limit".into());}Ok(bytes)
}
pub fn status<R:tauri::Runtime>(app:&AppHandle<R>)->DiagnosticsStatusSnapshot{
 let state=app.state::<DiagnosticsState>();let inner=state.0.lock().unwrap();let session=inner.session.as_ref();
 DiagnosticsStatusSnapshot{active:session.is_some_and(|s|!s.finalized),has_session:session.is_some(),session_id:session.map(|s|s.session_id.clone()),started_at:session.map(|s|s.started_at.clone()),bytes_written:session.map_or(0,|s|s.bytes_written),size_limit_bytes:SIZE_LIMIT,size_limit_reached:session.is_some_and(|s|s.bytes_written>=SIZE_LIMIT),tts_trace_count:session.map_or(0,|s|s.tts_trace_count),companion_version:COMPANION_VERSION.into(),os:std::env::consts::OS.into(),app_log_size_bytes:storage::rolling_log_size_bytes(app)}
}
pub fn recover_last_session(app:&AppHandle){
 if let Some(session)=recover_in(&root(app)){app.state::<DiagnosticsState>().0.lock().unwrap().session=Some(session);}
}
/// Newest well-formed session whose directory name is its own id; a session
/// that was running when the app stopped is recovered as finalized.
fn recover_in(root:&Path)->Option<Session>{
 let entries=std::fs::read_dir(root).ok()?;let mut dirs:Vec<_>=entries.filter_map(Result::ok).filter(|e|e.file_type().is_ok_and(|m|m.is_dir())).map(|e|e.path()).collect();dirs.sort();
 dirs.into_iter().rev().find_map(|dir|{
  let session=read_bounded(&dir.join("session-state.json"),32768).ok().and_then(|b|serde_json::from_slice::<Session>(&b).ok());
  session.filter(|s|!s.session_id.is_empty()&&dir.file_name().and_then(|n|n.to_str())==Some(s.session_id.as_str())&&chrono::DateTime::parse_from_rfc3339(&s.started_at).is_ok()&&s.bytes_written<=SIZE_LIMIT).map(|mut s|{s.dir=dir;s.finalized=true;s})
 })
}
#[cfg(test)]mod tests{
 use super::*;
 fn session(root:&Path,id:&str,bytes:u64)->Session{let dir=root.join(id);std::fs::create_dir_all(&dir).unwrap();let s=Session{session_id:id.into(),started_at:"2026-10-17T10:00:00+07:00".into(),bytes_written:bytes,dir,..Default::default()};persist(&s).unwrap();s}
 #[test]fn recovery_takes_the_newest_valid_session_finalized_and_ignores_forged_or_oversized_state(){
  let root=tempfile::tempdir().unwrap();let root=root.path();assert!(recover_in(&root.join("missing")).is_none());
  session(root,"diag_20261017T100000_a",10);let newest=session(root,"diag_20261017T110000_b",20);
  assert!(!newest.dir.join("session-state.json.tmp").exists());
  let recovered=recover_in(root).unwrap();assert_eq!(recovered.session_id,"diag_20261017T110000_b");assert!(recovered.finalized);assert_eq!(recovered.dir,newest.dir);
  // A state file naming another directory, an oversized counter or a symlink is skipped.
  let forged=root.join("diag_20261017T120000_c");std::fs::create_dir(&forged).unwrap();std::fs::copy(newest.dir.join("session-state.json"),forged.join("session-state.json")).unwrap();
  session(root,"diag_20261017T130000_d",SIZE_LIMIT+1);
  #[cfg(unix)]{let link=root.join("diag_20261017T140000_e");std::fs::create_dir(&link).unwrap();std::os::unix::fs::symlink(newest.dir.join("session-state.json"),link.join("session-state.json")).unwrap();}
  std::fs::create_dir(root.join("diag_20261017T150000_f")).unwrap();std::fs::write(root.join("diag_20261017T150000_f/session-state.json"),b"{\"session_id\":").unwrap();
  assert_eq!(recover_in(root).unwrap().session_id,"diag_20261017T110000_b");
 }
}
pub fn start(app:&AppHandle)->Result<DiagnosticsStatusSnapshot,String>{
 let state=app.state::<DiagnosticsState>();let mut inner=state.0.lock().map_err(|_|"diagnostics_state_unavailable")?;
 if inner.session.as_ref().is_some_and(|s|!s.finalized){return Err("Диагностика уже запущена.".into());}
 let now=chrono::Local::now();let id=format!("diag_{}_{}",now.format("%Y%m%dT%H%M%S"),uuid::Uuid::new_v4());let dir=root(app).join(&id);std::fs::create_dir_all(&dir).map_err(|_|"diagnostics_directory_failed")?;
 let session=Session{session_id:id,started_at:now.to_rfc3339(),dir,..Default::default()};persist(&session)?;inner.session=Some(session);drop(inner);Ok(status(app))
}
pub fn stop(app:&AppHandle)->Result<DiagnosticsStatusSnapshot,String>{
 let state=app.state::<DiagnosticsState>();let mut inner=state.0.lock().map_err(|_|"diagnostics_state_unavailable")?;let session=inner.session.as_mut().ok_or("Нет диагностической сессии.")?;session.finalized=true;persist(session)?;drop(inner);Ok(status(app))
}
pub fn clear(app:&AppHandle)->Result<DiagnosticsStatusSnapshot,String>{
 let state=app.state::<DiagnosticsState>();let mut inner=state.0.lock().map_err(|_|"diagnostics_state_unavailable")?;
 if inner.session.as_ref().is_some_and(|s|!s.finalized){return Err("Сначала остановите диагностику.".into());}
 if let Some(session)=&inner.session{std::fs::remove_dir_all(&session.dir).map_err(|_|"diagnostics_clear_failed")?;}inner.session=None;drop(inner);Ok(status(app))
}
pub fn observe_tts_stage(app:&AppHandle,event:&tts_trace::TtsTraceEvent){
 let state=app.state::<DiagnosticsState>();let Ok(mut inner)=state.0.lock()else{return;};let Some(session)=inner.session.as_mut().filter(|s|!s.finalized&&s.bytes_written<SIZE_LIMIT)else{return;};
 if event.message_id.len()>128||event.stages.len()>32||event.engine.as_ref().is_some_and(|e|e.len()>64)||event.stages.iter().any(|(k,n)|k.len()>64||!n.is_finite()){return;}
 let Ok(value)=serde_json::to_value(event)else{return;};let Ok(mut bytes)=serde_json::to_vec(&redact::redact(&value))else{return;};if bytes.len()>8192{return;}bytes.push(b'\n');
 if session.bytes_written.saturating_add(bytes.len()as u64)>SIZE_LIMIT{return;}
 let result=std::fs::OpenOptions::new().append(true).create(true).open(session.dir.join("tts-trace.jsonl")).and_then(|mut f|f.write_all(&bytes));
 if result.is_ok(){session.bytes_written+=bytes.len()as u64;session.tts_trace_count+=1;let _=persist(session);}else{session.finalized=true;let _=persist(session);storage::append_rolling_log(app,"Diagnostics TTS trace write failed; capture stopped.");}
}
pub fn export(app:&AppHandle,output:PathBuf)->Result<String,String>{
 use zip::{ZipWriter,write::SimpleFileOptions};
 let session=app.state::<DiagnosticsState>().0.lock().map_err(|_|"diagnostics_state_unavailable")?.session.clone();
 let report=serde_json::to_vec_pretty(&app.state::<crate::state::AppState>().snapshot()).map_err(|_|"diagnostics_encoding_failed")?;
 let log=storage::read_rolling_log(app);let trace=session.as_ref().map(|s|s.dir.join("tts-trace.jsonl")).filter(|p|p.exists()).map(|p|read_bounded(&p,SIZE_LIMIT)).transpose()?;
 let file=std::fs::File::create(&output).map_err(|_|"diagnostics_export_failed")?;let mut archive=ZipWriter::new(file);let options=SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
 let mut files=vec![("app.log",log),("runtime-report.json",report),("manifest.json",serde_json::to_vec_pretty(&status(app)).map_err(|_|"diagnostics_encoding_failed")?)];if let Some(trace)=trace{files.push(("tts-trace.jsonl",trace));}
 for(name,bytes)in files{archive.start_file(name,options).map_err(|_|"diagnostics_export_failed")?;archive.write_all(&bytes).map_err(|_|"diagnostics_export_failed")?;}archive.finish().map_err(|_|"diagnostics_export_failed")?;Ok(output.to_string_lossy().into())
}
