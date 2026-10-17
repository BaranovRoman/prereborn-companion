//! Verified installed UI assets. This transport has no game/replay lab state.
use std::path::Path;
use std::io::Read;
use tauri::Manager;

/// `icon`: only the signed manifest's declared library icon may be an image,
/// bounded and never SVG (an SVG document could carry script).
pub(crate) fn asset(root:&Path,uri_path:&str,icon:bool)->Result<(Vec<u8>,&'static str),String>{
    let relative=uri_path.trim_start_matches('/');
    if relative.is_empty()||relative.contains('%')||relative.contains('\\')||Path::new(relative).components().any(|c|!matches!(c,std::path::Component::Normal(_))){return Err("invalid_asset_path".into());}
    let root=root.canonicalize().map_err(|_|"plugin_ui_unavailable")?;
    let path=root.join(relative).canonicalize().map_err(|_|"plugin_ui_unavailable")?;
    if !path.starts_with(&root)||!path.is_file(){return Err("asset_outside_plugin".into());}
    let mime=match path.extension().and_then(|e|e.to_str()){
        Some("html") if !icon=>"text/html; charset=utf-8",Some("js") if !icon=>"text/javascript; charset=utf-8",Some("css") if !icon=>"text/css; charset=utf-8",
        Some("png") if icon=>"image/png",Some("webp") if icon=>"image/webp",_=>return Err("unsupported_asset".into()),
    };
    let limit=if icon{256*1024}else{1024*1024};
    if path.metadata().map_err(|_|"plugin_ui_unavailable")?.len()>limit{return Err("asset_too_large".into());}
    let mut bytes=Vec::new();std::fs::File::open(path).map_err(|_|"plugin_ui_unavailable")?.take(limit+1).read_to_end(&mut bytes).map_err(|_|"plugin_ui_unavailable")?;
    if bytes.len() as u64>limit{return Err("asset_too_large".into());}Ok((bytes,mime))
}
pub(crate) fn csp(origins:&[String])->String{
    let frames=if origins.is_empty(){"'none'".into()}else{origins.join(" ")};
    let images=origins.join(" ");
    format!("default-src 'none'; script-src plugin-ui: http://plugin-ui.localhost; style-src plugin-ui: http://plugin-ui.localhost; img-src plugin-ui: http://plugin-ui.localhost https://cdn.cloudflare.steamstatic.com {images}; connect-src 'none'; frame-src {frames}; base-uri 'none'; form-action 'none'")
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
    #[test]fn only_bounded_ui_assets_inside_the_package_are_served(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("ui");std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("index.html"),b"<main>Package UI</main>").unwrap();
        std::fs::write(root.join("manifest.json"),b"private").unwrap();
        std::fs::write(temp.path().join("outside.js"),b"secret").unwrap();
        assert_eq!(asset(&root,"/index.html",false).unwrap().0,b"<main>Package UI</main>");
        for path in ["../outside.js","%2e%2e/outside.js","..\\outside.js","manifest.json",""]{assert!(asset(&root,path,false).is_err(),"{path}");}
        std::fs::write(root.join("large.js"),vec![b'x';1024*1024+1]).unwrap();
        assert_eq!(asset(&root,"large.js",false).unwrap_err(),"asset_too_large");
        #[cfg(unix)]{
            std::os::unix::fs::symlink(temp.path().join("outside.js"),root.join("link.js")).unwrap();
            assert_eq!(asset(&root,"link.js",false).unwrap_err(),"asset_outside_plugin");
        }
    }
    #[test]fn only_the_declared_icon_is_served_as_a_bounded_raster_image(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path();
        std::fs::write(root.join("icon.png"),b"\x89PNG").unwrap();std::fs::write(root.join("icon.svg"),b"<svg onload='x'/>").unwrap();std::fs::write(root.join("index.html"),b"ui").unwrap();
        assert_eq!(asset(root,"icon.png",true).unwrap().1,"image/png");
        assert_eq!(asset(root,"icon.png",false).unwrap_err(),"unsupported_asset");
        for path in ["icon.svg","index.html"]{assert_eq!(asset(root,path,true).unwrap_err(),"unsupported_asset");}
        std::fs::write(root.join("big.webp"),vec![0;256*1024+1]).unwrap();assert_eq!(asset(root,"big.webp",true).unwrap_err(),"asset_too_large");
    }
    #[test]fn nested_frames_do_not_grant_network_or_native_script_access(){
        let empty=csp(&[]);assert!(empty.contains("frame-src 'none'"));
        let granted=csp(&["http://127.0.0.1:4567".into()]);assert!(granted.contains("frame-src http://127.0.0.1:4567;"));
        assert!(granted.contains("https://cdn.cloudflare.steamstatic.com http://127.0.0.1:4567;"));assert!(!empty.contains("127.0.0.1"));
        for policy in [empty,granted]{assert!(policy.contains("connect-src 'none'"));assert!(policy.contains("form-action 'none'"));assert!(!policy.contains("unsafe-eval"));assert!(!policy.contains("unsafe-inline"));}
    }
}
