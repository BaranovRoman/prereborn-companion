//! OBS Browser Source for the session widget: http://127.0.0.1:3667/pubg/widget.
//! Serves only the signed packaged renderer and the last published projection;
//! request threads never read settings, history or any supplied path.
use companion_plugin_protocol::PackageBinding;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex}, time::Duration};

pub const ADDRESS: &str = "127.0.0.1:3667";
pub const URL: &str = "http://127.0.0.1:3667/pubg/widget";
const RENDERER: &str = "ui/widget/index.html";
const MAX_CLIENTS: usize = 8;

pub struct Server {
    http: Arc<tiny_http::Server>,
    state: Arc<Mutex<Option<Arc<Vec<u8>>>>>,
    closed: Arc<AtomicBool>,
    clients: Arc<AtomicUsize>,
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}
fn reply(request: tiny_http::Request, status: u16, mime: &str, bytes: Vec<u8>) {
    let _ = request.respond(tiny_http::Response::from_data(bytes).with_status_code(status)
        .with_header(header("Content-Type", mime)).with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header("Cache-Control", "no-store")).with_header(header("X-Content-Type-Options", "nosniff")));
}
fn read_file(root: &Path, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    companion_plugin_manager::safe_path(name)?;
    let root = root.canonicalize().map_err(|_| "widget_asset_unavailable")?;
    let file = root.join(name);
    let metadata = file.symlink_metadata().map_err(|_| "widget_asset_unavailable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit
        || !file.canonicalize().map_err(|_| "widget_asset_unavailable")?.starts_with(&root) {
        return Err("widget_asset_invalid".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(file).map_err(|_| "widget_asset_unavailable")?.take(limit + 1).read_to_end(&mut bytes).map_err(|_| "widget_asset_unavailable")?;
    if bytes.len() as u64 > limit { return Err("widget_asset_limit".into()); }
    Ok(bytes)
}
/// The renderer must be the file the verified launch manifest signed.
pub(crate) fn renderer(root: &Path, executable: &Path, package: &PackageBinding) -> Result<Arc<Vec<u8>>, String> {
    let manifest: companion_plugin_manager::Manifest = serde_json::from_slice(&read_file(root, "manifest.json", companion_plugin_manager::MAX_METADATA as u64)?)
        .map_err(|_| "widget_manifest_invalid")?;
    manifest.validate()?;
    let manifest_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&manifest).map_err(|_| "widget_manifest_invalid")?));
    if manifest.id != package.id || manifest.version != package.version || manifest_hash != package.manifest_hash
        || manifest.files.get(&manifest.executable) != Some(&package.executable_hash)
        || root.join(&manifest.executable).canonicalize().map_err(|_| "widget_manifest_invalid")? != executable.canonicalize().map_err(|_| "widget_manifest_invalid")? {
        return Err("widget_package_binding_mismatch".into());
    }
    let bytes = read_file(root, RENDERER, 4 * 1024 * 1024)?;
    if manifest.files.get(RENDERER) != Some(&format!("{:x}", Sha256::digest(&bytes))) {
        return Err("widget_payload_checksum_mismatch".into());
    }
    Ok(Arc::new(bytes))
}

impl Server {
    pub fn bind(package: &PackageBinding) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|_| "widget_package_unavailable")?;
        let root = executable.parent().and_then(Path::parent).ok_or("widget_package_unavailable")?;
        Self::start(ADDRESS, renderer(root, &executable, package)?)
    }
    pub(crate) fn start(address: &str, renderer: Arc<Vec<u8>>) -> Result<Self, String> {
        let http = Arc::new(tiny_http::Server::http(address).map_err(|e| {
            format!("widget_bind_failed:os={}", e.downcast_ref::<std::io::Error>().and_then(std::io::Error::raw_os_error).unwrap_or(0))
        })?);
        let server = Self { http: http.clone(), state: Default::default(), closed: Default::default(), clients: Default::default() };
        let (state, closed, clients) = (server.state.clone(), server.closed.clone(), server.clients.clone());
        std::thread::spawn(move || while !closed.load(Ordering::SeqCst) {
            let request = match http.recv_timeout(Duration::from_millis(100)) {
                Ok(Some(request)) => request,
                Ok(None) => continue,
                Err(_) => { closed.store(true, Ordering::SeqCst); break; }
            };
            if clients.fetch_add(1, Ordering::SeqCst) >= MAX_CLIENTS {
                clients.fetch_sub(1, Ordering::SeqCst);
                reply(request, 503, "application/json", br#"{"error":"widget_client_limit"}"#.to_vec());
                continue;
            }
            let (state, clients, renderer) = (state.clone(), clients.clone(), renderer.clone());
            std::thread::spawn(move || { serve(request, &renderer, &state); clients.fetch_sub(1, Ordering::SeqCst); });
        });
        Ok(server)
    }
    pub fn publish(&self, state: &serde_json::Value) -> Result<(), String> {
        if self.closed() { return Err("widget_closed".into()); }
        let bytes = serde_json::to_vec(state).map_err(|_| "widget_encoding_failed")?;
        if bytes.len() > 64 * 1024 { return Err("widget_projection_limit".into()); }
        *self.state.lock().map_err(|_| "widget_state_poisoned")? = Some(Arc::new(bytes));
        Ok(())
    }
    pub fn clients(&self) -> usize { self.clients.load(Ordering::SeqCst) }
    pub fn closed(&self) -> bool { self.closed.load(Ordering::SeqCst) }
    pub fn stop(&self) { self.closed.store(true, Ordering::SeqCst); self.http.unblock(); }
}
impl Drop for Server { fn drop(&mut self) { self.stop(); } }

fn serve(request: tiny_http::Request, renderer: &[u8], state: &Mutex<Option<Arc<Vec<u8>>>>) {
    if request.url().len() > 2048 { reply(request, 414, "application/json", vec![]); return; }
    if request.method() != &tiny_http::Method::Get { reply(request, 405, "application/json", vec![]); return; }
    let path = request.url().split('?').next().unwrap_or("").to_string();
    match path.as_str() {
        "/pubg/widget" | "/pubg/widget/" => reply(request, 200, "text/html; charset=utf-8", renderer.to_vec()),
        "/pubg/widget/state" => match state.lock().ok().and_then(|s| s.clone()) {
            Some(bytes) => reply(request, 200, "application/json; charset=utf-8", bytes.to_vec()),
            None => reply(request, 503, "application/json", br#"{"error":"widget_state_unavailable"}"#.to_vec()),
        },
        _ => reply(request, 404, "application/json", vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn renderer_must_match_the_launch_manifest_and_cannot_escape_the_package() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("bin")).unwrap();
        std::fs::create_dir_all(root.path().join("ui/widget")).unwrap();
        let executable = root.path().join("bin/worker");
        std::fs::write(&executable, b"unit executable").unwrap();
        std::fs::write(root.path().join("ui/index.html"), b"ui").unwrap();
        std::fs::write(root.path().join(RENDERER), b"packaged widget").unwrap();
        let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
        let manifest: companion_plugin_manager::Manifest = serde_json::from_value(json!({"schema":1,"id":"pubg","name":"PUBG","description":"test","version":"0.1.0","platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"minApi":2,"maxApi":2,"execution":"live","permissions":["ui","data.private","backend.access","overlay.publish"],"executable":"bin/worker","ui":"ui/index.html","files":{"bin/worker":hash(b"unit executable"),"ui/index.html":hash(b"ui"),"ui/widget/index.html":hash(b"packaged widget")}})).unwrap();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let package = PackageBinding { id: "pubg".into(), version: "0.1.0".into(), executable_hash: hash(b"unit executable"), manifest_hash: hash(&bytes) };
        std::fs::write(root.path().join("manifest.json"), bytes).unwrap();
        assert_eq!(renderer(root.path(), &executable, &package).unwrap().as_slice(), b"packaged widget");
        let mut wrong = package.clone(); wrong.manifest_hash = "b".repeat(64);
        assert_eq!(renderer(root.path(), &executable, &wrong).unwrap_err(), "widget_package_binding_mismatch");
        std::fs::write(root.path().join(RENDERER), b"tampered").unwrap();
        assert_eq!(renderer(root.path(), &executable, &package).unwrap_err(), "widget_payload_checksum_mismatch");
        assert!(read_file(root.path(), "../secret", 1024).is_err());
    }
    #[test]
    fn http_routes_serve_only_the_renderer_and_the_published_projection() {
        use std::{io::{Read, Write}, net::TcpStream};
        let server = Server::start("127.0.0.1:0", Arc::new(b"packaged widget".to_vec())).unwrap();
        let address = server.http.server_addr().to_ip().unwrap();
        let get = |method: &str, path: &str| {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            write!(stream, "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
            let mut response = String::new(); stream.read_to_string(&mut response).unwrap(); response
        };
        assert!(get("GET", "/pubg/widget/state").starts_with("HTTP/1.1 503"));
        server.publish(&json!({"enabled":true,"matches":[{"map":"Erangel"}]})).unwrap();
        assert!(get("GET", "/pubg/widget/state").contains("Erangel"));
        assert!(get("GET", "/pubg/widget").contains("packaged widget"));
        for path in ["/settings.json", "/pubg/../settings.json", "/history.json"] { assert!(get("GET", path).starts_with("HTTP/1.1 404")); }
        assert!(get("POST", "/pubg/widget/state").starts_with("HTTP/1.1 405"));
        server.stop();
        std::thread::sleep(Duration::from_millis(250));
        assert!(server.closed());
        assert!(server.publish(&json!({})).is_err());
    }
}
