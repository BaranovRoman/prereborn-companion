//! Player identity and widget options, edited only inside the plugin UI.
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FILE: &str = "settings.json";
pub const PLATFORMS: [&str; 4] = ["steam", "kakao", "psn", "xbox"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Widget {
    pub enabled: bool,
    /// Matches shown in OBS, 3–10.
    pub count: u8,
    /// Percent, 50–200.
    pub scale: u16,
    /// Background opacity in percent, 0 (transparent) – 100.
    pub background_opacity: u8,
    pub show_headers: bool,
}
impl Default for Widget {
    fn default() -> Self { Self { enabled: false, count: 5, scale: 100, background_opacity: 70, show_headers: true } }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub player: String,
    pub platform: String,
    pub widget: Widget,
}
impl Default for Settings {
    fn default() -> Self { Self { player: String::new(), platform: "steam".into(), widget: Widget::default() } }
}

/// PUBG nicknames: latin letters, digits, "_" and "-" (the backend applies
/// the same rule before any upstream call).
pub fn valid_player(name: &str) -> bool {
    (2..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !(self.player.is_empty() || valid_player(&self.player)) { return Err("invalid_player_name".into()); }
        if !PLATFORMS.contains(&self.platform.as_str()) { return Err("invalid_platform".into()); }
        let w = &self.widget;
        if !(3..=10).contains(&w.count) || !(50..=200).contains(&w.scale) || w.background_opacity > 100 {
            return Err("invalid_widget_settings".into());
        }
        Ok(())
    }
    pub fn configured(&self) -> bool { !self.player.is_empty() }
    /// History owner: switching player or platform starts a separate history.
    pub fn owner(&self) -> Option<String> {
        self.configured().then(|| format!("{}:{}", self.platform, self.player.to_ascii_lowercase()))
    }
    pub fn load(root: &Path) -> Result<Self, String> {
        let settings: Self = crate::files::read(root, FILE, 4096)?.unwrap_or_default();
        settings.validate()?;
        Ok(settings)
    }
    pub fn save(&self, root: &Path) -> Result<(), String> {
        self.validate()?;
        crate::files::write(root, FILE, self, 4096)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_valid_and_unconfigured() {
        let s = Settings::default();
        s.validate().unwrap();
        assert!(!s.configured());
        assert_eq!(s.owner(), None);
        assert!(!s.widget.enabled);
    }
    #[test]
    fn nicknames_platforms_and_widget_ranges_are_bounded() {
        for name in ["ab", "Pro_Player-1", &"x".repeat(32)] { assert!(valid_player(name), "{name}"); }
        for name in ["a", "../x", "a b", "имя", "a&filter=b", &"x".repeat(33)] { assert!(!valid_player(name), "{name}"); }
        let mut s = Settings { player: "ProPlayer".into(), ..Default::default() };
        s.validate().unwrap();
        assert_eq!(s.owner().as_deref(), Some("steam:proplayer"));
        s.platform = "stadia".into(); assert!(s.validate().is_err()); s.platform = "xbox".into();
        for (count, scale, opacity) in [(2, 100, 50), (11, 100, 50), (5, 49, 50), (5, 201, 50), (5, 100, 101)] {
            let mut bad = s.clone();
            bad.widget = Widget { count, scale, background_opacity: opacity, ..Widget::default() };
            assert!(bad.validate().is_err());
        }
    }
    #[test]
    fn settings_round_trip_through_the_data_directory_and_reject_unknown_fields() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(Settings::load(root.path()).unwrap(), Settings::default());
        let s = Settings { player: "ProPlayer".into(), platform: "psn".into(), widget: Widget { enabled: true, count: 3, scale: 150, background_opacity: 0, show_headers: false } };
        s.save(root.path()).unwrap();
        assert_eq!(Settings::load(root.path()).unwrap(), s);
        std::fs::write(root.path().join(FILE), br#"{"player":"x1","platform":"steam","widget":{},"apiKey":"no"}"#).unwrap();
        assert!(Settings::load(root.path()).is_err());
    }
}
