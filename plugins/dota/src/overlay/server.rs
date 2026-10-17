//! Relocated loopback HTTP/SSE transport. The worker publishes a projection;
//! request threads never open SQLite, parse GSI or access account credentials.
use super::OverlayStateSnapshot;
use companion_plugin_protocol::PackageBinding;
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::{io::{Read,Write},path::Path,sync::{Arc,Mutex,atomic::{AtomicBool,AtomicUsize,Ordering}},time::Duration};
type Result<T>=std::result::Result<T,String>;
const MAX_CLIENTS:usize=8;
#[derive(Default)]
struct Cache{state:Option<Arc<Vec<u8>>>,identity:Option<[u8;32]>,revision:u64,layout:Option<Value>,queue:Option<Value>}
pub struct Server{http:Arc<tiny_http::Server>,cache:Arc<Mutex<Cache>>,closed:Arc<AtomicBool>,clients:Arc<AtomicUsize>}
fn header(name:&str,value:&str)->tiny_http::Header{tiny_http::Header::from_bytes(name.as_bytes(),value.as_bytes()).unwrap()}
fn reply(request:tiny_http::Request,status:u16,mime:&str,bytes:Vec<u8>){
 let _=request.respond(tiny_http::Response::from_data(bytes).with_status_code(status).with_header(header("Content-Type",mime)).with_header(header("Access-Control-Allow-Origin","*")).with_header(header("Cache-Control","no-store")).with_header(header("X-Content-Type-Options","nosniff")));
}
fn read(root:&Path,name:&str,limit:u64)->Result<Vec<u8>>{
 companion_plugin_manager::safe_path(name)?;
 let root=root.canonicalize().map_err(|_|"overlay_asset_unavailable")?;let file=root.join(name);
 let metadata=file.symlink_metadata().map_err(|_|"overlay_asset_unavailable")?;
 if !metadata.is_file()||metadata.file_type().is_symlink()||metadata.len()>limit||!file.canonicalize().map_err(|_|"overlay_asset_unavailable")?.starts_with(&root){return Err("overlay_asset_invalid".into());}
 let mut bytes=Vec::new();std::fs::File::open(file).map_err(|_|"overlay_asset_unavailable")?.take(limit+1).read_to_end(&mut bytes).map_err(|_|"overlay_asset_unavailable")?;
 if bytes.len() as u64>limit{return Err("overlay_asset_limit".into());}Ok(bytes)
}
fn renderer(root:&Path,executable:&Path,package:&PackageBinding)->Result<Arc<Vec<u8>>>{
 let manifest:companion_plugin_manager::Manifest=serde_json::from_slice(&read(root,"manifest.json",companion_plugin_manager::MAX_METADATA as u64)?).map_err(|_|"overlay_manifest_invalid")?;
 manifest.validate()?;
 let manifest_hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&manifest).map_err(|_|"overlay_manifest_invalid")?));
 if manifest.id!=package.id||manifest.version!=package.version||manifest_hash!=package.manifest_hash||manifest.files.get(&manifest.executable)!=Some(&package.executable_hash)
  ||root.join(&manifest.executable).canonicalize().map_err(|_|"overlay_manifest_invalid")?!=executable.canonicalize().map_err(|_|"overlay_manifest_invalid")?{return Err("overlay_package_binding_mismatch".into());}
 let bytes=read(root,"ui/overlay/index.html",32*1024*1024)?;
 if manifest.files.get("ui/overlay/index.html")!=Some(&format!("{:x}",Sha256::digest(&bytes))){return Err("overlay_payload_checksum_mismatch".into());}Ok(Arc::new(bytes))
}
impl Server{
 pub fn bind(data_root:&Path,package:&PackageBinding)->Result<Self>{
  let executable=std::env::current_exe().map_err(|_|"overlay_package_unavailable")?;
  let root=executable.parent().and_then(Path::parent).ok_or("overlay_package_unavailable")?;
  Self::start(data_root,"127.0.0.1:3666",renderer(root,&executable,package)?)
 }
 fn start(data_root:&Path,address:&str,renderer:Arc<Vec<u8>>)->Result<Self>{
  let http=Arc::new(tiny_http::Server::http(address).map_err(|e|format!("overlay_bind_failed:os={}",e.downcast_ref::<std::io::Error>().and_then(std::io::Error::raw_os_error).unwrap_or(0)))?);
  let cache=Arc::new(Mutex::new(Cache::default()));let closed=Arc::new(AtomicBool::new(false));let clients=Arc::new(AtomicUsize::new(0));
  let server=Self{http:http.clone(),cache:cache.clone(),closed:closed.clone(),clients:clients.clone()};let data_root=data_root.to_path_buf();
  std::thread::spawn(move||while !closed.load(Ordering::SeqCst){
   let request=match http.recv_timeout(Duration::from_millis(100)){Ok(Some(r))=>r,Ok(None)=>continue,Err(_)=>{closed.store(true,Ordering::SeqCst);break;}};
   if closed.load(Ordering::SeqCst){break;}
   if clients.fetch_add(1,Ordering::SeqCst)>=MAX_CLIENTS{clients.fetch_sub(1,Ordering::SeqCst);reply(request,503,"application/json",br#"{"error":"overlay_client_limit"}"#.to_vec());continue;}
   let (cache,closed,clients,renderer,root)=(cache.clone(),closed.clone(),clients.clone(),renderer.clone(),data_root.clone());
   std::thread::spawn(move||{let _client=Client(clients);serve(request,&root,&renderer,&cache,&closed);});
  });Ok(server)
 }
 pub fn publish(&self,state:&OverlayStateSnapshot,layout:Option<Value>,queue:Option<Value>)->Result<()>{
  if self.closed.load(Ordering::SeqCst){return Err("overlay_closed".into());}
  // This is a renderer config cache key, never a persisted match revision or
  // write precondition. Content identity survives worker restart without
  // reusing an old in-memory counter for a different saved layout.
  let config=serde_json::to_vec(&(&layout,&queue)).map_err(|_|"overlay_encoding_failed")?;
  let digest=Sha256::digest(&config);let version=digest[..6].iter().fold(0u64,|n,b|(n<<8)|u64::from(*b));
  let mut state=state.clone();state.layout_version=version;
  let bytes=serde_json::to_vec(&state).map_err(|_|"overlay_encoding_failed")?;
  if bytes.len()>256*1024||serde_json::to_vec(&layout).map_err(|_|"overlay_encoding_failed")?.len()>1024*1024||serde_json::to_vec(&queue).map_err(|_|"overlay_encoding_failed")?.len()>128*1024{return Err("overlay_projection_limit".into());}
  let mut comparable=state.clone();comparable.updated_at.clear();let identity=Sha256::digest(serde_json::to_vec(&comparable).map_err(|_|"overlay_encoding_failed")?).into();
  let mut cache=self.cache.lock().map_err(|_|"overlay_cache_poisoned")?;
  if cache.identity!=Some(identity){cache.revision=cache.revision.checked_add(1).ok_or("overlay_revision_exhausted")?;cache.identity=Some(identity);}
  cache.state=Some(Arc::new(bytes));cache.layout=layout;cache.queue=queue;Ok(())
 }
 pub fn clients(&self)->usize{self.clients.load(Ordering::SeqCst)}
 pub fn closed(&self)->bool{self.closed.load(Ordering::SeqCst)}
 pub fn stop(&self){self.closed.store(true,Ordering::SeqCst);self.http.unblock();}
}
impl Drop for Server{fn drop(&mut self){self.stop();}}
struct Client(Arc<AtomicUsize>);
impl Drop for Client{fn drop(&mut self){self.0.fetch_sub(1,Ordering::SeqCst);}}
fn serve(request:tiny_http::Request,root:&Path,renderer:&[u8],cache:&Mutex<Cache>,closed:&AtomicBool){
 if request.url().len()>2048{reply(request,414,"application/json",vec![]);return;}
 let path=request.url().split('?').next().unwrap_or("").to_string();
 if request.method()!=&tiny_http::Method::Get{reply(request,405,"application/json",vec![]);return;}
 if path=="/overlay/events"{sse(request,cache,closed);return;}
 let bytes=match path.as_str(){
  "/overlay"|"/overlay/"=>{reply(request,200,"text/html; charset=utf-8",renderer.to_vec());return;},
  "/overlay/state"=>cache.lock().ok().and_then(|c|c.state.as_ref().map(|s|s.as_ref().clone())),
  "/overlay/layout"=>cache.lock().ok().and_then(|c|serde_json::to_vec(&c.layout).ok()),
  "/overlay/queue-settings"=>cache.lock().ok().and_then(|c|serde_json::to_vec(&c.queue).ok()),
  "/overlay/renderer-ready"=>Some(br#"{"ok":true}"#.to_vec()),
  "/overlay/assets/webcam-fallback"|"/overlay/assets/gameplay-reference"=>{
   let name=if path.ends_with("webcam-fallback"){"queue-webcam-fallback.image"}else{"gameplay-reference.image"};
   if let Ok(bytes)=read(root,name,10*1024*1024){let Some(mime)=companion_plugin_protocol::media::image_mime(&bytes)else{reply(request,415,"application/json",vec![]);return;};reply(request,200,mime,bytes);return;}None
  },
  _=>{reply(request,404,"application/json",vec![]);return;},
 };
 match bytes{Some(bytes)=>reply(request,200,"application/json; charset=utf-8",bytes),None=>reply(request,503,"application/json",br#"{"error":"overlay_state_unavailable"}"#.to_vec())}
}
fn sse(request:tiny_http::Request,cache:&Mutex<Cache>,closed:&AtomicBool){
 let response=tiny_http::Response::empty(200).with_header(header("Content-Type","text/event-stream")).with_header(header("Access-Control-Allow-Origin","*")).with_header(header("Cache-Control","no-store"));
 let mut stream=request.upgrade("sse",response);let mut last=None;
 while !closed.load(Ordering::SeqCst){
  let next=cache.lock().ok().and_then(|c|if last!=Some(c.revision){c.state.as_ref().map(|s|(c.revision,s.clone()))}else{None});
  if let Some((revision,state))=next{
   if stream.write_all(b"data: ").and_then(|_|stream.write_all(&state)).and_then(|_|stream.write_all(b"\n\n")).and_then(|_|stream.flush()).is_err(){return;}last=Some(revision);
  }
  std::thread::sleep(Duration::from_millis(300));
 }
}
#[cfg(test)]
mod tests{
 use super::*;use serde_json::json;
 fn snapshot()->OverlayStateSnapshot{OverlayStateSnapshot{
  scene:companion_dota_domain::broadcast_state::BroadcastState::BetweenMatches,updated_at:"2026-10-16T00:00:00Z".into(),
  session:Default::default(),layout_version:0,account:None,twitch_chat:None,overlay_visible:true,draft_in_progress:false,opendota_favorite_heroes:None,opendota_radar:None,
 }}
 #[test]
 fn renderer_must_match_the_exact_launch_manifest_and_payload_and_cannot_escape_package(){
  let root=tempfile::tempdir().unwrap();std::fs::create_dir_all(root.path().join("bin")).unwrap();std::fs::create_dir_all(root.path().join("ui/overlay")).unwrap();
  let executable=root.path().join("bin/worker");std::fs::write(&executable,b"unit executable").unwrap();std::fs::write(root.path().join("ui/index.html"),b"ui").unwrap();std::fs::write(root.path().join("ui/overlay/index.html"),b"actual packaged renderer fixture").unwrap();
  let hash=|bytes:&[u8]|format!("{:x}",Sha256::digest(bytes));
  let manifest:companion_plugin_manager::Manifest=serde_json::from_value(json!({"schema":1,"id":"dota2","name":"Dota 2","description":"test","version":"0.2.0","platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"minApi":2,"maxApi":2,"execution":"live","permissions":["ui","data.legacy","overlay.publish"],"executable":"bin/worker","ui":"ui/index.html","files":{"bin/worker":hash(b"unit executable"),"ui/index.html":hash(b"ui"),"ui/overlay/index.html":hash(b"actual packaged renderer fixture")}})).unwrap();
  let bytes=serde_json::to_vec(&manifest).unwrap();let package=PackageBinding{id:"dota2".into(),version:"0.2.0".into(),executable_hash:hash(b"unit executable"),manifest_hash:hash(&bytes)};
  std::fs::write(root.path().join("manifest.json"),bytes).unwrap();assert_eq!(renderer(root.path(),&executable,&package).unwrap().as_slice(),b"actual packaged renderer fixture");
  let mut wrong=package.clone();wrong.manifest_hash="b".repeat(64);assert_eq!(renderer(root.path(),&executable,&wrong).unwrap_err(),"overlay_package_binding_mismatch");
  std::fs::write(root.path().join("ui/overlay/index.html"),b"tampered").unwrap();assert_eq!(renderer(root.path(),&executable,&package).unwrap_err(),"overlay_payload_checksum_mismatch");
  assert!(read(root.path(),"../secret",1024).is_err());
 }
 #[test]
 fn real_http_routes_use_only_published_projection_and_never_touch_history_or_arbitrary_paths(){
  use std::{io::{Read,Write},net::TcpStream};
  let root=tempfile::tempdir().unwrap();std::fs::write(root.path().join("companion-config.json"),br#"{"secret":"not public"}"#).unwrap();
  let server=Server::start(root.path(),"127.0.0.1:0",Arc::new(b"packaged renderer".to_vec())).unwrap();
  let address=server.http.server_addr().to_ip().unwrap();
  let get=|path:&str|{let mut stream=TcpStream::connect(address).unwrap();stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();write!(stream,"GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();let mut response=String::new();stream.read_to_string(&mut response).unwrap();response};
  assert!(get("/overlay/state").starts_with("HTTP/1.1 503"));
  let mut state=snapshot();server.publish(&state,Some(json!({"version":1})),None).unwrap();let revision=server.cache.lock().unwrap().revision;
  state.updated_at="2026-10-16T00:01:00Z".into();server.publish(&state,Some(json!({"version":1})),None).unwrap();assert_eq!(server.cache.lock().unwrap().revision,revision);
  let before:Value=serde_json::from_slice(&server.cache.lock().unwrap().state.clone().unwrap()).unwrap();
  let response=get("/overlay/state");assert!(response.starts_with("HTTP/1.1 200"));assert!(response.contains("betweenMatches"));assert!(!response.contains("secret"));
  assert!(get("/overlay").contains("packaged renderer"));assert!(get("/overlay/layout").contains("\"version\":1"));
  for path in ["/companion-config.json","/../companion-config.json","/overlay/../companion-config.json"]{assert!(get(path).starts_with("HTTP/1.1 404"));}
  server.publish(&state,Some(json!({"version":2})),None).unwrap();let after:Value=serde_json::from_slice(&server.cache.lock().unwrap().state.clone().unwrap()).unwrap();assert_ne!(before["layoutVersion"],after["layoutVersion"]);
  assert_eq!(server.cache.lock().unwrap().revision,revision+1);assert!(!root.path().join("local-runtime.sqlite3").exists());server.stop();
 }
}
