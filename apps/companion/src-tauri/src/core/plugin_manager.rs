//! Official plugin orchestration. Files/crypto live in the lightweight manager crate;
//! every child uses the existing PluginHost. Never locks AppState or touches Dota.
use super::plugin_runtime::{PluginHost, Phase, Snapshot};
use companion_plugin_manager::{self as packages, Catalog, Installed, Manifest, Release, Store, TRUSTED_KEY};
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeMap, io::Write, path::PathBuf, sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::Manager;

const CATALOG_URL: &str = "https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/catalog-v1/catalog.json";
const CATALOG_SIGNATURE_URL: &str = "https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/catalog-v1/catalog.minisig";
const SEED: &[u8] = include_bytes!("../../../../../plugins/catalog/catalog.json");
const SEED_SIG: &str = include_str!("../../../../../plugins/catalog/catalog.minisig");

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer { pub busy: bool, pub id: Option<String>, pub received: u64, pub total: Option<u64>, pub stage: String, pub error: Option<String> }
struct Service {
    store: Store, catalog: Catalog, hosts: BTreeMap<String, PluginHost>,
    manifests: BTreeMap<String, Manifest>, errors: BTreeMap<String, String>, catalog_error: Option<String>,
}
#[derive(Clone)]
pub struct PluginManager {
    service: Arc<Mutex<Result<Service, String>>>,
    transfer: Arc<Mutex<Transfer>>, cancel: Arc<AtomicBool>, busy: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row { id: String, installed: Installed, manifest: Option<Manifest>, runtime: Option<Snapshot>, error: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View { installed: Vec<Row>, catalog: Vec<Release>, catalog_error: Option<String>, transfer: Transfer, error: Option<String>, local_install_allowed: bool }
fn locked() -> String { "plugin_manager_lock_poisoned".into() }
impl Service {
    fn running(&self, id: &str) -> bool {
        self.hosts.get(id).is_some_and(|host| host.0.lock().map(|mut r| matches!(r.snapshot().phase, Phase::Running | Phase::Starting)).unwrap_or(true))
    }
    fn start(&mut self, id: &str) -> Result<(), String> {
        // Iteration 4 packages are replay-only. Built-in Dota owns all live effects/listeners.
        // Fail closed even if a user edits the registry to enable dota2.
        if id == "dota2" { return Err("dota_live_activation_deferred".into()); }
        if self.running(id) { return Err("already_running".into()); }
        self.store.activate(id)?;
        let installed = self.store.installed().get(id).cloned().ok_or("not_installed")?;
        if !installed.enabled { return Err("plugin_disabled".into()); }
        let (executable, manifest) = self.store.executable(id, &installed.active)?;
        let host = self.hosts.entry(id.to_string()).or_insert_with(PluginHost::new);
        host.0.lock().map_err(|_| locked())?.start_expected(&executable, &[], id, Some(&manifest.version))?;
        self.manifests.insert(id.to_string(), manifest); self.errors.remove(id);
        Ok(())
    }
    fn stop(&mut self, id: &str) -> Result<(), String> {
        let stopped = if let Some(host) = self.hosts.get(id) { host.0.lock().map_err(|_| locked())?.stop().map(|_| ()) } else { Ok(()) };
        // Runtime stop reaps the child even on timeout/error. Activation is safe after failure too.
        self.store.activate(id)?;
        if let Some(p) = self.store.installed().get(id) {
            if let Ok(m) = self.store.manifest(id, &p.active) { self.manifests.insert(id.to_string(), m); }
        }
        stopped
    }
}
impl PluginManager {
    fn unavailable(error: String) -> Self {
        Self { service: Arc::new(Mutex::new(Err(error))), transfer: Arc::new(Mutex::new(Transfer::default())), cancel: Arc::new(AtomicBool::new(false)), busy: Arc::new(AtomicBool::new(false)), shutting_down: Arc::new(AtomicBool::new(false)) }
    }
    pub fn open(root: PathBuf) -> Self {
        let service = (|| {
            let store = Store::open(root, TRUSTED_KEY)?;
            let mut catalog_error = None;
            let catalog = match std::fs::read(store.root().join("catalog.json")).and_then(|b| std::fs::read_to_string(store.root().join("catalog.minisig")).map(|s| (b,s))) {
                Ok((b,s)) => match packages::catalog(&b, &s, TRUSTED_KEY) {
                    Ok(c) => c, Err(e) => { catalog_error = Some(format!("cached_catalog: {e}")); packages::catalog(SEED, SEED_SIG, TRUSTED_KEY)? }
                },
                Err(_) => packages::catalog(SEED, SEED_SIG, TRUSTED_KEY)?,
            };
            let mut service = Service { store, catalog, hosts: BTreeMap::new(), manifests: BTreeMap::new(), errors: BTreeMap::new(), catalog_error };
            for (id, p) in service.store.installed() {
                match service.store.verify(&id, &p.active) {
                    Ok(m) => { service.manifests.insert(id, m); },
                    Err(error) => { service.errors.insert(id, error); },
                }
            }
            Ok(service)
        })();
        Self { service: Arc::new(Mutex::new(service)), transfer: Arc::new(Mutex::new(Transfer::default())), cancel: Arc::new(AtomicBool::new(false)), busy: Arc::new(AtomicBool::new(false)), shutting_down: Arc::new(AtomicBool::new(false)) }
    }
    pub fn restore(&self) {
        if let Ok(mut guard) = self.service.lock() {
            if let Ok(service) = guard.as_mut() {
                for (id,p) in service.store.installed() {
                    if self.shutting_down.load(Ordering::SeqCst) { return; }
                    if p.enabled { if let Err(e) = service.start(&id) { service.errors.insert(id, e); } }
                }
            }
        }
    }
    pub fn view(&self) -> View {
        let transfer = self.transfer.lock().map(|p| p.clone()).unwrap_or_default();
        let local_install_allowed = cfg!(debug_assertions);
        let mut view = View { installed: Vec::new(), catalog: Vec::new(), catalog_error: None, transfer, error: None, local_install_allowed };
        let Ok(guard) = self.service.lock() else { view.error = Some(locked()); return view; };
        match guard.as_ref() {
            Err(e) => view.error = Some(e.clone()),
            Ok(service) => {
                view.catalog = service.catalog.releases.iter().filter(|r| r.manifest.platform == std::env::consts::OS && r.manifest.arch == std::env::consts::ARCH).cloned().collect();
                view.catalog_error = service.catalog_error.clone();
                view.installed = service.store.installed().into_iter().map(|(id, installed)| {
                    let runtime = service.hosts.get(&id).and_then(|h| h.0.lock().ok().map(|mut r| r.snapshot()));
                    Row { manifest: service.manifests.get(&id).cloned(), error: service.errors.get(&id).cloned().or_else(|| installed.last_error.clone()), id, installed, runtime }
                }).collect();
            }
        }
        view
    }
    fn begin(&self, id: Option<String>, stage: &str) -> Result<(), String> {
        if self.shutting_down.load(Ordering::SeqCst) { return Err("plugin_manager_stopping".into()); }
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err("transfer_in_progress".into()); }
        self.cancel.store(false, Ordering::SeqCst);
        *self.transfer.lock().map_err(|_| locked())? = Transfer { busy: true, id, stage: stage.into(), ..Transfer::default() };
        Ok(())
    }
    fn finish(&self, result: &Result<(), String>) {
        if let Ok(mut t) = self.transfer.lock() { t.busy = false; t.stage = if result.is_ok() { "complete" } else { "failed" }.into(); t.error = result.as_ref().err().cloned(); }
        self.busy.store(false, Ordering::SeqCst);
    }
    fn fetch(&self, url: &str, limit: u64) -> Result<Vec<u8>, String> {
        let url = official_url(url)?;
        let cancel = self.cancel.clone();
        let (tx, rx) = mpsc::sync_channel(2);
        // A slow TLS/read never holds the manager lock or prevents UI cancellation.
        // Dropping the receiver discards the response; the bounded worker exits on its next read/timeout.
        std::thread::spawn(move || {
            let result = (|| {
                let mut response = client()?.get(url).send().and_then(|r| r.error_for_status()).map_err(|e| format!("download_failed: {e}"))?;
                if response.content_length().is_some_and(|n| n > limit) { return Err("download_too_large".into()); }
                tx.send(Ok(Packet::Size(response.content_length()))).map_err(|_| "cancelled")?;
                packages::download(&mut response, ChunkWriter(tx.clone()), &cancel, limit, |_| {})?;
                Ok(())
            })();
            let _ = tx.send(result.map(|_| Packet::Done));
        });
        receive_download(rx, &self.cancel, limit, |received, total| {
            if let Ok(mut t) = self.transfer.lock() { t.received = received; t.total = total; }
        })
    }
    pub fn refresh(&self) -> Result<(), String> {
        self.begin(None, "catalog")?;
        let result: Result<(), String> = (|| {
            let bytes = self.fetch(CATALOG_URL, packages::MAX_METADATA as u64)?;
            let sig = String::from_utf8(self.fetch(CATALOG_SIGNATURE_URL, 4096)?).map_err(|e| e.to_string())?;
            let catalog = packages::catalog(&bytes, &sig, TRUSTED_KEY)?;
            for release in &catalog.releases { official_url(&release.url)?; }
            let mut guard = self.service.lock().map_err(|_| locked())?;
            let service = guard.as_mut().map_err(|e| e.clone())?;
            // Cache may be absent/partially replaced after power loss; it is always reverified at boot.
            std::fs::write(service.store.root().join("catalog.json"), &bytes).map_err(|e| e.to_string())?;
            std::fs::write(service.store.root().join("catalog.minisig"), &sig).map_err(|e| e.to_string())?;
            service.catalog = catalog; service.catalog_error = None; Ok(())
        })();
        if let Err(e) = &result { if let Ok(mut guard) = self.service.lock() { if let Ok(s) = guard.as_mut() { s.catalog_error = Some(e.clone()); } } }
        self.finish(&result); result
    }
    pub fn install(&self, id: &str, version: &str, local: Option<PathBuf>) -> Result<(), String> {
        self.begin(Some(id.to_string()), "download")?;
        let result = (|| {
            if local.is_some() && !cfg!(debug_assertions) { return Err("local_install_disabled".into()); }
            let release = {
                let guard = self.service.lock().map_err(|_| locked())?; let service = guard.as_ref().map_err(|e| e.clone())?;
                service.catalog.releases.iter().find(|r| r.manifest.id == id && r.manifest.version == version && r.manifest.compatible().is_ok()).cloned().ok_or("release_not_available")?
            };
            let bytes = if let Some(path) = local {
                let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
                let mut bytes = Vec::new(); packages::download(file, &mut bytes, &self.cancel, packages::MAX_PACKAGE, |_| {})?; bytes
            } else { self.fetch(&release.url, packages::MAX_PACKAGE)? };
            if let Ok(mut t) = self.transfer.lock() { t.stage = "verify_install".into(); }
            let mut guard = self.service.lock().map_err(|_| locked())?; let service = guard.as_mut().map_err(|e| e.clone())?;
            let running = service.running(id);
            service.store.install(&bytes, &release, running, &self.cancel)?;
            let active = service.store.installed()[id].active.clone();
            let manifest = service.store.manifest(id, &active)?;
            service.manifests.insert(id.to_string(), manifest); service.errors.remove(id);
            Ok(())
        })();
        self.finish(&result); result
    }
    pub fn action(&self, id: &str, action: &str) -> Result<(), String> {
        if self.busy.load(Ordering::SeqCst) { return Err("transfer_in_progress".into()); }
        let mut guard = self.service.lock().map_err(|_| locked())?; let service = guard.as_mut().map_err(|e| e.clone())?;
        if self.shutting_down.load(Ordering::SeqCst) { return Err("plugin_manager_stopping".into()); }
        let result = match action {
            "start" => service.start(id), "stop" => service.stop(id),
            "enable" => { if id == "dota2" { Err("dota_live_activation_deferred".into()) } else { service.store.enable(id, true).and_then(|_| service.start(id)) } },
            "disable" => service.store.enable(id, false).and_then(|_| service.stop(id)),
            "remove" => service.stop(id).and_then(|_| service.store.remove(id)).map(|_| { service.hosts.remove(id); service.manifests.remove(id); }),
            "rollback" => { if service.running(id) { Err("stop_before_rollback".into()) } else { service.store.activate(id).and_then(|_| service.store.rollback(id)).map(|_| { if let Ok(m) = service.store.manifest(id, &service.store.installed()[id].active) { service.manifests.insert(id.to_string(), m); } }) } },
            _ => Err("unknown_plugin_action".into()),
        };
        match &result { Ok(_) => { service.errors.remove(id); }, Err(e) => { service.errors.insert(id.to_string(), e.clone()); } }
        result
    }
    pub fn command(&self, id: &str, name: String, args: Value) -> Result<Value, String> {
        if id != "hello" || name != "greet" { return Err("command_not_allowed".into()); }
        let host = { let guard = self.service.lock().map_err(|_| locked())?; guard.as_ref().map_err(|e| e.clone())?.hosts.get(id).cloned().ok_or("not_running")? };
        let result = host.0.lock().map_err(|_| locked())?.command(name, args); result
    }
    pub fn asset(&self, path: &str) -> Result<(Vec<u8>, &'static str), String> {
        let mut parts = path.trim_start_matches('/').splitn(3, '/');
        let id = parts.next().ok_or("missing_id")?; let version = parts.next().ok_or("missing_version")?; let asset = parts.next().ok_or("missing_asset")?;
        let guard = self.service.lock().map_err(|_| locked())?; let service = guard.as_ref().map_err(|e| e.clone())?;
        let installed = service.store.installed().get(id).cloned().ok_or("not_installed")?;
        if installed.active != version || !installed.enabled || !service.running(id) { return Err("inactive_plugin_ui".into()); }
        let file = service.store.ui_asset(id, version, asset)?;
        crate::plugin_lab::asset(file.parent().ok_or("missing_parent")?, file.file_name().and_then(|s| s.to_str()).ok_or("invalid_asset")?)
    }
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.service.lock() { if let Ok(service) = guard.as_mut() { for h in service.hosts.values() { if let Ok(mut r) = h.0.lock() { let _ = r.stop(); } } } }
    }
}
enum Packet { Size(Option<u64>), Chunk(Vec<u8>), Done }
struct ChunkWriter(mpsc::SyncSender<Result<Packet, String>>);
impl Write for ChunkWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.send(Ok(Packet::Chunk(bytes.to_vec()))).map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "cancelled"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
fn receive_download(rx: mpsc::Receiver<Result<Packet, String>>, cancel: &AtomicBool, limit: u64, mut progress: impl FnMut(u64, Option<u64>)) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new(); let mut total = None;
    loop {
        if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(Packet::Size(size))) => { total = size; progress(0, total); },
            Ok(Ok(Packet::Chunk(chunk))) => {
                if bytes.len() as u64 + chunk.len() as u64 > limit { return Err("download_too_large".into()); }
                bytes.extend_from_slice(&chunk); progress(bytes.len() as u64, total);
            },
            Ok(Ok(Packet::Done)) => return Ok(bytes),
            Ok(Err(e)) => return Err(e),
            Err(mpsc::RecvTimeoutError::Timeout) => {},
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("download_worker_failed".into()),
        }
    }
}
fn official_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "invalid_download_url")?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() || parsed.port_or_known_default() != Some(443) ||
        !matches!(parsed.host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com")) {
        return Err("non_official_download_url".into());
    }
    Ok(parsed)
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || official_url(attempt.url().as_str()).is_err() { attempt.error("unsafe_redirect") } else { attempt.follow() }
        })).build().map_err(|e| e.to_string())
}
pub fn setup(app: &tauri::AppHandle) {
    let manager = match app.path().app_data_dir() {
        Ok(path) => PluginManager::open(path.join("plugins")),
        Err(e) => PluginManager::unavailable(format!("plugin_data_path_unavailable: {e}")),
    };
    app.manage(manager.clone());
    std::thread::spawn(move || manager.restore());
}
#[tauri::command]
pub async fn plugins_view(app: tauri::AppHandle) -> Result<View, String> {
    let manager = app.try_state::<PluginManager>().ok_or("plugin_manager_unavailable")?.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.view()).await.map_err(|e| e.to_string())
}
#[tauri::command]
pub fn plugins_cancel(app: tauri::AppHandle) -> Result<(), String> {
    app.try_state::<PluginManager>().ok_or("plugin_manager_unavailable")?.cancel.store(true, Ordering::SeqCst); Ok(())
}
#[tauri::command]
pub async fn plugins_refresh(app: tauri::AppHandle) -> Result<(), String> {
    let manager = app.try_state::<PluginManager>().ok_or("plugin_manager_unavailable")?.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.refresh()).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_install(app: tauri::AppHandle, id: String, version: String, local: Option<String>) -> Result<(), String> {
    let manager = app.try_state::<PluginManager>().ok_or("plugin_manager_unavailable")?.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.install(&id, &version, local.map(PathBuf::from))).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_action(app: tauri::AppHandle, id: String, action: String) -> Result<(), String> {
    let manager = app.try_state::<PluginManager>().ok_or("plugin_manager_unavailable")?.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.action(&id, &action)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_command(app: tauri::AppHandle, id: String, name: String, args: Value) -> Result<Value, String> {
    let manager = app.try_state::<PluginManager>().ok_or("plugin_manager_unavailable")?.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.command(&id, name, args)).await.map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn dota_cannot_be_enabled_started_or_restored_as_a_live_runtime() {
        let dir = tempfile::tempdir().unwrap(); let manager = PluginManager::open(dir.path().join("plugins"));
        assert_eq!(manager.action("dota2", "enable").unwrap_err(), "dota_live_activation_deferred");
        assert_eq!(manager.action("dota2", "start").unwrap_err(), "dota_live_activation_deferred");
        let mut guard = manager.service.lock().unwrap(); let service = guard.as_mut().unwrap();
        assert_eq!(service.start("dota2").unwrap_err(), "dota_live_activation_deferred");
        assert!(!service.hosts.contains_key("dota2"));
    }
    #[test] fn cancel_does_not_wait_for_stalled_network_read() {
        let (tx, rx) = mpsc::sync_channel(2);
        let cancel = Arc::new(AtomicBool::new(false)); let worker = cancel.clone();
        std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(50)); worker.store(true, Ordering::SeqCst); });
        let start = std::time::Instant::now();
        assert_eq!(receive_download(rx, &cancel, 100, |_,_| {}).unwrap_err(), "cancelled");
        assert!(start.elapsed() < Duration::from_secs(1)); drop(tx);
    }
    #[test] fn only_official_https_redirects_are_allowed() {
        for url in ["http://github.com/x", "https://github.com.evil/x", "https://evil.com", "https://github.com:444/x", "https://user@github.com/x", "file:///tmp/x"] { assert!(official_url(url).is_err()); }
        assert!(official_url(CATALOG_URL).is_ok());
        assert!(official_url("https://release-assets.githubusercontent.com/x?token=abc").is_ok());
    }
    #[test] fn empty_registry_is_available_offline_and_errors_are_isolated() {
        let dir = tempfile::tempdir().unwrap(); let manager = PluginManager::open(dir.path().join("plugins"));
        assert!(manager.view().error.is_none()); assert!(manager.view().installed.is_empty());
        assert_eq!(manager.view().catalog.len(), 1);
        assert!(manager.action("dota", "start").is_err());
        assert!(manager.view().error.is_none());
    }
    #[test]
    #[ignore = "requires the locally prepared official signed Hello package; run explicitly after packaging"]
    fn signed_hello_lifecycle_restores_without_touching_core() {
        if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" { return; }
        let package = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/packages/hello-0.1.0-macos-aarch64.zip");
        assert!(package.is_file(), "Prepare the signed Hello package with plugins/tools/package.py first");
        let core = crate::state::AppState::new();
        core.0.lock().unwrap().core.twitch_chat = Some(serde_json::json!({"connected":true}));
        let before = serde_json::to_value(core.snapshot()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("plugins");
        let manager = PluginManager::open(root.clone());
        manager.install("hello", "0.1.0", Some(package)).unwrap();
        manager.action("hello", "start").unwrap();
        assert_eq!(manager.command("hello", "greet".into(), serde_json::json!({"text":"store"})).unwrap()["text"], "Hello, store!");
        assert!(manager.asset("/hello/0.1.0/index.html").is_ok());
        assert!(manager.asset("/hello/0.1.0/../manifest.json").is_err());
        manager.action("hello", "disable").unwrap();
        assert!(manager.asset("/hello/0.1.0/index.html").is_err());
        manager.shutdown(); drop(manager);
        let manager = PluginManager::open(root); manager.restore();
        assert!(!manager.view().installed[0].installed.enabled);
        manager.action("hello", "enable").unwrap(); manager.shutdown(); drop(manager);
        let manager = PluginManager::open(dir.path().join("plugins")); manager.restore();
        assert_eq!(manager.view().installed[0].runtime.as_ref().unwrap().phase, Phase::Running);
        assert_eq!(serde_json::to_value(core.snapshot()).unwrap(), before);
        manager.action("hello", "remove").unwrap();
        assert!(manager.view().installed.is_empty());
        manager.shutdown();
        assert!(manager.action("hello", "start").is_err());
    }
}
