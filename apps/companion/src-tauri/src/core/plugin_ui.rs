//! Verified installed UI assets. This transport has no game/replay lab state.
use std::path::Path;
use std::io::Read;
use tauri::Manager;

pub(crate) fn asset(root:&Path,uri_path:&str)->Result<(Vec<u8>,&'static str),String>{
    let relative=uri_path.trim_start_matches('/');
    if relative.is_empty()||relative.contains('%')||relative.contains('\\')||Path::new(relative).components().any(|c|!matches!(c,std::path::Component::Normal(_))){return Err("invalid_asset_path".into());}
    let root=root.canonicalize().map_err(|_|"plugin_ui_unavailable")?;
    let path=root.join(relative).canonicalize().map_err(|_|"plugin_ui_unavailable")?;
    if !path.starts_with(&root)||!path.is_file(){return Err("asset_outside_plugin".into());}
    let mime=match path.extension().and_then(|e|e.to_str()){
        Some("html")=>"text/html; charset=utf-8",Some("js")=>"text/javascript; charset=utf-8",Some("css")=>"text/css; charset=utf-8",_=>return Err("unsupported_asset".into()),
    };
    if path.metadata().map_err(|_|"plugin_ui_unavailable")?.len()>1024*1024{return Err("asset_too_large".into());}
    let mut bytes=Vec::new();std::fs::File::open(path).map_err(|_|"plugin_ui_unavailable")?.take(1024*1024+1).read_to_end(&mut bytes).map_err(|_|"plugin_ui_unavailable")?;
    if bytes.len()>1024*1024{return Err("asset_too_large".into());}Ok((bytes,mime))
}
pub(crate) fn csp(origins:&[String])->String{
    let frames=if origins.is_empty(){"'none'".into()}else{origins.join(" ")};
    format!("default-src 'none'; script-src plugin-ui: http://plugin-ui.localhost; style-src plugin-ui: http://plugin-ui.localhost; img-src plugin-ui: http://plugin-ui.localhost https://cdn.cloudflare.steamstatic.com; connect-src 'none'; frame-src {frames}; base-uri 'none'; form-action 'none'")
}
pub(crate) fn response(app:&tauri::AppHandle,path:&str)->tauri::http::Response<Vec<u8>>{
    let result=app.try_state::<super::plugin_manager::PluginManager>().ok_or_else(||"plugin_manager_unavailable".to_string())
        .and_then(|manager|{let policy=manager.ui_frame_origins(path)?;let(bytes,mime)=manager.asset(path)?;Ok((bytes,mime,csp(&policy)))});
    match result{
        Ok((bytes,mime,policy))=>tauri::http::Response::builder().header("Content-Type",mime)
            .header("Access-Control-Allow-Origin","*").header("X-Content-Type-Options","nosniff")
            .header("Content-Security-Policy",policy).body(bytes).unwrap(),
        Err(_)=>tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn nested_frames_do_not_grant_network_or_native_script_access(){
        let empty=csp(&[]);assert!(empty.contains("frame-src 'none'"));
        let granted=csp(&["http://127.0.0.1:4567".into()]);assert!(granted.contains("frame-src http://127.0.0.1:4567;"));
        for policy in [empty,granted]{assert!(policy.contains("connect-src 'none'"));assert!(policy.contains("form-action 'none'"));assert!(!policy.contains("unsafe-eval"));assert!(!policy.contains("unsafe-inline"));}
    }
}
