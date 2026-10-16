//! The actual local overlay contract now belongs to the installed Dota package.
use serde::Serialize;
use companion_dota_domain::broadcast_state::BroadcastState;
use companion_dota_storage::local_runtime::summary::LocalSessionSummary;
pub mod server;
pub mod hotkey;
pub mod images;
/// A confirmed host response only; iframe commands cannot call host.resource.
/// Preserve the complete document, including fields the local editor ignores.
pub fn save_resource(root:&std::path::Path,resource:&str,body:&serde_json::Value)->Result<(),String>{
 use std::io::Write;
 let name=match resource{"overlay-layout"|"overlay-layout-save"=>"overlay-layout.json","queue-settings"|"queue-settings-save"=>"queue-settings.json",_=>return Err("backend_resource_unhandled".into())};
 let version=body.get("version").and_then(serde_json::Value::as_u64);
 // Existing backend contracts: overlay layout v5; queue settings v1/v2,
 // normalized to v2 by the server. Do not invent a common schema version.
 if if name=="overlay-layout.json"{version!=Some(5)}else{!matches!(version,Some(1|2))}
  ||if name=="overlay-layout.json"{!body.get("scenes").is_some_and(serde_json::Value::is_object)}else{!body.get("visibility").is_some_and(serde_json::Value::is_object)||!body.get("widgets").is_some_and(serde_json::Value::is_object)}{return Err("overlay_settings_invalid".into());}
 let bytes=serde_json::to_vec(body).map_err(|_|"overlay_settings_invalid")?;if bytes.len()>24576{return Err("overlay_settings_limit".into());}
 let path=root.join(name);if path.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink()){return Err("overlay_config_invalid".into());}
 let tmp=root.join(format!(".overlay-settings-{}.tmp",uuid::Uuid::new_v4()));
 let result=(||->std::io::Result<()>{let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&tmp)?;file.write_all(&bytes)?;file.sync_all()?;drop(file);std::fs::rename(&tmp,path)})();
 if result.is_err(){let _=std::fs::remove_file(&tmp);}result.map_err(|_|"overlay_settings_write_failed".into())
}
/// Only pre-existing public overlay cache/config files are read here. Never
/// companion-config.json, OBS credentials, a raw GSI payload or a supplied path.
pub fn saved(root:&std::path::Path,name:&str,limit:u64)->Result<Option<serde_json::Value>,String>{
 use std::io::Read;
 if !matches!(name,"overlay-layout.json"|"queue-settings.json"|"account-overlay-data.json"){return Err("overlay_config_denied".into());}
 let path=root.join(name);let metadata=match path.symlink_metadata(){Ok(m)=>m,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err("overlay_config_unavailable".into())};
 if !metadata.is_file()||metadata.file_type().is_symlink()||metadata.len()>limit{return Err("overlay_config_invalid".into());}
 let mut bytes=Vec::new();std::fs::File::open(path).map_err(|_|"overlay_config_unavailable")?.take(limit+1).read_to_end(&mut bytes).map_err(|_|"overlay_config_unavailable")?;
 if bytes.len()as u64>limit{return Err("overlay_config_limit".into());}
 let value:serde_json::Value=serde_json::from_slice(&bytes).map_err(|_|"overlay_config_invalid")?;
 if !value.is_object()&&!value.is_null(){return Err("overlay_config_invalid".into());}Ok(Some(value))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStateSnapshot {
    pub scene: BroadcastState,
    pub updated_at: String,
    /// `has_session: false` (the struct's own `Default`) when no local
    /// session is open yet - see summary.rs. Never a nested `Option`: the
    /// renderer only ever needs to branch on `hasSession`.
    pub session: LocalSessionSummary,
    /// WK-122 §19 - bumped every time `AppState.overlay_layout` actually
    /// changes (a fresh fetch that differs from the cache, or a save from
    /// the Оформление editor - see backend::apply_overlay_layout). The
    /// renderer doesn't need the layout on every tick (positions rarely
    /// change), so this is a cheap version number rather than embedding the
    /// whole layout blob here - it fetches `/overlay/layout` once and
    /// re-fetches only when this number moves.
    pub layout_version: u64,
    pub account: Option<serde_json::Value>,
    pub twitch_chat: Option<serde_json::Value>,
    /// WK-124 - global runtime visibility override (see
    /// commands::toggle_overlay_visible and InnerState::overlay_visible's
    /// doc comment). This is NOT `scene`/BroadcastState: `scene` keeps
    /// resolving normally regardless of this value - the renderer's own
    /// final visibility gate (overlay-renderer/OverlayApp.tsx) is the only
    /// place that reads it, rendering fully transparent output whenever
    /// this is `false` and the page is not the "Оформление" editor preview.
    /// Participates in `serve_sse`'s whole-snapshot diff like every other
    /// field here, so a toggle is pushed to an already-open Browser Source
    /// immediately, without a reload.
    pub overlay_visible: bool,
    /// WK-148 - Between Matches OpenDota enrichment, populated in the
    /// background by opendota_overlay_cache.rs (this renderer has no Tauri
    /// IPC, see that module's doc comment) - `None` until the first
    /// successful poll, or if OpenDota/Steam-link is unavailable. Opaque
    /// `serde_json::Value` (same pattern as `account`/`twitch_chat` above) -
    /// the renderer owns the typed DTO, matching apps/api's
    /// OpenDotaFavoriteHeroesResponse/OpenDotaProfileRadarResponse shapes.
    pub opendota_favorite_heroes: Option<serde_json::Value>,
    pub opendota_radar: Option<serde_json::Value>,
    /// WK-116 - Between Matches quiz round state, populated by
    /// quiz_overlay.rs's own background poll (same "opaque JSON pass-
    /// through, no Tauri IPC" reasoning as the two fields above). `null`
    /// whenever there is no active round - the renderer's own gate for
    /// whether to mount the quiz board at all.
    pub quiz: Option<serde_json::Value>,
}
