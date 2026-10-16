//! The existing overlay shortcut belongs to the installed game's process.
//! Its Windows message pump registers no TTS key and has no history writer.
use serde::{Deserialize,Serialize};
use std::{path::Path,sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};
pub const DEFAULT_SHORTCUT:&str="CommandOrControl+Alt+F11";
#[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
#[serde(default,rename_all="camelCase",deny_unknown_fields)]
pub struct Config{pub enabled:bool,pub shortcut:String}
impl Default for Config{fn default()->Self{Self{enabled:true,shortcut:DEFAULT_SHORTCUT.into()}}}
#[derive(Serialize)]#[serde(rename_all="camelCase")]
pub struct Status{pub enabled:bool,pub shortcut:String,pub registered:bool,pub last_error:Option<String>}
#[derive(Default)]pub struct Controller{config:Config,native:Option<Native>,error:Option<String>}
struct Native{stop:Arc<AtomicBool>,fired:Arc<AtomicBool>,thread:Option<std::thread::JoinHandle<()>>}
impl Native{
 fn stop(&mut self)->Result<(),String>{
  self.stop.store(true,Ordering::SeqCst);let deadline=std::time::Instant::now()+Duration::from_secs(2);
  while self.thread.as_ref().is_some_and(|t|!t.is_finished()){
   if std::time::Instant::now()>=deadline{return Err("overlay_hotkey_stop_unproven".into());}
   std::thread::sleep(Duration::from_millis(5));
  }
  if let Some(thread)=self.thread.take(){thread.join().map_err(|_|"overlay_hotkey_thread_failed")?;}Ok(())
 }
}
impl Drop for Native{fn drop(&mut self){self.stop.store(true,Ordering::SeqCst);}}
fn validate(config:&Config)->Result<(),String>{
 if config.shortcut.len()>128||config.shortcut.chars().any(char::is_control)||(config.enabled&&config.shortcut.trim().is_empty()){return Err("invalid_overlay_hotkey".into());}
 #[cfg(windows)]if !config.shortcut.trim().is_empty(){config.shortcut.parse::<global_hotkey::hotkey::HotKey>().map_err(|_|"invalid_overlay_hotkey")?;}
 Ok(())
}
fn read(root:&Path)->Result<Config,String>{
 use std::io::Read;
 let path=root.join("overlay-hotkey-config.json");let meta=match path.symlink_metadata(){Ok(m)=>m,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(Config::default()),Err(_)=>return Err("overlay_hotkey_config_unavailable".into())};
 if !meta.is_file()||meta.file_type().is_symlink()||meta.len()>4096{return Err("overlay_hotkey_config_invalid".into());}
 let mut bytes=Vec::new();std::fs::File::open(path).map_err(|_|"overlay_hotkey_config_unavailable")?.take(4097).read_to_end(&mut bytes).map_err(|_|"overlay_hotkey_config_unavailable")?;
 if bytes.len()>4096{return Err("overlay_hotkey_config_invalid".into());}
 let config=serde_json::from_slice(&bytes).map_err(|_|"overlay_hotkey_config_invalid")?;validate(&config)?;Ok(config)
}
fn persist(root:&Path,config:&Config)->Result<(),String>{
 use std::io::Write;let path=root.join("overlay-hotkey-config.json");
 if path.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink()){return Err("overlay_hotkey_config_invalid".into());}
 let tmp=root.join(format!(".overlay-hotkey-{}.tmp",uuid::Uuid::new_v4()));
 let result=(||->std::io::Result<()>{let mut f=std::fs::OpenOptions::new().create_new(true).write(true).open(&tmp)?;f.write_all(&serde_json::to_vec_pretty(config)?)?;f.sync_all()?;drop(f);std::fs::rename(&tmp,&path)})();
 if result.is_err(){let _=std::fs::remove_file(&tmp);}result.map_err(|_|"overlay_hotkey_config_write_failed".into())
}
impl Controller{
 pub fn status(&self)->Status{Status{enabled:self.config.enabled,shortcut:self.config.shortcut.clone(),registered:self.native.as_ref().is_some_and(|n|n.thread.as_ref().is_some_and(|t|!t.is_finished()))&&self.error.is_none(),last_error:self.error.clone()}}
 pub fn load(&mut self,root:&Path){match read(root){Ok(c)=>self.config=c,Err(e)=>self.error=Some(e)}}
 pub fn start(&mut self)->Result<(),String>{
  if self.error.is_some(){return Err("overlay_hotkey_config_requires_review".into());}
  self.stop()?;if !self.config.enabled{return Ok(());}
  match start_native(&self.config){Ok(native)=>{self.native=Some(native);Ok(())},Err(e)=>{self.error=Some(e.clone());Err(e)}}
 }
 pub fn stop(&mut self)->Result<(),String>{if let Some(native)=self.native.as_mut(){native.stop()?;}self.native=None;Ok(())}
 pub fn take_toggle(&self)->bool{self.native.as_ref().is_some_and(|n|n.fired.swap(false,Ordering::SeqCst))}
 pub fn update(&mut self,root:&Path,config:Config,active:bool)->Result<Status,String>{
  validate(&config)?;
  // Reject invalid/future settings instead of silently overwriting them.
  read(root)?;let old=self.config.clone();let old_error=self.error.clone();self.stop()?;
  self.config=config;self.error=None;
  let result=(||{if active{self.start()?;}persist(root,&self.config)})();
  if let Err(error)=result{self.stop()?;self.config=old;self.error=old_error;if active&&self.error.is_none(){let _=self.start();}return Err(error);}
  Ok(self.status())
 }
}
#[cfg(not(windows))]fn start_native(_config:&Config)->Result<Native,String>{Err("overlay_hotkey_requires_windows".into())}
#[cfg(windows)]fn start_native(config:&Config)->Result<Native,String>{
 use global_hotkey::{GlobalHotKeyManager,GlobalHotKeyEvent,HotKeyState};
 use windows_sys::Win32::UI::WindowsAndMessaging::{PeekMessageW,TranslateMessage,DispatchMessageW,PM_REMOVE,MSG};
 static FIRED:AtomicBool=AtomicBool::new(false);static KEY_ID:std::sync::atomic::AtomicU32=std::sync::atomic::AtomicU32::new(0);
 let key=config.shortcut.parse::<global_hotkey::hotkey::HotKey>().map_err(|_|"invalid_overlay_hotkey")?;
 GlobalHotKeyEvent::set_event_handler(Some(|event:GlobalHotKeyEvent|{if event.id==KEY_ID.load(Ordering::SeqCst)&&event.state==HotKeyState::Pressed{FIRED.store(true,Ordering::SeqCst);}}));
 let stop=Arc::new(AtomicBool::new(false));let fired=Arc::new(AtomicBool::new(false));let stopping=stop.clone();let signal=fired.clone();let(tx,rx)=std::sync::mpsc::sync_channel(1);
 let thread=std::thread::Builder::new().name("dota-overlay-hotkey".into()).spawn(move||{
  let manager=match GlobalHotKeyManager::new(){Ok(m)=>m,Err(_)=>{let _=tx.send(Err("overlay_hotkey_manager_failed"));return;}};
  if manager.register(key).is_err(){let _=tx.send(Err("overlay_hotkey_registration_failed"));return;}
  KEY_ID.store(key.id(),Ordering::SeqCst);FIRED.store(false,Ordering::SeqCst);
  let _=tx.send(Ok(()));
  while !stopping.load(Ordering::SeqCst){
   let mut message:MSG=unsafe{std::mem::zeroed()};
   for _ in 0..64{if unsafe{PeekMessageW(&mut message,std::ptr::null_mut(),0,0,PM_REMOVE)}==0{break;}unsafe{TranslateMessage(&message);DispatchMessageW(&message);}}
   if FIRED.swap(false,Ordering::SeqCst){signal.store(true,Ordering::SeqCst);}
   std::thread::sleep(Duration::from_millis(5));
  }
  KEY_ID.store(0,Ordering::SeqCst);let _=manager.unregister(key);
 }).map_err(|_|"overlay_hotkey_thread_failed")?;
 let mut native=Native{stop,fired,thread:Some(thread)};
 match rx.recv_timeout(Duration::from_secs(2)){Ok(Ok(()))=>Ok(native),other=>{native.stop()?;Err(match other{Ok(Err(code))=>code,_=>"overlay_hotkey_start_unproven"}.into())}}
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn existing_config_is_preserved_and_invalid_files_are_never_overwritten(){
  let root=tempfile::tempdir().unwrap();let path=root.path().join("overlay-hotkey-config.json");
  std::fs::write(&path,br#"{"enabled":false,"shortcut":"Ctrl+Alt+F9"}"#).unwrap();
  let mut controller=Controller::default();controller.load(root.path());assert_eq!(controller.status().shortcut,"Ctrl+Alt+F9");assert!(!controller.status().registered);
  controller.update(root.path(),Config{enabled:false,shortcut:"Ctrl+Alt+F12".into()},false).unwrap();assert_eq!(read(root.path()).unwrap().shortcut,"Ctrl+Alt+F12");
  let invalid=br#"{"enabled":true,"shortcut":"F11","future":true}"#;std::fs::write(&path,invalid).unwrap();
  assert!(controller.update(root.path(),Config::default(),false).is_err());assert_eq!(std::fs::read(path).unwrap(),invalid);
 }
 #[test]fn no_shortcut_is_registered_by_opening_settings(){let root=tempfile::tempdir().unwrap();let mut c=Controller::default();c.load(root.path());assert!(!c.status().registered);assert!(!c.take_toggle());c.stop().unwrap();assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);}
 #[cfg(windows)]#[test]fn windows_registration_is_owned_and_release_allows_another_registration(){
  let config=Config{enabled:true,shortcut:"Ctrl+Alt+F24".into()};
  let mut first=start_native(&config).unwrap();
  assert!(start_native(&config).is_err(),"another native registration must not steal the key");
  first.stop().unwrap();let mut second=start_native(&config).unwrap();second.stop().unwrap();
 }
}
