use std::path::Path;
#[cfg(target_os = "windows")]
use std::path::PathBuf;

/// A Dota 2 install is only trusted once we can see its GSI config directory's
/// parent (`game/dota`) — the Steam library path alone isn't proof enough.
pub fn validate_dota_path(path: &str) -> bool {
    Path::new(path).join("game").join("dota").is_dir()
}

#[cfg(target_os = "windows")]
pub fn find_dota_auto() -> Option<String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let steam_path: Option<String> = hkcu
        .open_subkey("Software\\Valve\\Steam")
        .ok()
        .and_then(|key| key.get_value("SteamPath").ok());

    let mut libraries: Vec<PathBuf> = Vec::new();
    if let Some(ref sp) = steam_path {
        libraries.push(PathBuf::from(sp));
    }

    if let Some(sp) = &steam_path {
        let vdf_path = Path::new(sp).join("steamapps").join("libraryfolders.vdf");
        if let Ok(content) = std::fs::read_to_string(&vdf_path) {
            for extra in parse_library_paths(&content) {
                libraries.push(PathBuf::from(extra));
            }
        }
    }

    for library in libraries {
        let candidate = library.join("steamapps").join("common").join("dota 2 beta");
        if candidate.is_dir() && validate_dota_path(candidate.to_string_lossy().as_ref()) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
pub fn find_dota_auto() -> Option<String> {
    // Steam's library-folder layout used here is Windows-specific; on other
    // platforms we always fall back to the manual folder picker.
    None
}

/// Parses the `"path"  "C:\\some\\dir"` entries out of Steam's
/// `libraryfolders.vdf`. This is a tiny hand-rolled reader instead of a full
/// VDF parser crate, since it's the only field we need from that file.
#[cfg(target_os = "windows")]
fn parse_library_paths(content: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("\"path\"") {
            continue;
        }
        let fields: Vec<&str> = trimmed.split('"').filter(|s| !s.trim().is_empty()).collect();
        if fields.len() >= 2 {
            paths.push(fields[1].replace("\\\\", "\\"));
        }
    }
    paths
}
