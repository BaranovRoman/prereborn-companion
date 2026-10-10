//! Signed package/registry operations only. Processes stay in the Companion runtime.
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, File}, io::{Read, Write},
    path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use minisign_verify::{PublicKey, Signature};
use companion_plugin_protocol::CORE_API;

pub const TRUSTED_KEY: &str = include_str!("../trusted.pub");
pub const MAX_PACKAGE: u64 = 32 * 1024 * 1024;
pub const MAX_EXPANDED: u64 = 64 * 1024 * 1024;
pub const MAX_METADATA: usize = 128 * 1024;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32, pub id: String, pub name: String, pub description: String,
    pub version: String, pub platform: String, pub arch: String,
    pub min_api: u32, pub max_api: u32, pub executable: String, pub ui: String,
    pub permissions: Vec<String>, pub files: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release { pub manifest: Manifest, pub url: String, pub sha256: String, pub signature: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog { pub schema: u32, pub releases: Vec<Release> }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installed {
    pub active: String, pub previous: Option<String>, pub pending: Option<String>, pub enabled: bool,
    #[serde(default)]
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry { schema: u32, plugins: BTreeMap<String, Installed> }
impl Default for Registry { fn default() -> Self { Self { schema: 1, plugins: BTreeMap::new() } } }

pub fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn checksum(value: &str) -> bool { value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) }
pub fn verify_signature(bytes: &[u8], signature: &str, key: &str) -> Result<()> {
    if signature.len() > 4096 { return Err("signature_too_large".into()); }
    PublicKey::decode(key).map_err(|_| "invalid_trust_key")?
        .verify(bytes, &Signature::decode(signature).map_err(|_| "invalid_signature")?, false)
        .map_err(|_| "invalid_signature".into())
}
pub fn safe_path(value: &str) -> Result<()> {
    if value.len() > 240 || value.split('/').count() > 10 || value.is_empty() { return Err("unsafe_path".into()); }
    for part in value.split('/') {
        // Portable names: also reject Windows device names, ADS, trailing dots/spaces and case aliases.
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty() || part == "." || part == ".." || part.ends_with('.') ||
            !part.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.')) ||
            matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL") ||
            (base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) && base.as_bytes()[3].is_ascii_digit()) {
            return Err("unsafe_path".into());
        }
    }
    Ok(())
}
fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') || id.contains("dota") {
        return Err("invalid_or_reserved_plugin_id".into());
    }
    Ok(())
}
fn valid_version(version: &str) -> Result<()> {
    safe_path(version)?;
    semver::Version::parse(version).map_err(|_| "invalid_version".to_string())?;
    Ok(())
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        valid_id(&self.id)?; valid_version(&self.version)?;
        if self.schema != 1 || self.min_api > self.max_api { return Err("invalid_manifest".into()); }
        if self.name.is_empty() || self.name.len() > 100 || self.description.len() > 1000 { return Err("invalid_description".into()); }
        if !matches!(self.platform.as_str(), "macos" | "windows" | "linux") || !matches!(self.arch.as_str(), "aarch64" | "x86_64") {
            return Err("unsupported_target".into());
        }
        if self.permissions != ["ui"] { return Err("unsupported_permissions".into()); }
        safe_path(&self.executable)?; safe_path(&self.ui)?;
        if !self.executable.starts_with("bin/") || !self.ui.starts_with("ui/") || !self.ui.ends_with(".html") ||
            !self.files.contains_key(&self.executable) || !self.files.contains_key(&self.ui) || self.files.len() > 512 {
            return Err("invalid_payload".into());
        }
        let mut names = BTreeSet::new();
        for (name, digest) in &self.files {
            safe_path(name)?;
            if !checksum(digest) || !names.insert(name.to_ascii_lowercase()) || (!name.starts_with("bin/") && !name.starts_with("ui/")) {
                return Err("invalid_file_inventory".into());
            }
        }
        Ok(())
    }
    pub fn compatible(&self) -> Result<()> {
        self.validate()?;
        if self.min_api > CORE_API || self.max_api < CORE_API { return Err("incompatible_api".into()); }
        if self.platform != std::env::consts::OS || self.arch != std::env::consts::ARCH { return Err("incompatible_platform".into()); }
        Ok(())
    }
}
pub fn catalog(bytes: &[u8], signature: &str, key: &str) -> Result<Catalog> {
    if bytes.len() > MAX_METADATA { return Err("catalog_too_large".into()); }
    verify_signature(bytes, signature, key)?;
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|_| "invalid_catalog")?;
    if catalog.schema != 1 || catalog.releases.len() > 128 { return Err("invalid_catalog".into()); }
    let mut identities = BTreeSet::new();
    for release in &catalog.releases {
        release.manifest.validate()?;
        if !checksum(&release.sha256) || release.signature.len() > 4096 || !identities.insert((release.manifest.id.clone(), release.manifest.version.clone(), release.manifest.platform.clone(), release.manifest.arch.clone())) {
            return Err("invalid_catalog_release".into());
        }
    }
    Ok(catalog)
}

/// Chunk copy is shared by HTTPS and fixture tests. Cancel discards staging, never the active version.
pub fn download<R: Read, W: Write>(mut reader: R, mut writer: W, cancel: &AtomicBool, limit: u64, mut progress: impl FnMut(u64)) -> Result<u64> {
    let mut total = 0;
    let mut buffer = [0; 16384];
    loop {
        if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        let size = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if size == 0 { return Ok(total); }
        total += size as u64;
        if total > limit { return Err("download_too_large".into()); }
        writer.write_all(&buffer[..size]).map_err(|e| e.to_string())?;
        progress(total);
    }
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit { return Err("unsafe_or_oversized_file".into()); }
    fs::read(path).map_err(|e| e.to_string())
}
fn no_symlinks(root: &Path, relative: &str) -> Result<PathBuf> {
    safe_path(relative)?;
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        if fs::symlink_metadata(&path).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("symlink".into()); }
    }
    Ok(path)
}
pub struct Store { root: PathBuf, key: String, registry: Registry }
impl Store {
    pub fn open(root: PathBuf, key: &str) -> Result<Self> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        if fs::symlink_metadata(&root).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("symlink_root".into()); }
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?; }
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        for dir in ["versions", "staging", "data"] {
            fs::create_dir_all(root.join(dir)).map_err(|e| e.to_string())?;
            no_symlinks(&root, dir)?;
        }
        let mut registry = Registry::default();
        let mut found = false;
        for file in ["registry.json", "registry.next", "registry.backup"] {
            let path = root.join(file);
            if !path.exists() { continue; }
            found = true;
            if let Ok(bytes) = read_bounded(&path, MAX_METADATA as u64) {
                if let Ok(candidate) = serde_json::from_slice::<Registry>(&bytes) {
                    if candidate.schema == 1 && candidate.plugins.len() <= 128 && candidate.plugins.iter().all(|(id, p)| {
                        valid_id(id).is_ok() && valid_version(&p.active).is_ok() && p.previous.iter().chain(p.pending.iter()).all(|v| valid_version(v).is_ok())
                    }) { registry = candidate; found = false; break; }
                }
            }
        }
        if found { return Err("registry_corrupt_keep_files_for_recovery".into()); }
        // Staging is disposable: registry points only at fully verified, atomically renamed versions.
        for entry in fs::read_dir(root.join("staging")).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() { fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?; }
            else { fs::remove_file(entry.path()).map_err(|e| e.to_string())?; }
        }
        let mut store = Self { root, key: key.to_string(), registry };
        // No child exists on boot; a pending version can safely become active now.
        let pending: Vec<_> = store.registry.plugins.iter().filter(|(_, p)| p.pending.is_some()).map(|(id, _)| id.clone()).collect();
        for id in pending { let _ = store.activate(&id); }
        for id in store.registry.plugins.keys() { store.prune(id); }
        Ok(store)
    }
    pub fn root(&self) -> &Path { &self.root }
    pub fn installed(&self) -> BTreeMap<String, Installed> { self.registry.plugins.clone() }
    fn transaction(&mut self, update: impl FnOnce(&mut Registry) -> Result<()>) -> Result<()> {
        let mut next = self.registry.clone(); update(&mut next)?;
        let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_METADATA { return Err("registry_full".into()); }
        let pending = self.root.join("registry.next");
        if pending.exists() || fs::symlink_metadata(&pending).is_ok() { fs::remove_file(&pending).map_err(|e| e.to_string())?; }
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&pending).map_err(|e| e.to_string())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        drop(file);
        let primary = self.root.join("registry.json");
        let backup = self.root.join("registry.backup");
        if primary.exists() {
            if backup.exists() { fs::remove_file(&backup).map_err(|e| e.to_string())?; }
            fs::rename(&primary, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&pending, &primary) {
            let _ = fs::remove_file(&pending);
            if backup.exists() && !primary.exists() { let _ = fs::rename(&backup, &primary); }
            return Err(error.to_string());
        }
        self.registry = next;
        Ok(())
    }
    fn version_root(&self, id: &str, version: &str) -> Result<PathBuf> {
        valid_id(id)?; valid_version(version)?;
        no_symlinks(&self.root, &format!("versions/{id}/{version}"))
    }
    pub fn manifest(&self, id: &str, version: &str) -> Result<Manifest> {
        let root = self.version_root(id, version)?;
        let bytes = read_bounded(&root.join("manifest.json"), MAX_METADATA as u64)?;
        let sig = String::from_utf8(read_bounded(&root.join("manifest.minisig"), 4096)?).map_err(|e| e.to_string())?;
        verify_signature(&bytes, &sig, &self.key)?;
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| "invalid_manifest")?;
        manifest.compatible()?;
        if manifest.id != id || manifest.version != version { return Err("manifest_identity_mismatch".into()); }
        Ok(manifest)
    }
    pub fn verify(&self, id: &str, version: &str) -> Result<Manifest> {
        let root = self.version_root(id, version)?;
        let manifest = self.manifest(id, version)?;
        let mut actual = BTreeSet::new(); let mut nodes = 0;
        inventory(&root, "", &mut actual, &mut nodes)?;
        let mut expected: BTreeSet<_> = manifest.files.keys().cloned().collect();
        expected.insert("manifest.json".into()); expected.insert("manifest.minisig".into());
        if actual != expected { return Err("unexpected_installed_files".into()); }
        let mut total = 0;
        for (name, checksum) in &manifest.files {
            let path = no_symlinks(&root, name)?;
            let bytes = read_bounded(&path, MAX_PACKAGE)?;
            total += bytes.len() as u64;
            if total > MAX_EXPANDED || &hash(&bytes) != checksum { return Err("payload_checksum_mismatch".into()); }
        }
        Ok(manifest)
    }
    pub fn executable(&self, id: &str, version: &str) -> Result<(PathBuf, Manifest)> {
        let manifest = self.verify(id, version)?;
        let executable = no_symlinks(&self.version_root(id, version)?, &manifest.executable)?;
        Ok((executable, manifest))
    }
    pub fn ui_asset(&self, id: &str, version: &str, relative: &str) -> Result<PathBuf> {
        let manifest = self.manifest(id, version)?;
        let name = format!("ui/{relative}");
        let checksum = manifest.files.get(&name).ok_or("undeclared_asset")?;
        let path = no_symlinks(&self.version_root(id, version)?, &name)?;
        if &hash(&read_bounded(&path, MAX_PACKAGE)?) != checksum { return Err("payload_checksum_mismatch".into()); }
        Ok(path)
    }
    pub fn install(&mut self, bytes: &[u8], release: &Release, running: bool, cancel: &AtomicBool) -> Result<()> {
        release.manifest.compatible()?;
        if bytes.len() as u64 > MAX_PACKAGE || hash(bytes) != release.sha256 { return Err("package_checksum_mismatch".into()); }
        verify_signature(bytes, &release.signature, &self.key)?;
        if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
        let id = &release.manifest.id; let version = &release.manifest.version;
        if let Some(p) = self.registry.plugins.get(id) {
            if p.pending.is_some() { return Err("pending_update_exists".into()); }
            if semver::Version::parse(version).unwrap() <= semver::Version::parse(&p.active).unwrap() { return Err("use_rollback_for_older_version".into()); }
        }
        if self.root.join("versions").join(id).join(version).exists() {
            let referenced = self.registry.plugins.get(id).is_some_and(|p| p.active == *version || p.previous.as_ref() == Some(version) || p.pending.as_ref() == Some(version));
            if referenced { return Err("version_already_installed".into()); }
            // A crash between directory rename and registry commit can leave an orphan.
            let orphan = self.version_root(id, version)?;
            fs::remove_dir_all(orphan).map_err(|e| e.to_string())?;
        }
        let stage = self.root.join("staging").join(format!("{id}-{version}"));
        if stage.exists() { fs::remove_dir_all(&stage).map_err(|e| e.to_string())?; }
        fs::create_dir(&stage).map_err(|e| e.to_string())?;
        let result = (|| {
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "invalid_archive")?;
            if zip.len() != release.manifest.files.len() + 2 { return Err("unexpected_archive_entries".into()); }
            let mut names = BTreeSet::new(); let mut total = 0u64;
            for i in 0..zip.len() {
                if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
                let mut file = zip.by_index(i).map_err(|_| "invalid_archive")?;
                let name = file.name().to_string(); safe_path(&name)?;
                if file.is_dir() || !names.insert(name.to_ascii_lowercase()) || file.unix_mode().is_some_and(|m| m & 0o170000 != 0 && m & 0o170000 != 0o100000) {
                    return Err("unsafe_archive_entry".into());
                }
                let limit = if name == "manifest.json" { MAX_METADATA as u64 } else if name == "manifest.minisig" { 4096 } else { MAX_PACKAGE };
                if name != "manifest.json" && name != "manifest.minisig" && !release.manifest.files.contains_key(&name) { return Err("undeclared_file".into()); }
                if file.size() > limit { return Err("archive_too_large".into()); }
                total = total.checked_add(file.size()).ok_or("archive_too_large")?;
                if total > MAX_EXPANDED { return Err("archive_too_large".into()); }
                let mut data = Vec::new();
                download(&mut file, &mut data, cancel, limit, |_| {})?;
                if let Some(checksum) = release.manifest.files.get(&name) {
                    if &hash(&data) != checksum { return Err("payload_checksum_mismatch".into()); }
                }
                let destination = stage.join(&name);
                fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
                let mut out = File::create(&destination).map_err(|e| e.to_string())?;
                out.write_all(&data).and_then(|_| out.sync_all()).map_err(|e| e.to_string())?;
            }
            let manifest_bytes = read_bounded(&stage.join("manifest.json"), MAX_METADATA as u64)?;
            let sig = String::from_utf8(read_bounded(&stage.join("manifest.minisig"), 4096)?).map_err(|e| e.to_string())?;
            verify_signature(&manifest_bytes, &sig, &self.key)?;
            let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|_| "invalid_manifest")?;
            if serde_json::to_value(&manifest).unwrap() != serde_json::to_value(&release.manifest).unwrap() { return Err("catalog_manifest_mismatch".into()); }
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(stage.join(&manifest.executable), fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?; }
            if cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
            let parent = self.root.join("versions").join(id);
            fs::create_dir_all(&parent).map_err(|e| e.to_string())?; no_symlinks(&self.root, &format!("versions/{id}"))?;
            let destination = parent.join(version);
            fs::rename(&stage, &destination).map_err(|e| e.to_string())?;
            if let Err(error) = self.transaction(|registry| {
                if let Some(installed) = registry.plugins.get_mut(id) {
                    if installed.pending.is_some() { return Err("pending_update_exists".into()); }
                    if running { installed.pending = Some(version.clone()); }
                    else { installed.previous = Some(installed.active.clone()); installed.active = version.clone(); }
                    installed.last_error = None;
                } else { registry.plugins.insert(id.clone(), Installed { active: version.clone(), enabled: true, ..Installed::default() }); }
                Ok(())
            }) { let _ = fs::remove_dir_all(destination); return Err(error); }
            self.prune(id);
            Ok(())
        })();
        if stage.exists() { let _ = fs::remove_dir_all(stage); }
        result
    }
    pub fn activate(&mut self, id: &str) -> Result<()> {
        let pending = self.registry.plugins.get(id).ok_or("not_installed")?.pending.clone();
        if let Some(version) = pending {
            if let Err(error) = self.verify(id, &version) {
                self.transaction(|registry| { let p = registry.plugins.get_mut(id).unwrap(); p.pending = None; p.last_error = Some(format!("update_rejected: {error}")); Ok(()) })?;
                self.prune(id);
                return Err(error);
            }
            self.transaction(|registry| { let p = registry.plugins.get_mut(id).unwrap(); p.previous = Some(p.active.clone()); p.active = version; p.pending = None; p.last_error = None; Ok(()) })?;
            self.prune(id);
        }
        Ok(())
    }
    pub fn rollback(&mut self, id: &str) -> Result<()> {
        let p = self.registry.plugins.get(id).ok_or("not_installed")?;
        if p.pending.is_some() { return Err("stop_to_activate_update_first".into()); }
        let version = p.previous.clone().ok_or("no_previous_version")?;
        self.verify(id, &version)?;
        self.transaction(|registry| { let p = registry.plugins.get_mut(id).unwrap(); p.previous = Some(p.active.clone()); p.active = version; Ok(()) })
    }
    pub fn enable(&mut self, id: &str, enabled: bool) -> Result<()> {
        self.transaction(|registry| { registry.plugins.get_mut(id).ok_or("not_installed")?.enabled = enabled; Ok(()) })
    }
    pub fn remove(&mut self, id: &str) -> Result<()> {
        valid_id(id)?;
        // Commit removal before deleting files: interrupted cleanup cannot restore an enabled plugin.
        self.transaction(|registry| { registry.plugins.remove(id).ok_or("not_installed")?; Ok(()) })?;
        let path = self.root.join("versions").join(id);
        if path.exists() { no_symlinks(&self.root, &format!("versions/{id}"))?; fs::remove_dir_all(path).map_err(|e| e.to_string())?; }
        Ok(())
    }
    fn prune(&self, id: &str) {
        let Some(p) = self.registry.plugins.get(id) else { return; };
        let Ok(root) = no_symlinks(&self.root, &format!("versions/{id}")) else { return; };
        let Ok(entries) = fs::read_dir(root) else { return; };
        for entry in entries.flatten() {
            let version = entry.file_name().to_string_lossy().into_owned();
            if version != p.active && p.previous.as_deref() != Some(&version) && p.pending.as_deref() != Some(&version) &&
                valid_version(&version).is_ok() && entry.file_type().is_ok_and(|t| t.is_dir()) { let _ = fs::remove_dir_all(entry.path()); }
        }
    }
}
fn inventory(root: &Path, relative: &str, files: &mut BTreeSet<String>, nodes: &mut usize) -> Result<()> {
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        *nodes += 1; if *nodes > 2048 { return Err("too_many_installed_files".into()); }
        let name = entry.file_name().into_string().map_err(|_| "unsafe_path")?;
        let name = if relative.is_empty() { name } else { format!("{relative}/{name}") };
        safe_path(&name)?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() { inventory(&entry.path(), &name, files, nodes)?; }
        else if kind.is_file() { files.insert(name); }
        else { return Err("unsafe_installed_file".into()); }
    }
    Ok(())
}
