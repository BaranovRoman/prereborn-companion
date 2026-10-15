//! Installed UI data/setting operations. Same catalog, binding rules and files;
//! no host controls, arbitrary paths, SQL, URLs or credentials in UI arguments.
use crate::sounds::{config::{self,GameSoundSettings},assets};
use companion_dota_domain::{catalog,events::GameSoundEventKind};
use serde::Deserialize;
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use std::path::Path;
type Result<T>=std::result::Result<T,String>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page{offset:usize,limit:usize}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsPage{offset:usize,limit:usize,revision:String}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Master{enabled:bool,volume:u8}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Bind{event_id:String,kind:GameSoundEventKind,asset_id:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Remove{event_id:String}
fn parse<T:serde::de::DeserializeOwned>(args:Value)->Result<T>{serde_json::from_value(args).map_err(|_|"invalid_ui_arguments".into())}
fn page(offset:usize,limit:usize,max:usize,total:usize)->Result<std::ops::Range<usize>>{
 if limit==0||limit>max||offset>total{return Err("invalid_ui_page".into());}Ok(offset..offset.saturating_add(limit).min(total))
}
fn load(root:&Path)->Result<(GameSoundSettings,String)>{
 let settings=config::load_verified(&root.join("game-sounds-config.json"))?;
 let revision=format!("{:x}",Sha256::digest(serde_json::to_vec(&settings).map_err(|_|"sound_settings_encoding")?));Ok((settings,revision))
}
fn summary(settings:&GameSoundSettings,revision:&str)->Value{json!({"schemaVersion":settings.schema_version,"enabled":settings.enabled,"masterVolume":settings.master_volume,"bindings":settings.bindings.len(),"assets":settings.assets.len(),"revision":revision})}
fn commit(root:&Path,settings:&GameSoundSettings)->Result<Value>{
 if serde_json::to_vec(settings).map_err(|_|"sound_settings_encoding")?.len()>1024*1024{return Err("sound_settings_too_large".into());}
 config::save_to(&root.join("game-sounds-config.json"),settings).map_err(|_|"sound_settings_write_failed")?;
 let (confirmed,revision)=load(root)?;if confirmed!=*settings{return Err("sound_settings_changed".into());}Ok(summary(&confirmed,&revision))
}
pub fn command(root:&Path,name:&str,args:Value)->Result<Value>{
 let value=match name{
  "catalog.items"=>{let p:Page=parse(args)?;let all=catalog::item_catalog();json!({"items":all[page(p.offset,p.limit,32,all.len())?],"total":all.len()})},
  "catalog.heroes"=>{let p:Page=parse(args)?;let all=catalog::hero_catalog();json!({"heroes":all[page(p.offset,p.limit,4,all.len())?],"total":all.len()})},
  "sound.summary"=>{empty(args)?;let (settings,revision)=load(root)?;summary(&settings,&revision)},
  "sound.bindings"|"sound.assets"=>{
   let p:SettingsPage=parse(args)?;let (settings,revision)=load(root)?;if revision!=p.revision{return Err("sound_settings_changed".into());}
   if name=="sound.bindings"{json!({"items":settings.bindings[page(p.offset,p.limit,32,settings.bindings.len())?],"revision":revision})}
   else{json!({"items":settings.assets[page(p.offset,p.limit,32,settings.assets.len())?],"revision":revision})}
  },
  "sound.master"=>{let m:Master=parse(args)?;let (mut settings,_)=load(root)?;settings.enabled=m.enabled;settings.master_volume=config::clamp_volume(m.volume);commit(root,&settings)?},
  "sound.bind"=>{
   let b:Bind=parse(args)?;bindable(&b.event_id,b.kind)?;let (mut settings,_)=load(root)?;
   if !settings.assets.iter().any(|a|a.id==b.asset_id){return Err("sound_asset_missing".into());}
   config::upsert_binding(&mut settings,&b.event_id,b.kind,&b.asset_id);commit(root,&settings)?
  },
  "sound.remove"=>{
   let r:Remove=parse(args)?;if r.event_id.is_empty()||r.event_id.len()>128{return Err("invalid_event_id".into());}
   let (mut settings,_)=load(root)?;config::remove_binding(&mut settings,&r.event_id);commit(root,&settings)?
   // Retain old managed files: removing a binding never deletes user audio.
  },
  _=>return Err("unsupported_ui_command".into()),
 };
 if serde_json::to_vec(&value).map_err(|_|"ui_encoding_failed")?.len()>companion_plugin_protocol::MAX_FRAME-512{return Err("ui_response_too_large".into());}Ok(value)
}
pub fn bindable(event:&str,kind:GameSoundEventKind)->Result<()>{
 if event.is_empty()||event.len()>128{return Err("invalid_event_id".into());}
 let supported=match kind{GameSoundEventKind::ItemUsed=>catalog::find_item(event).is_some_and(|i|i.supported),GameSoundEventKind::AbilityCast=>catalog::find_ability(event).is_some_and(|a|a.status!=catalog::AbilityStatus::Unsupported)};
 if supported{Ok(())}else{Err("unsupported_sound_event".into())}
}
pub fn empty(args:Value)->Result<()>{if args.is_null()||args==json!({}){Ok(())}else{Err("unexpected_command_payload".into())}}
pub fn preview(root:&Path,args:Value)->Result<(String,u8)>{
 #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Preview{asset_id:String}
 let p:Preview=parse(args)?;let (settings,_)=load(root)?;let asset=settings.assets.iter().find(|a|a.id==p.asset_id).ok_or("sound_asset_missing")?;
 assets::read_plugin_file_from(&root.join("sounds"),asset)?;Ok((asset.file_name.clone(),config::clamp_volume(settings.master_volume)))
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]
 fn existing_binding_files_survive_paged_reads_edits_removal_and_stale_pagination_is_rejected(){
  let root=tempfile::tempdir().unwrap();std::fs::create_dir(root.path().join("sounds")).unwrap();std::fs::write(root.path().join("sounds/existing.wav"),b"existing user audio").unwrap();
  std::fs::write(root.path().join("game-sounds-config.json"),json!({"schemaVersion":1,"enabled":true,"masterVolume":63,"bindings":[{"eventId":"techies_suicide","kind":"abilityCast","assetId":"existing"}],"assets":[{"id":"existing","fileName":"existing.wav","originalName":"jump.wav","sizeBytes":19}]}).to_string()).unwrap();
  let before=std::fs::read(root.path().join("game-sounds-config.json")).unwrap();let initial=command(root.path(),"sound.summary",json!({})).unwrap();assert_eq!(initial["masterVolume"],63);
  let bindings=command(root.path(),"sound.bindings",json!({"offset":0,"limit":32,"revision":initial["revision"]})).unwrap();assert_eq!(bindings["items"][0]["eventId"],"techies_suicide");assert_eq!(std::fs::read(root.path().join("game-sounds-config.json")).unwrap(),before);
  command(root.path(),"sound.master",json!({"enabled":true,"volume":52})).unwrap();
  assert_eq!(command(root.path(),"sound.assets",json!({"offset":0,"limit":32,"revision":initial["revision"]})).unwrap_err(),"sound_settings_changed");
  command(root.path(),"sound.bind",json!({"eventId":"techies_suicide","kind":"abilityCast","assetId":"existing"})).unwrap();
  command(root.path(),"sound.remove",json!({"eventId":"techies_suicide"})).unwrap();assert!(root.path().join("sounds/existing.wav").exists());
  assert_eq!(config::load_verified(&root.path().join("game-sounds-config.json")).unwrap().assets.len(),1);assert!(!root.path().join("local-runtime.sqlite3").exists());
 }
 #[test]
 fn catalog_is_the_actual_domain_catalog_and_ui_cannot_inject_paths_or_host_commands(){
  let root=tempfile::tempdir().unwrap();let value=command(root.path(),"catalog.heroes",json!({"offset":0,"limit":4})).unwrap();
  let all=catalog::hero_catalog();assert_eq!(value["total"],all.len());assert_eq!(value["heroes"],serde_json::to_value(&all[..4]).unwrap());
  assert_eq!(command(root.path(),"catalog.heroes",json!({"offset":0,"limit":100})).unwrap_err(),"invalid_ui_page");
  assert_eq!(command(root.path(),"sound.summary",json!({"path":"arbitrary"})).unwrap_err(),"unexpected_command_payload");
  assert_eq!(command(root.path(),"host.activate",json!({})).unwrap_err(),"unsupported_ui_command");
  assert!(command(root.path(),"sound.bind",json!({"eventId":"unsupported","kind":"abilityCast","assetId":"anything"})).is_err());
  assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0);
 }
}
