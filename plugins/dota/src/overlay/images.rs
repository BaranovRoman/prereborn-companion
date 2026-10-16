//! Only two existing local overlay asset roles. No iframe-provided source path.
use std::{path::Path,io::{Read,Write}};
pub fn target(kind:&str)->Result<(&'static str,&'static str),String>{match kind{
 "webcam"=>Ok(("queue-webcam-fallback.image","http://127.0.0.1:3666/overlay/assets/webcam-fallback")),
 "reference"=>Ok(("gameplay-reference.image","http://127.0.0.1:3666/overlay/assets/gameplay-reference")),
 _=>Err("overlay_image_role_denied".into()),
}}
fn read(path:&Path)->Result<Vec<u8>,String>{
 let meta=path.symlink_metadata().map_err(|_|"overlay_image_unavailable")?;
 if !meta.is_file()||meta.file_type().is_symlink()||meta.len()>10*1024*1024{return Err("overlay_image_invalid".into());}
 let mut bytes=Vec::new();std::fs::File::open(path).map_err(|_|"overlay_image_unavailable")?.take(10*1024*1024+1).read_to_end(&mut bytes).map_err(|_|"overlay_image_unavailable")?;
 if bytes.len()>10*1024*1024||companion_plugin_protocol::media::image_mime(&bytes).is_none(){return Err("overlay_image_invalid".into());}Ok(bytes)
}
pub fn current(root:&Path,kind:&str)->Result<Option<String>,String>{
 let(name,url)=target(kind)?;let path=root.join(name);if !path.exists(){return Ok(None);}
 let bytes=read(&path)?;use sha2::{Digest,Sha256};Ok(Some(format!("{url}?v={:x}",Sha256::digest(&bytes))))
}
pub fn apply(root:&Path,kind:&str,file:&str)->Result<String,String>{
 let(name,_)=target(kind)?;
 let path=Path::new(file);let id=path.file_stem().and_then(|s|s.to_str()).ok_or("overlay_image_invalid")?;
 if file.contains('/')||file.contains('\\')||uuid::Uuid::parse_str(id).map_err(|_|"overlay_image_invalid")?.to_string()!=id||!matches!(path.extension().and_then(|s|s.to_str()),Some("png"|"jpg"|"jpeg"|"webp")){return Err("overlay_image_invalid".into());}
 let root=root.canonicalize().map_err(|_|"overlay_image_unavailable")?;let directory=root.join("images");
 if directory.symlink_metadata().map_err(|_|"overlay_image_unavailable")?.file_type().is_symlink()||directory.canonicalize().map_err(|_|"overlay_image_unavailable")?.parent()!=Some(root.as_path()){return Err("overlay_image_invalid".into());}
 let bytes=read(&directory.join(file))?;let destination=root.join(name);
 if destination.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink()){return Err("overlay_image_invalid".into());}
 let temporary=root.join(format!(".overlay-image-{}.tmp",uuid::Uuid::new_v4()));
 let result=(||->std::io::Result<()>{let mut f=std::fs::OpenOptions::new().create_new(true).write(true).open(&temporary)?;f.write_all(&bytes)?;f.sync_all()?;drop(f);std::fs::rename(&temporary,&destination)})();
 if result.is_err(){let _=std::fs::remove_file(&temporary);}result.map_err(|_|"overlay_image_write_failed")?;
 current(&root,kind)?.ok_or("overlay_image_unavailable".into())
}
pub fn remove(root:&Path,kind:&str)->Result<(),String>{let(name,_)=target(kind)?;let path=root.join(name);
 match path.symlink_metadata(){Ok(meta)=>{if !meta.is_file()||meta.file_type().is_symlink(){return Err("overlay_image_invalid".into());}std::fs::remove_file(path).map_err(|_|"overlay_image_remove_failed".into())},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(_)=>Err("overlay_image_unavailable".into())}
}
#[cfg(test)]mod tests{use super::*;#[test]fn only_managed_images_can_replace_the_two_existing_roles(){
 let root=tempfile::tempdir().unwrap();std::fs::create_dir(root.path().join("images")).unwrap();let file=format!("{}.png",uuid::Uuid::new_v4());let bytes=b"\x89PNG\r\n\x1a\noriginal";std::fs::write(root.path().join("images").join(&file),bytes).unwrap();
 assert!(apply(root.path(),"reference",&file).unwrap().starts_with("http://127.0.0.1:3666/overlay/assets/gameplay-reference?v="));assert_eq!(std::fs::read(root.path().join("gameplay-reference.image")).unwrap(),bytes);
 assert!(apply(root.path(),"arbitrary",&file).is_err());assert!(apply(root.path(),"reference","../secret.png").is_err());
 let bad=format!("{}.png",uuid::Uuid::new_v4());std::fs::write(root.path().join("images").join(&bad),b"<html>").unwrap();assert!(apply(root.path(),"reference",&bad).is_err());assert_eq!(std::fs::read(root.path().join("gameplay-reference.image")).unwrap(),bytes);
 remove(root.path(),"reference").unwrap();assert_eq!(current(root.path(),"reference").unwrap(),None);assert!(root.path().join("images").join(file).exists());
}}
